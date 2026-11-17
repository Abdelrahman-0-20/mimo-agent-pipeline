/**
 * Thinking-off-on-discovery policy (mimo-agent-pipeline v0.6).
 *
 * Pure and clock-injectable: classify every tool result as discovery (read /
 * grep / docs lookups) or work (everything else — edits, tests, debugging),
 * and decide when to flip the session's reasoning effort. Debounce rules:
 * `discoverySteps` consecutive discovery results are required before the
 * effort goes OFF, a minimum `minToggleGapMs` must elapse between OFF flips
 * (no thrash), while a single work result restores the effort immediately —
 * work always deserves reasoning. The caller captures the pre-toggle effort
 * and applies the select(); this class only decides.
 */

/** Exact tool names that are pure reads. */
const DISCOVERY_EXACT = new Set([
  'read',
  'grep',
  'working_directory',
  'mescal_status',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'mcp__memory__search_nodes',
  'mcp__memory__open_nodes',
  'mcp__memory__read_graph',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_find',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_network_request',
  'mcp__playwright__browser_network_requests',
  'mcp__playwright__browser_take_screenshot',
])

/** Tool-name prefixes that are pure reads (GitHub getters/listers/searchers, context7 docs). */
const DISCOVERY_PREFIXES = [
  'mcp__github__get_',
  'mcp__github__list_',
  'mcp__github__search_',
  'mcp__context7__',
]

/**
 * Classify one tool by name.
 * @param {string} name - the executed tool's name.
 * @returns {'discovery' | 'work'} unknown tools count as work (reasoning stays on).
 */
export function toolClass(name) {
  if (typeof name !== 'string') return 'work'
  if (DISCOVERY_EXACT.has(name)) return 'discovery'
  return DISCOVERY_PREFIXES.some(prefix => name.startsWith(prefix)) ? 'discovery' : 'work'
}

/**
 * Per-session effort toggle state with debounce.
 * The clock is injectable so tests are deterministic.
 */
export class EffortPolicy {
  #steps
  #gapMs
  #now
  /** @type {Map<string, { off: boolean, streak: number, lastOffAt: number, savedEffort: string | undefined }>} */
  #states = new Map()

  /**
   * @param {{ discoverySteps?: number, minToggleGapMs?: number, now?: () => number }} [options]
   */
  constructor({ discoverySteps = 3, minToggleGapMs = 15_000, now = Date.now } = {}) {
    if (!Number.isInteger(discoverySteps) || discoverySteps < 1) {
      throw new RangeError('discoverySteps must be an integer >= 1')
    }
    if (!Number.isInteger(minToggleGapMs) || minToggleGapMs < 0) {
      throw new RangeError('minToggleGapMs must be an integer >= 0')
    }
    this.#steps = discoverySteps
    this.#gapMs = minToggleGapMs
    this.#now = now
  }

  /**
   * Observe one executed tool for one session.
   * @param {string} sessionKey - stable session identity.
   * @param {string} toolName - the executed tool's name.
   * @param {string | undefined} currentEffort - the effort in effect before this observation (captured on OFF).
   * @returns {null | { action: 'off' } | { action: 'on', effort: string | undefined }}
   *   null = no change; 'off' = apply the discovery effort now; 'on' = restore the saved effort.
   */
  observe(sessionKey, toolName, currentEffort) {
    let state = this.#states.get(sessionKey)
    if (state === undefined) {
      state = { off: false, streak: 0, lastOffAt: Number.NEGATIVE_INFINITY, savedEffort: undefined }
      this.#states.set(sessionKey, state)
    }

    if (toolClass(toolName) === 'work') {
      state.streak = 0
      if (state.off) {
        state.off = false
        const effort = state.savedEffort
        state.savedEffort = undefined
        return { action: 'on', effort }
      }
      return null
    }

    state.streak += 1
    if (!state.off && state.streak >= this.#steps && this.#now() - state.lastOffAt >= this.#gapMs) {
      state.off = true
      state.lastOffAt = this.#now()
      state.savedEffort = currentEffort
      return { action: 'off' }
    }
    return null
  }

  /**
   * Forget a session's toggle state (used when the escalator changes the tier
   * or restores a selection, so a stale saved effort can never be reapplied).
   * @param {string} sessionKey - stable session identity.
   */
  reset(sessionKey) {
    this.#states.delete(sessionKey)
  }

  /**
   * Current toggle state for one session (diagnostics).
   * @param {string} sessionKey - stable session identity.
   * @returns {{ off: boolean, streak: number } | null}
   */
  stateOf(sessionKey) {
    const state = this.#states.get(sessionKey)
    return state === undefined ? null : { off: state.off, streak: state.streak }
  }
}
