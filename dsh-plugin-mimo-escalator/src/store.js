/**
 * Durable store for dsh-plugin-mimo-escalator (mimo-agent-pipeline v0.4).
 *
 * One JSON file per resolved `statePath` (by default one per workspace, which
 * is why the repo gitignores `mimo-escalator-state.json`). The file holds, per
 * session: the hysteresis snapshot, the selection to restore on demotion, and
 * cumulative metrics (round counts, escalation counters, capped history).
 *
 * Robustness rules: a missing or corrupt file loads as an empty store (the
 * plugin degrades to a fresh cycle, never a crash), TTL prunes entries whose
 * `updatedAt` is older than the configured window, and saves are the caller's
 * explicit action after a mutation — this module never writes on load.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Bump when the entry or fold semantics change; loaders drop other versions. */
export const STORE_VERSION = 1

/** Cap on per-session transition history so the file cannot grow without bound. */
export const HISTORY_CAP = 50

/** @returns {{ version: number, sessions: Record<string, object> }} */
export function emptyStore() {
  return { version: STORE_VERSION, sessions: {} }
}

/**
 * A fresh per-session entry.
 * @param {number} now - epoch milliseconds.
 * @returns {object}
 */
export function newEntry(now) {
  return {
    strikes: 0,
    passes: 0,
    escalated: false,
    original: null,
    firstSeen: now,
    updatedAt: now,
    rounds: { pass: 0, fail: 0 },
    escalations: 0,
    demotions: 0,
    history: [],
  }
}

/**
 * Whether a stored entry carries a usable hysteresis snapshot.
 * @param {unknown} entry - candidate from a parsed file.
 * @returns {boolean}
 */
export function isUsableEntry(entry) {
  return entry !== null && typeof entry === 'object'
    && Number.isInteger(entry.strikes) && entry.strikes >= 0
    && Number.isInteger(entry.passes) && entry.passes >= 0
    && typeof entry.escalated === 'boolean'
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
  if (parsed === null || typeof parsed !== 'object' || parsed.sessions === null || typeof parsed.sessions !== 'object') {
    return emptyStore()
  }
  const store = emptyStore()
  for (const [sessionId, entry] of Object.entries(parsed.sessions)) {
    if (!isUsableEntry(entry)) continue
    if (ttlMs > 0 && now - Number(entry.updatedAt ?? 0) > ttlMs) continue
    store.sessions[sessionId] = entry
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
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

/**
 * Get or create the entry for one session.
 * @param {{ sessions: Record<string, object> }} store - store being mutated.
 * @param {string} sessionId - session identity.
 * @param {number} [now] - epoch milliseconds.
 * @returns {object} the live entry (also stored).
 */
export function entryFor(store, sessionId, now = Date.now()) {
  let entry = store.sessions[sessionId]
  if (!isUsableEntry(entry)) {
    entry = newEntry(now)
    store.sessions[sessionId] = entry
  }
  return entry
}

/**
 * Write a hysteresis snapshot back onto an entry.
 * @param {object} entry - live entry.
 * @param {{ strikes: number, passes: number, escalated: boolean }} snapshot - state snapshot.
 * @param {number} now - epoch milliseconds.
 */
export function applySnapshot(entry, snapshot, now) {
  entry.strikes = snapshot.strikes
  entry.passes = snapshot.passes
  entry.escalated = snapshot.escalated
  entry.updatedAt = now
}

/**
 * Record one counted verification round.
 * @param {object} entry - live entry.
 * @param {'pass' | 'fail'} outcome - round verdict.
 * @param {number} now - epoch milliseconds.
 */
export function countRound(entry, outcome, now) {
  entry.rounds[outcome] = (entry.rounds[outcome] ?? 0) + 1
  entry.updatedAt = now
}

/**
 * Record an escalation transition and append capped history.
 * @param {object} entry - live entry.
 * @param {'escalate' | 'demote'} action - transition kind.
 * @param {string} from - model left behind.
 * @param {string} to - model entered.
 * @param {number} now - epoch milliseconds.
 */
export function recordTransition(entry, action, from, to, now) {
  if (action === 'escalate') entry.escalations = (entry.escalations ?? 0) + 1
  if (action === 'demote') entry.demotions = (entry.demotions ?? 0) + 1
  entry.history.push({ at: new Date(now).toISOString(), action, from, to })
  if (entry.history.length > HISTORY_CAP) {
    entry.history.splice(0, entry.history.length - HISTORY_CAP)
  }
  entry.updatedAt = now
}
