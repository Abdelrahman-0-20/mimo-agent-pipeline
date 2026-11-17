/**
 * dsh-plugin-mimo-escalator — mimo-agent-pipeline v0.4.
 *
 * Watches verification rounds — local bash test/lint/typecheck commands and,
 * when `ciDetection` is on, GitHub CI status queries through the github MCP
 * server — and escalates the session's model from the cheap base (Flash) to
 * the strong target (Pro) after `threshold` consecutive failed rounds,
 * restoring the original selection after `demoteThreshold` consecutive
 * passes: the roadmap's "Flash -> Pro after 2 failed test rounds", with
 * hysteresis.
 *
 * v0.4 adds durability and metrics: every counted round is persisted to
 * `statePath` (default `mimo-escalator-state.json`, one file per workspace —
 * the repo gitignores it), carrying the hysteresis snapshot, the selection to
 * restore on demotion, round counters, escalation counters, and a capped
 * transition history. Entries older than `stateTtlHours` are pruned on load;
 * a missing or corrupt file simply starts a fresh cycle.
 *
 * Extension points, verified against the DSH source checkout:
 *  - `tools/result` observes frozen tool outcomes (`packages/core/tools`);
 *    bash foreground results carry the exit code, MCP results carry the
 *    canonical `McpResult` value.
 *  - `agent.model.select()` durably switches the session's model
 *    (`packages/core/agent/src/model-selection.ts`); the session
 *    controller's model-switch notice tells the model what changed.
 *
 * Detection is intentionally conservative: only the command's FINAL segment
 * may be a verification run, so exit codes are never misattributed through
 * `;` or `|` masking (`npm test | tail` is ignored on purpose). A timeout
 * counts as a failure; aborts, sandbox denials, background jobs, signals,
 * and tool-level errors are ignored — they are not verification outcomes.
 * CI status is counted only for explicit success/failure states; pending or
 * unrecognized payloads are ignored.
 */
import { basename, isAbsolute, join } from 'node:path'
import { EscalationState } from './state.js'
import { applySnapshot, countRound, entryFor, loadStore, recordTransition, saveStore } from './store.js'

/** Leading shell noise stripped before matching: assignments, env/command/time, npx flags. */
const LEADING_WRAPPERS = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|env\s+|command\s+|time\s+|npx\s+(?:--?[A-Za-z][\w-]*\s+)*)+/

/** Verification invocations: test suites, linters, typecheckers, and this repo's gate. */
const VERIFY_PATTERNS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|type-check|check)\b/,
  /^node(?:js)?\s+--test\b/,
  /^(?:vitest|jest|mocha|ava|tap|pytest|phpunit|rspec)\b/,
  /^python3?\s+-m\s+(?:pytest|unittest)\b/,
  /^go\s+test\b/,
  /^cargo\s+(?:test|check)\b/,
  /^(?:\S*\/)?(?:eslint|prettier|tsc|ruff|flake8|mypy|shellcheck)\b/,
  /^(?:\.\/)?verify(?:\.sh)?\b/,
  /^git\s+diff\s+--check\b/,
]

/** MCP tools whose result is an explicit GitHub CI verdict for a pull request. */
const CI_STATUS_TOOLS = new Set(['mcp__github__get_pull_request_status'])

/**
 * Whether the command's final action is a verification run.
 * Only the last `&&`/`||`/`;`/`|` segment counts, because that segment owns
 * the exit code the caller observes.
 * @param {unknown} command - the bash tool's `command` argument.
 * @returns {boolean}
 */
export function isVerificationCommand(command) {
  if (typeof command !== 'string') return false
  const segments = command.split(/&&|\|\||;|\|/)
  const last = segments[segments.length - 1].replace(LEADING_WRAPPERS, '').trim()
  return VERIFY_PATTERNS.some(pattern => pattern.test(last))
}

/**
 * Pull the GitHub status payload out of a canonical MCP value: a direct
 * `state` field, `structuredContent`, or a JSON text block.
 * @param {unknown} value - the tool result's `value`.
 * @returns {Record<string, unknown> | null}
 */
function ciPayload(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.state === 'string') return value
  if (value.structuredContent !== null && typeof value.structuredContent === 'object') {
    return value.structuredContent
  }
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        try {
          const parsed = JSON.parse(block.text)
          if (parsed !== null && typeof parsed === 'object') return parsed
        } catch {
          // not JSON — keep scanning remaining blocks
        }
      }
    }
  }
  return null
}

/**
 * Classify one tool outcome as a verification round, reporting why a call
 * was not countable when it was not.
 * @param {{ name?: string, arguments?: unknown } | null} exec - the frozen tool execution.
 * @param {{ isError?: boolean, value?: unknown } | null} result - the frozen tool result.
 * @param {{ ciDetection?: boolean }} [options] - detection toggles from Config.
 * @returns {{ outcome: 'pass' | 'fail' | null, skip: string | null }}
 */
export function classifyRound(exec, result, options = {}) {
  if (exec === null || typeof exec !== 'object') return { outcome: null, skip: 'no-exec' }
  const name = exec.name
  if (typeof name !== 'string') return { outcome: null, skip: 'no-tool-name' }
  if (name.startsWith('mcp__')) {
    if (options.ciDetection === false) return { outcome: null, skip: 'ci-detection-off' }
    if (!CI_STATUS_TOOLS.has(name)) return { outcome: null, skip: 'not-a-ci-status-tool' }
    if (result === null || typeof result !== 'object') return { outcome: null, skip: 'no-result' }
    if (result.isError !== false) return { outcome: null, skip: 'tool-error' }
    const payload = ciPayload(result.value)
    if (payload === null) return { outcome: null, skip: 'no-ci-payload' }
    if (payload.state === 'success') return { outcome: 'pass', skip: null }
    if (payload.state === 'failure' || payload.state === 'error') return { outcome: 'fail', skip: null }
    return { outcome: null, skip: `ci-state-${String(payload.state ?? 'unknown')}` }
  }
  if (name !== 'bash') return { outcome: null, skip: 'not-bash' }
  const args = exec.arguments
  if (args === null || typeof args !== 'object' || typeof args.command !== 'string') {
    return { outcome: null, skip: 'no-command' }
  }
  if (!isVerificationCommand(args.command)) return { outcome: null, skip: 'not-verification' }
  if (result === null || typeof result !== 'object') return { outcome: null, skip: 'no-result' }
  if (result.isError !== false) return { outcome: null, skip: 'tool-error' }
  const value = result.value
  if (value === null || typeof value !== 'object') return { outcome: null, skip: 'no-value' }
  if (value.kind !== 'foreground') return { outcome: null, skip: `kind-${String(value.kind ?? 'unknown')}` }
  if (value.aborted === true) return { outcome: null, skip: 'aborted' }
  if (value.sandbox !== undefined && value.sandbox !== null && value.sandbox.denied === true) {
    return { outcome: null, skip: 'sandbox-denied' }
  }
  if (value.timedOut === true) return { outcome: 'fail', skip: null }
  if (typeof value.exitCode === 'number') {
    return { outcome: value.exitCode === 0 ? 'pass' : 'fail', skip: null }
  }
  return { outcome: null, skip: `no-exit-code${value.signal ? `-signal-${value.signal}` : ''}` }
}

/**
 * Classify one tool outcome as a verification round.
 * @param {{ name?: string, arguments?: unknown } | null} exec - the frozen tool execution.
 * @param {{ isError?: boolean, value?: unknown } | null} result - the frozen tool result.
 * @param {{ ciDetection?: boolean }} [options] - detection toggles from Config.
 * @returns {'pass' | 'fail' | null} null when this call is not a countable round.
 */
export function roundOutcome(exec, result, options = {}) {
  return classifyRound(exec, result, options).outcome
}

/**
 * Durable state key for one escalation domain: `<workspace>:<role>` (e.g.
 * `repo:builder`), so a builder's strikes never escalate the planner and
 * every session of one role within one workspace shares the cycle.
 * @param {string | undefined} workspaceDir - the session's working directory.
 * @param {string} role - agent preset id, or `main` for default sessions.
 * @returns {string}
 */
export function stateKeyFor(workspaceDir, role) {
  const ws = typeof workspaceDir === 'string' && workspaceDir !== '' ? basename(workspaceDir) : 'workspace'
  return `${ws}:${role}`
}

/** Plugin defaults; the Config schema fills every omitted field with these. */
const DEFAULTS = {
  threshold: 2,
  demoteThreshold: 2,
  baseModel: 'mimo-v2.6-flash',
  model: 'mimo-v2.6-pro',
  reasoningEffort: 'high',
  provider: undefined,
  statePath: 'mimo-escalator-state.json',
  stateTtlHours: 72,
  ciDetection: true,
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

/**
 * Config schema as a synchronous Standard Schema (what the Cordis fiber
 * reads through `Config['~standard'].validate`). Hand-rolled on purpose:
 * a profile-linked bundle resolves its imports from the checkout, so a
 * zero-dependency schema is the only one guaranteed to load everywhere.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'mimo-escalator',
    validate(raw) {
      if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
        return { issues: [{ path: [], message: 'config must be an object' }] }
      }
      const input = raw ?? {}
      const issues = []
      const value = { ...DEFAULTS }

      for (const key of ['threshold', 'demoteThreshold']) {
        if (input[key] === undefined) continue
        if (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > 100) {
          issues.push(issue(key, `${key} must be an integer between 1 and 100`))
        } else {
          value[key] = input[key]
        }
      }

      nonEmptyString(input, 'baseModel', issues, value)
      nonEmptyString(input, 'model', issues, value)
      if (value.model === value.baseModel) {
        issues.push(issue('model', 'model must differ from baseModel'))
      }

      if (input.reasoningEffort !== undefined) {
        if (input.reasoningEffort === null) {
          value.reasoningEffort = null
        } else if (typeof input.reasoningEffort === 'string' && input.reasoningEffort !== '') {
          value.reasoningEffort = input.reasoningEffort
        } else {
          issues.push(issue('reasoningEffort', 'reasoningEffort must be a non-empty string or null'))
        }
      }

      if (input.provider !== undefined) {
        if (input.provider === null) {
          value.provider = undefined
        } else if (typeof input.provider === 'string' && input.provider !== '') {
          value.provider = input.provider
        } else {
          issues.push(issue('provider', 'provider must be a non-empty string'))
        }
      }

      if (input.statePath !== undefined) {
        if (typeof input.statePath !== 'string') {
          issues.push(issue('statePath', 'statePath must be a string (empty disables persistence)'))
        } else {
          value.statePath = input.statePath
        }
      }

      if (input.stateTtlHours !== undefined) {
        if (!Number.isInteger(input.stateTtlHours) || input.stateTtlHours < 0 || input.stateTtlHours > 87_600) {
          issues.push(issue('stateTtlHours', 'stateTtlHours must be an integer between 0 and 87600 (0 keeps entries forever)'))
        } else {
          value.stateTtlHours = input.stateTtlHours
        }
      }

      if (input.ciDetection !== undefined) {
        if (typeof input.ciDetection !== 'boolean') {
          issues.push(issue('ciDetection', 'ciDetection must be a boolean'))
        } else {
          value.ciDetection = input.ciDetection
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

/**
 * Mount the escalator: observe verification rounds for every agent, switch
 * the session's durable model selection at the hysteresis thresholds, and
 * persist state plus metrics to `statePath`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {object} config - validated row config.
 */
export function apply(ctx, config) {
  /** @type {Map<string, { state: EscalationState, original: object | null }>} */
  const sessions = new Map()
  /** @type {Map<string, { store: object }>} */
  const stores = new Map()
  let warnedPersistence = false

  const warnPersistence = (reason) => {
    if (warnedPersistence || config.statePath === '') return
    warnedPersistence = true
    console.warn(`[mimo-escalator] persistence disabled (${reason}); running in-memory only`)
  }

  /** The session's working directory, or undefined when it cannot be resolved. */
  const dirFor = (agent) => {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory === undefined) return undefined
    try {
      const dir = workingDirectory.get(agent.session)
      return typeof dir === 'string' && dir !== '' ? dir : undefined
    } catch {
      return undefined
    }
  }

  /** Absolute store path for this workspace, or undefined when persistence is off. */
  const storePathFor = (dir) => {
    if (typeof config.statePath !== 'string' || config.statePath === '') return undefined
    if (isAbsolute(config.statePath)) return config.statePath
    if (dir === undefined) {
      warnPersistence('session has no working directory')
      return undefined
    }
    return join(dir, config.statePath)
  }

  /** The agent's role: its preset id, or `main` for default sessions. */
  const roleFor = (agent) => {
    const presets = ctx.get('agentPresets')
    try {
      return presets?.presetForSession?.(agent.session) ?? 'main'
    } catch {
      return 'main'
    }
  }

  /** Load (once per path, TTL-pruned) the shared store file. */
  const slotFor = (path) => {
    let slot = stores.get(path)
    if (slot === undefined) {
      slot = { store: loadStore(path, { ttlMs: config.stateTtlHours * 3_600_000 }) }
      stores.set(path, slot)
    }
    return slot
  }

  const registerStatusTool = () => {
    const tools = ctx.get('tools')
    if (tools === undefined) {
      warnPersistence('tools service unavailable; mescal_status not registered')
      return
    }
    tools.register({
      name: 'mescal_status',
      description: 'Report the MiMo escalator state, persisted metrics, and store diagnostics for this session. Read-only.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionId', 'stateKey', 'role', 'model', 'state', 'metrics', 'storePath', 'persistence', 'diagnostics'],
          properties: {
            sessionId: { type: 'string' },
            stateKey: { type: 'string' },
            role: { type: 'string' },
            model: { oneOf: [{ type: 'object' }, { type: 'null' }] },
            state: { oneOf: [{ type: 'object' }, { type: 'null' }] },
            metrics: { oneOf: [{ type: 'object' }, { type: 'null' }] },
            storePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            persistence: { type: 'string' },
            diagnostics: { type: 'object' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(_args, exec) {
        const agent = exec.agent
        if (agent === undefined || agent === null) {
          return { sessionId: '', stateKey: '', role: '', model: null, state: null, metrics: null, storePath: null, persistence: 'no-agent', diagnostics: { ...diagnostics } }
        }
        const dir = dirFor(agent)
        const role = roleFor(agent)
        const key = stateKeyFor(dir, role)
        const path = storePathFor(dir)
        const mem = sessions.get(key)
        let metrics = null
        if (path !== undefined) {
          try {
            const entry = slotFor(path).store.sessions[key]
            if (entry !== undefined) {
              metrics = {
                rounds: entry.rounds,
                escalations: entry.escalations ?? 0,
                demotions: entry.demotions ?? 0,
                firstSeen: entry.firstSeen ?? null,
                updatedAt: entry.updatedAt ?? null,
                history: entry.history ?? [],
              }
            }
          } catch {
            // fall through with metrics null
          }
        }
        return {
          sessionId: agent.session.id,
          stateKey: key,
          role,
          model: agent.model.current() ?? null,
          state: mem?.state.snapshot() ?? null,
          metrics,
          storePath: path,
          persistence: config.statePath === '' ? 'disabled-by-config' : path === undefined ? 'unavailable' : 'active',
          diagnostics: { ...diagnostics },
        }
      },
    })
  }
  registerStatusTool()

  /** Why the most recent tool result was not counted (or that it was). */
  const diagnostics = { lastSkip: null, lastCounted: null }
  const noteSkip = (reason, exec) => {
    diagnostics.lastSkip = {
      reason,
      tool: exec !== null && typeof exec === 'object' ? exec.name ?? null : null,
      at: new Date().toISOString(),
    }
  }

  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec.agent
      if (agent === undefined || agent === null) {
        noteSkip('no-agent', exec)
        return
      }
      const { outcome, skip } = classifyRound(exec, result, { ciDetection: config.ciDetection })
      if (outcome === null) {
        noteSkip(skip, exec)
        return
      }
      const current = agent.model.current()
      if (current === undefined) {
        noteSkip('no-current-model', exec)
        return
      }
      diagnostics.lastCounted = {
        outcome,
        tool: exec.name,
        at: new Date().toISOString(),
      }

      const now = Date.now()
      const dir = dirFor(agent)
      const role = roleFor(agent)
      const key = stateKeyFor(dir, role)
      const path = storePathFor(dir)

      // Hydrate once per role domain: rebuild the hysteresis state and the
      // selection to restore from the persisted entry, when there is one.
      let mem = sessions.get(key)
      if (mem === undefined) {
        let initial
        let original = null
        if (path !== undefined) {
          try {
            const entry = entryFor(slotFor(path).store, key, now)
            initial = { strikes: entry.strikes, passes: entry.passes, escalated: entry.escalated }
            original = entry.original !== null && typeof entry.original === 'object' ? entry.original : null
          } catch (error) {
            warnPersistence(`state load failed: ${error?.message ?? error}`)
          }
        }
        mem = {
          state: new EscalationState({
            threshold: config.threshold,
            demoteThreshold: config.demoteThreshold,
            ...(initial === undefined ? {} : { initial }),
          }),
          original,
        }
        sessions.set(key, mem)
      }

      // Count only while the session is on the base model, or on the target
      // this plugin escalated to — a manual /model choice is never overridden.
      const onBase = current.model === config.baseModel
      const onOurs = current.model === config.model && mem.state.escalated

      // Role-stale session: the role already demoted but this session is
      // still parked on the target — send it back without counting a round.
      if (!onBase && !onOurs && current.model === config.model && !mem.state.escalated && mem.original !== null) {
        agent.model.select(mem.original)
        console.info(`[mimo-escalator] adopt-demotion ${key}: ${current.model} -> ${mem.original.model}`)
        return
      }
      if (!onBase && !onOurs) return

      const { action } = mem.state.recordRound(outcome === 'fail')

      let transition = null
      if (action === 'escalate') {
        mem.original = { ...current }
        transition = { from: current.model, to: config.model }
      } else if (action === 'demote') {
        const target = mem.original ?? { provider: current.provider, model: config.baseModel }
        mem.original = null
        transition = { from: current.model, to: target.model }
        mem.restored = target
      }

      // Persist snapshot + metrics before acting, so a failed switch never
      // loses the round that was already observed.
      let entry
      if (path !== undefined) {
        try {
          const slot = slotFor(path)
          entry = entryFor(slot.store, key, now)
          applySnapshot(entry, mem.state.snapshot(), now)
          countRound(entry, outcome, now)
          if (action === 'escalate') {
            entry.original = { ...mem.original }
            recordTransition(entry, 'escalate', transition.from, transition.to, now)
          } else if (action === 'demote') {
            entry.original = null
            recordTransition(entry, 'demote', transition.from, transition.to, now)
          }
          saveStore(path, slot.store)
        } catch (error) {
          entry = undefined
          console.warn('[mimo-escalator] state persistence failed:', error)
        }
      }

      if (action === 'escalate') {
        agent.model.select({
          provider: config.provider ?? current.provider,
          model: config.model,
          ...(config.reasoningEffort !== null && config.reasoningEffort !== undefined
            ? { reasoningEffort: config.reasoningEffort }
            : {}),
        })
        const rounds = entry === undefined ? '' : `, rounds: fail=${entry.rounds.fail} pass=${entry.rounds.pass} escalation#${entry.escalations}`
        console.info(`[mimo-escalator] escalate ${key}: ${transition.from} -> ${transition.to}${rounds}`)
      } else if (action === 'demote') {
        agent.model.select(mem.restored)
        mem.restored = null
        const rounds = entry === undefined ? '' : `, rounds: fail=${entry.rounds.fail} pass=${entry.rounds.pass} demotion#${entry.demotions}`
        console.info(`[mimo-escalator] demote ${key}: ${transition.from} -> ${transition.to}${rounds}`)
      } else if (onBase && mem.state.escalated) {
        // Role-level escalation: the role is escalated but this session of
        // the same role is still on the base model — switch it too.
        agent.model.select({
          provider: config.provider ?? current.provider,
          model: config.model,
          ...(config.reasoningEffort !== null && config.reasoningEffort !== undefined
            ? { reasoningEffort: config.reasoningEffort }
            : {}),
        })
        console.info(`[mimo-escalator] adopt-escalation ${key}: ${current.model} -> ${config.model}`)
      }
    } catch (error) {
      // An observer must never break tool-result notification.
      console.warn('[mimo-escalator] observation failed:', error)
    }
  })
}
