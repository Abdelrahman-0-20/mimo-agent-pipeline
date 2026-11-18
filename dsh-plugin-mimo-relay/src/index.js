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

/**
 * Activate only after the tools service exists. Without this edge, a cold
 * boot can start this fiber in parallel with dsh-base's `tools` row: apply()
 * then sees `ctx.get('tools') === undefined`, early-returns, and the fiber
 * reports `active` with no tool registered (observed after a host restart).
 */
export const inject = ['tools']

/** Plugin defaults; the Config schema fills every omitted field with these. */
const DEFAULTS = {
  provider: undefined,
  plannerModel: 'mimo-v2.6-pro',
  workerModel: 'mimo-v2.6-flash',
  plannerReasoningEffort: 'high',
  workerReasoningEffort: null,
  timeoutMs: 1_920_000,
  phaseTimeoutMs: 600_000,
  phaseRetries: 1,
  // v0.6 token cut: hide irrelevant globals from relay children at
  // agent/created (deny lists in ROLE_TOOL_DENY / COMMON_TOOL_DENY).
  toolScoping: true,
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

      if (input.phaseRetries !== undefined) {
        if (!Number.isInteger(input.phaseRetries) || input.phaseRetries < 0 || input.phaseRetries > 3) {
          issues.push(issue('phaseRetries', 'phaseRetries must be an integer between0 and3'))
        } else {
          value.phaseRetries = input.phaseRetries
        }
      }

      if (input.toolScoping !== undefined) {
        if (typeof input.toolScoping !== 'boolean') {
          issues.push(issue('toolScoping', 'toolScoping must be a boolean'))
        } else {
          value.toolScoping = input.toolScoping
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

/** Globals no relay child ever needs (all verified present in live child headers). */
export const COMMON_TOOL_DENY = [
  'get_expert_team', 'list_expert_teams', 'list_experts',
  'summon_expert', 'summon_experts', 'summon_expert_team',
  'propose_custom_expert', 'open_custom_expert_editor',
  'propose_expert_team', 'open_expert_team_editor',
  'mescal_status', 'mimo_relay',
  'list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource',
  'subagent_claude_code', 'subagent_codex',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
]

const GITHUB_TOOLS = [
  'add_issue_comment', 'create_branch', 'create_issue', 'create_or_update_file',
  'create_pull_request', 'create_pull_request_review', 'create_repository', 'fork_repository',
  'get_file_contents', 'get_issue', 'get_pull_request', 'get_pull_request_comments',
  'get_pull_request_files', 'get_pull_request_reviews', 'get_pull_request_status',
  'list_commits', 'list_issues', 'list_pull_requests', 'merge_pull_request', 'push_files',
  'search_code', 'search_issues', 'search_repositories', 'search_users',
  'update_issue', 'update_pull_request_branch',
]

const MEMORY_TOOLS = [
  'add_observations', 'create_entities', 'create_relations', 'delete_entities',
  'delete_observations', 'delete_relations', 'open_nodes', 'read_graph', 'search_nodes',
]

const PLAYWRIGHT_TOOLS = [
  'browser_click', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_drop',
  'browser_emulate_media', 'browser_evaluate', 'browser_file_upload', 'browser_fill_form',
  'browser_find', 'browser_handle_dialog', 'browser_hover', 'browser_navigate',
  'browser_navigate_back', 'browser_network_request', 'browser_network_requests',
  'browser_press_key', 'browser_resize', 'browser_run_code_unsafe', 'browser_select_option',
  'browser_snapshot', 'browser_tabs', 'browser_take_screenshot', 'browser_type', 'browser_wait_for',
]

const mcpNames = (server, tools) => tools.map(name => `mcp__${server}__${name}`)

/**
 * Host MCP servers each role does NOT preset-mount. Denying only these can
 * never collide with a role's own scoped connectors (same server name, same
 * tool names — the preset's copy would be masked too), which is why the
 * lists are per role rather than global.
 */
export const ROLE_TOOL_DENY = {
  planner: mcpNames('playwright', PLAYWRIGHT_TOOLS),
  scout: [
    ...mcpNames('github', GITHUB_TOOLS),
    ...mcpNames('memory', MEMORY_TOOLS),
    ...mcpNames('playwright', PLAYWRIGHT_TOOLS),
  ],
  builder: [
    ...mcpNames('github', GITHUB_TOOLS),
    ...mcpNames('memory', MEMORY_TOOLS),
    ...mcpNames('playwright', PLAYWRIGHT_TOOLS),
  ],
  verifier: [
    ...mcpNames('github', GITHUB_TOOLS),
    ...mcpNames('memory', MEMORY_TOOLS),
  ],
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
  const locks = new LockRegistry()
  /** One relay at a time per process — this also stops recursive mimo_relay calls from children. */
  let activeRelay = false

  // v0.6 connector-pack token cut: a relay child keeps only what its role
  // needs. `restrict({deny})` masks GLOBAL and inherited names by exact
  // name — so each role denies only the host MCP servers it does NOT
  // preset-mount (no name can collide with its own scoped connectors) plus
  // the always-irrelevant noise (experts, teams, subagents, scheduling…).
  // The role's preset tools (bash/fs/search, own MCP) live in the preset
  // layer and are never named, so they survive; structured_output is
  // child-local and survives as well. Runs at agent/created — serial,
  // awaited, before the first prompt — so the slim schema applies from
  // step one. Fail-open: a name unknown on this DSH build logs a warning
  // and leaves the child unsliced rather than breaking agent creation.
  const RELAY_ROLES = new Set(['planner', 'scout', 'builder', 'verifier'])
  ctx.on('agent/created', async ({ agent }) => {
    try {
      if (config.toolScoping !== true) return
      const presets = ctx.get('agentPresets')
      const preset = presets === undefined ? undefined : presets.presetForSession(agent.session)
      if (preset === undefined || preset === null || !RELAY_ROLES.has(preset)) return
      const agentTools = agent.ctx.get('tools')
      if (agentTools === undefined) return
      const deny = [...COMMON_TOOL_DENY, ...ROLE_TOOL_DENY[preset]]
      agentTools.restrict({ deny })
      console.info(`[mimo-relay] scoped ${preset} child: hid ${deny.length} irrelevant global tool schemas`)
    } catch (error) {
      console.warn('[mimo-relay] tool scoping failed (child left unsliced):', error)
    }
  })

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
      // Resolved at call time, never captured at apply: a cold-boot fiber can
      // start before these providers exist (the inject edge only orders tools).
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return fail('setup', 'subagents service unavailable (spawn backend not mounted)')
      if (activeRelay) return fail('busy', 'another relay is already running in this process; retry when it finishes')
      const workingDirectory = ctx.get('workingDirectory')

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
          phaseRetries: config.phaseRetries,
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
