/**
 * Connector locks for the mimo relay (mimo-agent-pipeline v0.5).
 *
 * DSH ships no generic lock primitive, so the relay owns one: named FIFO
 * mutexes with token-based, idempotent release. The driver holds a lock for
 * the whole lifetime of a relay phase — `reader:<workspace>` shared for
 * planning, `writer:<workspace>` exclusive for the single-writer build,
 * `browser:<workspace>` exclusive for the single-browser verification — so
 * two relays (or a relay and a manual session) can never overlap the same
 * connector. A queued waiter may cancel through its AbortSignal; releasing
 * a lock one no longer owns is a no-op.
 */
export class LockRegistry {
  /** @type {Map<string, symbol>} lock name → owner token */
  #held = new Map()
  /** @type {Map<string, Array<{ token: symbol, grant: (release: () => Promise<void>) => void }>>} */
  #waiters = new Map()

  /**
   * Acquire a lock, waiting FIFO while it is held.
   * @param {string} name - lock identity, e.g. `writer:repo`.
   * @param {string} [holder] - diagnostic label for snapshots.
   * @param {AbortSignal} [signal] - cancels a queued wait (never a held lock).
   * @returns {Promise<() => Promise<void>>} owner-bound, idempotent release.
   */
  acquire(name, holder = 'anonymous', signal) {
    if (signal?.aborted === true) return Promise.reject(new Error('lock acquisition aborted'))
    const token = Symbol(holder)
    if (!this.#held.has(name)) {
      this.#held.set(name, token)
      return Promise.resolve(this.#makeRelease(name, token))
    }
    return new Promise((resolve, reject) => {
      let cleanup = () => {}
      if (signal !== undefined) {
        const onAbort = () => {
          const current = this.#waiters.get(name)
          if (current === undefined) return
          const index = current.indexOf(waiter)
          if (index >= 0) current.splice(index, 1)
          if (current.length === 0) this.#waiters.delete(name)
          reject(new Error('lock acquisition aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        cleanup = () => signal.removeEventListener('abort', onAbort)
      }
      const waiter = {
        token,
        grant: (release) => {
          cleanup()
          resolve(release)
        },
      }
      const queue = this.#waiters.get(name) ?? []
      queue.push(waiter)
      this.#waiters.set(name, queue)
      // The signal may have flipped between the entry check and this push.
      if (signal?.aborted === true) onAbort()
    })
  }

  /** Whether the lock is currently held. */
  isHeld(name) {
    return this.#held.has(name)
  }

  /** Holder label of a held lock, or null. */
  holderOf(name) {
    const token = this.#held.get(name)
    return token === undefined ? null : (token.description ?? '')
  }

  /** Number of waiters queued for a lock. */
  waiting(name) {
    return this.#waiters.get(name)?.length ?? 0
  }

  /** All held locks → holder labels (diagnostics and status output). */
  snapshot() {
    const out = {}
    for (const [name, token] of this.#held) out[name] = token.description ?? ''
    return out
  }

  #makeRelease(name, token) {
    let released = false
    return async () => {
      if (released) return
      released = true
      // Only the current owner may release; a stale release after transfer is a no-op.
      if (this.#held.get(name) !== token) return
      const queue = this.#waiters.get(name)
      const next = queue === undefined ? undefined : queue.shift()
      if (next !== undefined) {
        if (queue.length === 0) this.#waiters.delete(name)
        this.#held.set(name, next.token)
        next.grant(this.#makeRelease(name, next.token))
      } else {
        this.#held.delete(name)
      }
    }
  }
}
