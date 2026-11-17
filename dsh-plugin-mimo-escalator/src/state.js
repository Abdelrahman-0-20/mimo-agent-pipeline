/**
 * Pure escalation state for dsh-plugin-mimo-escalator (mimo-agent-pipeline v0.3).
 *
 * Two-strike hysteresis with no timers and no I/O: a session escalates after
 * `threshold` consecutive failed verification rounds, and only returns after
 * `demoteThreshold` consecutive passing rounds observed *while escalated*.
 * A failure while escalated clears the pass streak, so one lucky run never
 * flaps the model back. Strikes always reset on a pass, so a demotion always
 * leaves a clean slate for the next cycle.
 *
 * The caller (src/index.js) owns persistence: v0.3 keeps entries in memory
 * keyed by session id; file persistence/TTL is deferred to v0.4+.
 */
export class EscalationState {
  #threshold
  #demoteThreshold
  #strikes = 0
  #passes = 0
  #escalated = false

  /**
   * @param {{ threshold?: number, demoteThreshold?: number }} [options]
   *   threshold — consecutive failed rounds that trigger escalation.
   *   demoteThreshold — consecutive passing rounds required to return.
   */
  constructor({ threshold = 2, demoteThreshold = 2 } = {}) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new RangeError('threshold must be an integer >= 1')
    }
    if (!Number.isInteger(demoteThreshold) || demoteThreshold < 1) {
      throw new RangeError('demoteThreshold must be an integer >= 1')
    }
    this.#threshold = threshold
    this.#demoteThreshold = demoteThreshold
  }

  /** Consecutive failed rounds since the last pass. */
  get strikes() { return this.#strikes }

  /** Consecutive passing rounds recorded while escalated. */
  get passes() { return this.#passes }

  /** Whether the session is currently escalated. */
  get escalated() { return this.#escalated }

  /**
   * Record one verification round and return the transition it caused.
   * @param {boolean} failed - true when the round failed.
   * @returns {{ action: 'escalate' | 'demote' | 'none', strikes: number, passes: number, escalated: boolean }}
   */
  recordRound(failed) {
    if (failed) {
      this.#strikes += 1
      this.#passes = 0
      if (!this.#escalated && this.#strikes >= this.#threshold) {
        this.#escalated = true
        return { action: 'escalate', ...this.#snapshot() }
      }
      return { action: 'none', ...this.#snapshot() }
    }
    this.#strikes = 0
    if (this.#escalated) {
      this.#passes += 1
      if (this.#passes >= this.#demoteThreshold) {
        this.#escalated = false
        this.#passes = 0
        return { action: 'demote', ...this.#snapshot() }
      }
      return { action: 'none', ...this.#snapshot() }
    }
    this.#passes = 0
    return { action: 'none', ...this.#snapshot() }
  }

  #snapshot() {
    return { strikes: this.#strikes, passes: this.#passes, escalated: this.#escalated }
  }
}
