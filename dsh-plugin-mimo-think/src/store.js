/**
 * Durable metrics store for dsh-plugin-mimo-think (mimo-agent-pipeline).
 *
 * One JSON file per resolved statePath (by default one per workspace, which
 * is why the repo gitignores mimo-think-state.json). The file holds, per
 * workspace:role domain, cumulative metrics — boost/restore counters, think
 * pass/fail counters, the last prompt score, and capped history.
 *
 * Robustness rules (mirroring the escalator's store): a missing or corrupt
 * file loads as an empty store, TTL prunes idle entries, and saves are the
 * caller's explicit action after a mutation — this module never writes on
 * load. Boost decisions themselves stay in memory (a fresh session starts
 * with no boost); only metrics cross restarts.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Bump when entry semantics change; other versions load as empty. */
export const STORE_VERSION = 1

/** Cap on per-domain history so the file cannot grow without bound. */
export const HISTORY_CAP = 50

/** @returns {{ version: number, sessions: Record<string, object> }} */
export function emptyStore() {
  return { version: STORE_VERSION, sessions: {} }
}

/**
 * A fresh per-domain entry.
 * @param {number} now - epoch milliseconds.
 * @returns {object}
 */
export function newEntry(now) {
  return {
    firstSeen: now,
    updatedAt: now,
    boosts: 0,
    restores: 0,
    think: { ok: 0, fail: 0, attempts: 0 },
    lastScore: null,
    history: [],
  }
}

/**
 * Whether a stored entry is usable.
 * @param {unknown} entry - candidate from a parsed file.
 * @returns {boolean}
 */
export function isUsableEntry(entry) {
  return entry !== null && typeof entry === 'object'
    && Number.isFinite(entry.updatedAt)
}

/**
 * Load a store, pruning entries outside the TTL window.
 * Missing, corrupt, or wrong-shaped files load as an empty store.
 * @param {string} path - store file path.
 * @param {{ ttlMs?: number, now?: number }} [options] - ttlMs 0 or less keeps everything.
 * @returns {{ version: number, sessions: Record<string, object> }}
 */
export function loadStore(path, { ttlMs = 0, now = Date.now() } = {}) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return emptyStore()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyStore()
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== STORE_VERSION
    || parsed.sessions === null || typeof parsed.sessions !== 'object') {
    return emptyStore()
  }
  const store = emptyStore()
  for (const [key, entry] of Object.entries(parsed.sessions)) {
    if (!isUsableEntry(entry)) continue
    if (ttlMs > 0 && now - Number(entry.updatedAt) > ttlMs) continue
    store.sessions[key] = entry
  }
  return store
}

/**
 * Write a store file, creating parent directories.
 * @param {string} path - store file path.
 * @param {{ version: number, sessions: Record<string, object> }} store - store to persist.
 */
export function saveStore(path, store) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', 'utf8')
}

/**
 * Get or create the entry for one domain key.
 * @param {{ sessions: Record<string, object> }} store - store being mutated.
 * @param {string} key - domain identity (workspace:role).
 * @param {number} [now] - epoch milliseconds.
 * @returns {object} the live entry (also stored).
 */
export function entryFor(store, key, now = Date.now()) {
  let entry = store.sessions[key]
  if (!isUsableEntry(entry)) {
    entry = newEntry(now)
    store.sessions[key] = entry
  }
  return entry
}

/** Append capped history. */
function pushHistory(entry, action, detail, now) {
  if (!Array.isArray(entry.history)) entry.history = []
  entry.history.push({ at: new Date(now).toISOString(), action, ...detail })
  if (entry.history.length > HISTORY_CAP) {
    entry.history.splice(0, entry.history.length - HISTORY_CAP)
  }
}

/**
 * Record an activated boost.
 * @param {object} entry - live entry.
 * @param {number} score - the prompt score that triggered it.
 * @param {number} now - epoch milliseconds.
 */
export function recordBoost(entry, score, now) {
  entry.boosts = (entry.boosts ?? 0) + 1
  entry.lastScore = score
  entry.updatedAt = now
  pushHistory(entry, 'boost', { score }, now)
}

/**
 * Record an effort restore (boost released).
 * @param {object} entry - live entry.
 * @param {number} score - the prompt score that triggered the release.
 * @param {number} now - epoch milliseconds.
 */
export function recordRestore(entry, score, now) {
  entry.restores = (entry.restores ?? 0) + 1
  entry.lastScore = score
  entry.updatedAt = now
  pushHistory(entry, 'restore', { score }, now)
}

/**
 * Record one mimo_think outcome.
 * @param {object} entry - live entry.
 * @param {boolean} ok - whether the pass returned a valid handoff.
 * @param {number} attempts - attempts the pass consumed.
 * @param {number} now - epoch milliseconds.
 */
export function recordThink(entry, ok, attempts, now) {
  if (entry.think === null || typeof entry.think !== 'object') {
    entry.think = { ok: 0, fail: 0, attempts: 0 }
  }
  if (ok) entry.think.ok = (entry.think.ok ?? 0) + 1
  else entry.think.fail = (entry.think.fail ?? 0) + 1
  entry.think.attempts = (entry.think.attempts ?? 0) + attempts
  entry.updatedAt = now
  pushHistory(entry, ok ? 'think-ok' : 'think-fail', { attempts }, now)
}
