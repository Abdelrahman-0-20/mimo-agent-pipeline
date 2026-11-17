import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STORE_VERSION,
  HISTORY_CAP,
  emptyStore,
  newEntry,
  isUsableEntry,
  loadStore,
  saveStore,
  entryFor,
  applySnapshot,
  countRound,
  recordTransition,
} from '../src/store.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mimo-esc-store-'))
}

test('a missing file loads as an empty store', () => {
  const dir = tempDir()
  const store = loadStore(join(dir, 'absent.json'))
  assert.equal(store.version, STORE_VERSION)
  assert.deepEqual(store.sessions, {})
  rmSync(dir, { recursive: true })
})

test('a corrupt or wrong-shaped file loads as an empty store', () => {
  const dir = tempDir()
  const path = join(dir, 'state.json')
  writeFileSync(path, '{not json at all')
  assert.deepEqual(loadStore(path).sessions, {})
  writeFileSync(path, JSON.stringify({ version: 1, sessions: 'nope' }))
  assert.deepEqual(loadStore(path).sessions, {})
  writeFileSync(path, JSON.stringify({ version: 1, sessions: { bad: { strikes: 'x' } } }))
  assert.deepEqual(loadStore(path).sessions, {})
  rmSync(dir, { recursive: true })
})

test('save then load round-trips entries and metrics', () => {
  const dir = tempDir()
  const path = join(dir, 'nested', 'state.json') // save creates parents
  const store = emptyStore()
  const entry = entryFor(store, 'sess-1', 1000)
  applySnapshot(entry, { strikes: 1, passes: 0, escalated: false }, 2000)
  countRound(entry, 'fail', 2000)
  saveStore(path, store)

  const loaded = loadStore(path, { now: 2000 })
  const back = loaded.sessions['sess-1']
  assert.equal(back.strikes, 1)
  assert.equal(back.escalated, false)
  assert.equal(back.rounds.fail, 1)
  assert.equal(back.updatedAt, 2000)
  rmSync(dir, { recursive: true })
})

test('TTL prunes stale entries and keeps fresh ones', () => {
  const dir = tempDir()
  const path = join(dir, 'state.json')
  const store = emptyStore()
  entryFor(store, 'old', 0).updatedAt = 0
  entryFor(store, 'fresh', 9_000_000).updatedAt = 9_000_000
  saveStore(path, store)

  const loaded = loadStore(path, { ttlMs: 1_000_000, now: 9_500_000 })
  assert.ok(loaded.sessions.fresh, 'fresh entry survives')
  assert.equal(loaded.sessions.old, undefined, 'stale entry is pruned')

  const keepAll = loadStore(path, { ttlMs: 0, now: 9_500_000 })
  assert.ok(keepAll.sessions.old, 'ttl 0 keeps everything')
  rmSync(dir, { recursive: true })
})

test('entryFor creates a valid entry exactly once', () => {
  const store = emptyStore()
  const first = entryFor(store, 's', 42)
  assert.deepEqual(
    { strikes: first.strikes, passes: first.passes, escalated: first.escalated },
    { strikes: 0, passes: 0, escalated: false },
  )
  first.strikes = 1
  assert.equal(entryFor(store, 's', 99).strikes, 1, 'existing entry is reused')
  assert.equal(entryFor(store, 's', 99).firstSeen, 42)
})

test('isUsableEntry rejects malformed entries', () => {
  assert.equal(isUsableEntry(newEntry(1)), true)
  assert.equal(isUsableEntry(null), false)
  assert.equal(isUsableEntry({}), false)
  assert.equal(isUsableEntry({ strikes: -1, passes: 0, escalated: false }), false)
  assert.equal(isUsableEntry({ strikes: 0, passes: 0, escalated: 'yes' }), false)
})

test('recordTransition increments counters and caps history', () => {
  const entry = newEntry(0)
  recordTransition(entry, 'escalate', 'flash', 'pro', 1)
  recordTransition(entry, 'demote', 'pro', 'flash', 2)
  assert.equal(entry.escalations, 1)
  assert.equal(entry.demotions, 1)
  assert.deepEqual(entry.history.map(h => h.action), ['escalate', 'demote'])
  assert.equal(entry.history[0].from, 'flash')

  for (let i = 0; i < HISTORY_CAP + 10; i++) {
    recordTransition(entry, 'escalate', 'flash', 'pro', 3 + i)
  }
  assert.equal(entry.history.length, HISTORY_CAP, 'history stays capped')
  assert.equal(entry.history[HISTORY_CAP - 1].action, 'escalate')
})
