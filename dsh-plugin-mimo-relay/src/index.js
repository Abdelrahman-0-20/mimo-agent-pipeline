/**
 * dsh-plugin-mimo-relay — mimo-agent-pipeline v0.5.
 *
 * Exposes the `mimo_relay` tool: a three-phase Planner → Builder →
 * Verifier relay over the DSH `spawn` subagent backend. Each phase runs on
 * its role preset (the bundle's `preset-planner|scout|builder|verifier`
 * declarations supply persona and role-scoped MCP connectors), pinned to
 * the configured model tier, with the handoff contract captured through the
 * backend's `outputSchema` and validated in src/relay.js. The whole phase
 * lifetime holds its connector lock (reader/writer/browser per workspace).
 *
 * Extension points, verified against the DSH source checkout:
 *  - `subagents.startActivation` (`packages/subagent/subagent`) — managed
 *    child with `delivery: 'caller'`, `agentPreset`, `agentOptions`, and
 *    `outputSchema`; `activation.result` settles with `SubagentResult`
 *    (`output`, `structured`, `stopReason`, `diagnostic`).
 *  - Raw `ctx.tools.register` takes standard JSON Schema for `parameters`
 *    and `{schema, render}` for `output` (the per-property `required: true`
 *    idiom belongs to `defineTool`'s DSL only).
 */
import { LockRegistry } from './locks.js'
import { runRelay } from './relay.js'

/** Plugin defaults; the Config schema fills every omitted field with these. */
const DEFAULTS = {
  provider: undefined,
  plannerModel: 'mimo-v2.6-pro',
  workerModel: 'mimo-v2.6-flash',
  plannerReasoningEffort: 'high',
  workerReasoningEffort: null,
  timeoutMs: 1_920_000,
  phaseTimeoutMs: 600_000,
}

function issue(path, message) {
  return { path: [path], message }
}

function nonEmptyString(input, key, issues, value) {
  if (input[key] === undefined) return
  if (typeof input[key] !== 'string' || input[key].trim() === '') {
    issues.push(issue(key, `${key} must be a non-empty string`))
    return
  }
  value[key] = input[key]
}

function effortField(input, key, issues, value) {
  if (input[key] === undefined) return
  if (input[key] === null) {
    value[key] = null
  } else if (typeof input[key] === 'string' && input[key] !== '') {
    value[key] = input[key]
  } else {
    issues.push(issue(key, `${key} must be a non-empty string or null`))
  }
}

/**
 * Config schema as a synchronous Standard Schema (what the Cordis fiber
 * reads through `Config['~standard'].validate`). Hand-rolled: a
 * profile-linked bundle resolves imports from the checkout, so the plugin
 * stays zero-dependency everywhere.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'mimo-relay',
    validate(raw) {
      if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
        return { issues: [{ path: [], message: 'config must be an object' }] }
      }
      const input = raw ?? {}
      const issues = []
      const value = { ...DEFAULTS }

      nonEmptyString(input, 'plannerModel', issues, value)
      nonEmptyString(input, 'workerModel', issues, value)
      effortField(input, 'plannerReasoningEffort', issues, value)
      effortField(input, 'workerReasoningEffort', issues, value)

      if (input.provider !== undefined) {
        if (input.provider === null) {
          value.provider = undefined
        } else if (typeof input.provider === 'string' && input.provider !== '') {
          value.provider = input.provider
        } else {
          issues.push(issue('provider', 'provider must be a non-empty string'))
        }
      }

      if (input.timeoutMs !== undefined) {
        if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 60_000 || input.timeoutMs > 3_600_000) {
          issues.push(issue('timeoutMs', 'timeoutMs must be an integer between 60000 and 3600000'))
        } else {
          value.timeoutMs = input.timeoutMs
        }
      }

      if (input.phaseTimeoutMs !== undefined) {
        if (!Number.isInteger(input.phaseTimeoutMs) || input.phaseTimeoutMs < 30_000 || input.phaseTimeoutMs > 1_800_000) {
          issues.push(issue('phaseTimeoutMs', 'phaseTimeoutMs must be an integer between 30000 and 1800000'))
        } else {
          value.phaseTimeoutMs = input.phaseTimeoutMs
        }
      }

      const known = new Set(Object.keys(DEFAULTS))
      for (const key of Object.keys(input)) {
        if (!known.has(key)) issues.push(issue(key, `unknown option "${key}"`))
      }

      return issues.length > 0 ? { issues } : { value }
    },
  },
}

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'phase', 'reason', 'report'],
  properties: {
    ok: { type: 'boolean' },
    phase: { type: 'string' },
    reason: { type: 'string' },
    report: { type: 'object' },
  },
}

/**
 * Mount the relay tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {object} config - validated row config.
 */
export function apply(ctx, config) {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    console.warn('[mimo-relay] tools service unavailable; mimo_relay not registered')
    return
  }
  const subagents = ctx.get('subagents')
  const workingDirectory = ctx.get('workingDirectory')
  const locks = new LockRegistry()
  /** One relay at a time per process — this also stops recursive mimo_relay calls from children. */
  let activeRelay = false

  tools.register({
    name: 'mimo_relay',
    description:
      'Run the three-role engineering relay for a non-trivial task: planner (Pro, read-only, emits a file list + test plan), '
      + 'builder (implements the plan and must make every testPlan command exit 0), verifier (read-only, runs the plan and reports defects, never patches). '
      + 'Each phase holds the workspace connector lock (reader/writer/browser) for its whole run. Returns {ok, phase, reason, report}; use it when a task needs planning, implementation, and independent verification in sequence.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: 'One concise paragraph describing what the relay should accomplish.',
        },
      },
    },
    output: {
      schema: REPORT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      const fail = (phase, reason, report = {}) => ({ ok: false, phase, reason, report: { ...report, locks: locks.snapshot() } })
      const parent = exec.agent
      if (parent === undefined || parent === null) return fail('setup', 'no calling agent')
      if (subagents === undefined) return fail('setup', 'subagents service unavailable (spawn backend not mounted)')
      if (activeRelay) return fail('busy', 'another relay is already running in this process; retry when it finishes')

      let workspace
      try {
        workspace = workingDirectory === undefined ? undefined : workingDirectory.get(parent.session)
      } catch {
        workspace = undefined
      }

      const agentOptionsFor = (model, effort) => {
        const options = { model }
        const provider = config.provider ?? parent.model.current()?.provider
        if (provider !== undefined && provider !== null && provider !== '') options.provider = provider
        if (effort !== null && effort !== undefined) options.reasoningEffort = effort
        return options
      }

      const spawn = async ({ role, prompt, model, reasoningEffort, outputSchema, signal }) => {
        const activation = await subagents.startActivation({
          provider: 'spawn',
          label: `relay-${role}`,
          parent,
          prompt: [{ type: 'text', text: prompt }],
          signal,
          delivery: 'caller',
          agentPreset: role,
          agentOptions: agentOptionsFor(model, reasoningEffort),
          outputSchema,
          ...(workspace === undefined || workspace === '' ? {} : { cwd: workspace }),
        })
        // Race the child against the phase signal: a hung child can never
        // outlive its phase, and an aborted phase disposes its child.
        return new Promise((resolve, reject) => {
          let settled = false
          const onAbort = () => {
            if (settled) return
            settled = true
            if (signal !== undefined) signal.removeEventListener('abort', onAbort)
            activation.dispose().catch(() => {}).then(() => {
              reject(signal?.reason ?? new Error('aborted'))
            })
          }
          if (signal?.aborted === true) {
            onAbort()
            return
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          activation.result.then(
            (result) => {
              if (settled) return
              settled = true
              if (signal !== undefined) signal.removeEventListener('abort', onAbort)
              resolve(result)
            },
            (error) => {
              if (settled) return
              settled = true
              if (signal !== undefined) signal.removeEventListener('abort', onAbort)
              reject(error)
            },
          )
        })
      }

      activeRelay = true
      try {
        const report = await runRelay({
          task: args.task,
          workspace: workspace === undefined || workspace === '' ? 'workspace' : workspace,
          locks,
          spawn,
          plannerModel: config.plannerModel,
          workerModel: config.workerModel,
          plannerReasoningEffort: config.plannerReasoningEffort,
          workerReasoningEffort: config.workerReasoningEffort,
          phaseTimeoutMs: config.phaseTimeoutMs,
          signal: exec.signal,
          log: (message) => console.info(`[mimo-relay] ${message}`),
        })
        // Top level stays exactly {ok, phase, reason, report} per the output
        // schema; the full phase details live inside report.
        return {
          ok: report.ok,
          phase: report.phase,
          reason: report.reason,
          report: { ...report, locks: locks.snapshot() },
        }
      } finally {
        activeRelay = false
      }
    },
  })
}
