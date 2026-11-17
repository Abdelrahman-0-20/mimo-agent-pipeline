/**
 * dsh-plugin-mimo-escalator — mimo-agent-pipeline v0.3.
 *
 * Watches verification rounds (test/lint/typecheck shell commands) and
 * escalates the session's model from the cheap base (Flash) to the strong
 * target (Pro) after `threshold` consecutive failed rounds, restoring the
 * original selection after `demoteThreshold` consecutive passes — the
 * roadmap's "Flash -> Pro after 2 failed test rounds", with hysteresis.
 *
 * Extension points, verified against the DSH source checkout:
 *  - `tools/result` observes frozen bash outcomes (`packages/core/tools`).
 *  - `agent.model.select()` durably switches the session's model
 *    (`packages/core/agent/src/model-selection.ts`); the session
 *    controller's model-switch notice tells the model what changed.
 *
 * Detection is intentionally conservative: only the command's FINAL segment
 * may be a verification run, so exit codes are never misattributed through
 * `;` or `|` masking (`npm test | tail` is ignored on purpose). A timeout
 * counts as a failure; aborts, sandbox denials, background jobs, signals,
 * and tool-level errors are ignored — they are not verification outcomes.
 */
import { EscalationState } from './state.js'

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
 * Classify one bash tool outcome as a verification round.
 * @param {{ name?: string, arguments?: unknown }} exec - the frozen tool execution.
 * @param {{ isError?: boolean, value?: unknown }} result - the frozen tool result.
 * @returns {'pass' | 'fail' | null} null when this call is not a countable round.
 */
export function roundOutcome(exec, result) {
  if (exec === null || typeof exec !== 'object' || exec.name !== 'bash') return null
  const args = exec.arguments
  if (args === null || typeof args !== 'object' || typeof args.command !== 'string') return null
  if (!isVerificationCommand(args.command)) return null
  if (result === null || typeof result !== 'object' || result.isError !== false) return null
  const value = result.value
  if (value === null || typeof value !== 'object' || value.kind !== 'foreground') return null
  if (value.aborted === true) return null
  if (value.sandbox !== undefined && value.sandbox !== null && value.sandbox.denied === true) return null
  if (value.timedOut === true) return 'fail'
  if (typeof value.exitCode === 'number') return value.exitCode === 0 ? 'pass' : 'fail'
  return null
}

/** Plugin defaults; the Config schema fills every omitted field with these. */
const DEFAULTS = {
  threshold: 2,
  demoteThreshold: 2,
  baseModel: 'mimo-v2.6-flash',
  model: 'mimo-v2.6-pro',
  reasoningEffort: 'high',
  provider: undefined,
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

      const known = new Set([...Object.keys(DEFAULTS), 'threshold', 'demoteThreshold'])
      for (const key of Object.keys(input)) {
        if (!known.has(key)) issues.push(issue(key, `unknown option "${key}"`))
      }

      return issues.length > 0 ? { issues } : { value }
    },
  },
}

/**
 * Mount the escalator: observe verification rounds for every agent and switch
 * the session's durable model selection at the hysteresis thresholds.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {ReturnType<typeof Config> extends { '~standard': infer S } ? unknown : never} config - validated row config.
 */
export function apply(ctx, config) {
  /** @type {Map<string, { state: EscalationState, original: Record<string, unknown> | null }>} */
  const sessions = new Map()

  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec.agent
      if (agent === undefined || agent === null) return
      const outcome = roundOutcome(exec, result)
      if (outcome === null) return
      const current = agent.model.current()
      if (current === undefined) return

      const key = agent.session.id
      let entry = sessions.get(key)
      if (entry === undefined) {
        entry = {
          state: new EscalationState({ threshold: config.threshold, demoteThreshold: config.demoteThreshold }),
          original: null,
        }
        sessions.set(key, entry)
      }

      // Count only while the session is on the base model, or on the target
      // this plugin escalated to — a manual /model choice is never overridden.
      const onBase = current.model === config.baseModel
      const onOurs = current.model === config.model && entry.state.escalated
      if (!onBase && !onOurs) return

      const { action } = entry.state.recordRound(outcome === 'fail')

      if (action === 'escalate') {
        entry.original = { ...current }
        agent.model.select({
          provider: config.provider ?? current.provider,
          model: config.model,
          ...(config.reasoningEffort !== null && config.reasoningEffort !== undefined
            ? { reasoningEffort: config.reasoningEffort }
            : {}),
        })
      } else if (action === 'demote' && entry.original !== null) {
        agent.model.select(entry.original)
        entry.original = null
      }
    } catch (error) {
      // An observer must never break tool-result notification.
      console.warn('[mimo-escalator] observation failed:', error)
    }
  })
}
