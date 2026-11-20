/**
 * Proactive reasoning-effort boost policy (dsh-plugin-mimo-think).
 *
 * Pure and clock-injectable, like the escalator's EffortPolicy. Observe two
 * event kinds per session:
 *   - { kind: 'inbox', text, current }    a fresh user message (scored);
 *   - { kind: 'tool', toolClass, current } a completed tool result (re-assert only).
 * Decide when to raise the session's reasoning effort to boostEffort and when
 * to restore the effort that was in effect before the boost.
 *
 * Hysteresis: score >= boostThreshold boosts, score <= releaseThreshold
 * releases, and a release additionally requires boostTtlMs to have elapsed
 * since the last hard message — a mid-band score changes nothing. A boost
 * never downgrades an unknown or higher effort level, work results re-assert
 * an active boost that something lowered underneath (the escalator's
 * discovery-off policy), and a release only touches a selection that is still
 * the one the boost created — manual /model or escalator changes are never
 * stomped.
 */
import { scorePrompt } from './score.js'

/** Known DSH reasoning-effort levels, weakest first. */
export const EFFORT_RANK = Object.freeze({ off: 0, low: 1, medium: 2, high: 3, xhigh: 4 })

/**
 * Rank one effort value.
 * undefined/null/'' means adapter default (rank -1, below every explicit
 * level); an unknown non-empty level ranks above every known level so an
 * unfamiliar provider value is never silently downgraded.
 * @param {unknown} effort - a reasoning-effort value.
 * @returns {number}
 */
export function effortRank(effort) {
  if (effort === undefined || effort === null || effort === '') return -1
  if (typeof effort !== 'string') return Number.POSITIVE_INFINITY
  return Object.hasOwn(EFFORT_RANK, effort) ? EFFORT_RANK[effort] : Number.POSITIVE_INFINITY
}

/** Per-session policy state (created on first observation). */
function freshState() {
  return {
    active: false,
    score: 0,
    savedEffort: undefined,
    savedModel: undefined,
    lastHighAt: Number.NEGATIVE_INFINITY,
  }
}

/**
 * Decide effort transitions for one session.
 * The clock is injectable so tests are deterministic.
 */
export class BoostPolicy {
  #effort
  #boostAt
  #releaseAt
  #ttlMs
  #now
  #states = new Map()

  /**
   * @param {{ boostEffort?: string, boostThreshold?: number, releaseThreshold?: number, boostTtlMs?: number, now?: () => number }} [options]
   */
  constructor({ boostEffort = 'high', boostThreshold = 4, releaseThreshold = 1, boostTtlMs = 1_800_000, now = Date.now } = {}) {
    if (typeof boostEffort !== 'string' || boostEffort === '') {
      throw new TypeError('boostEffort must be a non-empty string')
    }
    if (!Number.isInteger(boostThreshold) || boostThreshold < 1) {
      throw new RangeError('boostThreshold must be an integer >= 1')
    }
    if (!Number.isInteger(releaseThreshold) || releaseThreshold < 0) {
      throw new RangeError('releaseThreshold must be an integer >= 0')
    }
    if (releaseThreshold >= boostThreshold) {
      throw new RangeError('releaseThreshold must be < boostThreshold (hysteresis)')
    }
    if (!Number.isInteger(boostTtlMs) || boostTtlMs < 0) {
      throw new RangeError('boostTtlMs must be an integer >= 0')
    }
    this.#effort = boostEffort
    this.#boostAt = boostThreshold
    this.#releaseAt = releaseThreshold
    this.#ttlMs = boostTtlMs
    this.#now = now
  }

  #stateOf(sessionKey) {
    let state = this.#states.get(sessionKey)
    if (state === undefined) {
      state = freshState()
      this.#states.set(sessionKey, state)
    }
    return state
  }

  /**
   * Observe one event for one session.
   * @param {string} sessionKey - stable session identity.
   * @param {{ kind: 'inbox', text: unknown, current?: object } | { kind: 'tool', toolClass?: string, current?: object }} event
   * @returns {null | { action: 'boost', score: number, first: boolean } | { action: 'restore', score: number, effort: unknown }}
   *   null = no change; first marks the transition that activates a boost
   *   (metrics count that one only); restore carries the effort to restore
   *   (undefined = adapter default, i.e. drop the field).
   */
  observe(sessionKey, event) {
    const state = this.#stateOf(sessionKey)
    const now = this.#now()
    const current = event?.current ?? null
    const effort = current === null ? undefined : current.reasoningEffort

    if (event?.kind === 'inbox') {
      const { score } = scorePrompt(typeof event.text === 'string' ? event.text : '')
      state.score = score

      if (score >= this.#boostAt) {
        const wasActive = state.active
        state.lastHighAt = now
        if (!wasActive) {
          state.active = true
          state.savedEffort = effort
          state.savedModel = current === null ? undefined : current.model
        }
        return effortRank(effort) < effortRank(this.#effort)
          ? { action: 'boost', score, first: !wasActive }
          : null
      }

      if (state.active && score <= this.#releaseAt && now - state.lastHighAt >= this.#ttlMs) {
        const canRestore = current !== null
          && current.model === state.savedModel
          && effort === this.#effort
        const saved = state.savedEffort
        state.active = false
        state.savedEffort = undefined
        state.savedModel = undefined
        return canRestore ? { action: 'restore', score, effort: saved } : null
      }
      return null
    }

    if (event?.kind !== 'tool') return null
    if (event.toolClass !== 'work') return null
    if (!state.active) return null
    if (current === null || current.model !== state.savedModel) return null
    return effortRank(effort) < effortRank(this.#effort)
      ? { action: 'boost', score: state.score, first: false }
      : null
  }

  /**
   * Current toggle state for one session (diagnostics).
   * @param {string} sessionKey - stable session identity.
   * @returns {null | { active: boolean, score: number, savedEffort: unknown, savedModel: unknown, lastHighAt: number | null }}
   */
  stateOf(sessionKey) {
    const state = this.#states.get(sessionKey)
    if (state === undefined) return null
    return {
      active: state.active,
      score: state.score,
      savedEffort: state.savedEffort,
      savedModel: state.savedModel,
      lastHighAt: Number.isFinite(state.lastHighAt) ? state.lastHighAt : null,
    }
  }

  /**
   * Forget a session's toggle state.
   * @param {string} sessionKey - stable session identity.
   */
  reset(sessionKey) {
    this.#states.delete(sessionKey)
  }
}
