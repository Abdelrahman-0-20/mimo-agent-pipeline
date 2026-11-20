import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HISTORY_CAP, STORE_VERSION, emptyStore, entryFor, isUsableEntry,
  loadStore, newEntry, recordBoost, recordRestore, recordThink, saveStore,
} from '../src/store.js'

const dir = mkdtempSync(join(tmpdir(), 'mimo-think-store-'))
after(() => { rmSync(dir, { recursive: true, force: true }) })

test('missing, corrupt, and wrong-version stores load as empty', () => {
  assert.deepEqual(loadStore(join(dir, 'nope.json')), emptyStore())
  const corrupt = join(dir, 'corrupt.json')
  writeFileSync(corrupt, 'not json at all')
  assert.deepEqual(loadStore(corrupt), emptyStore())
  const wrongVersion = join(dir, 'wrong.json')
  writeFileSync(wrongVersion, JSON.stringify({ version: 99, sessions: { a: { updatedAt: 1 } } }))
  assert.deepEqual(loadStore(wrongVersion), emptyStore())
})

test('entries round-trip through save/load with counters intact', () => {
  const path = join(dir, 'state.json')
  const store = emptyStore()
  const entry = entryFor(store, 'repo:main', 1000)
  recordBoost(entry, 7, 1000)
  recordRestore(entry, 0, 2000)
  recordThink(entry, true, 1, 3000)
  recordThink(entry, false, 2, 4000)
  saveStore(path, store)
  assert.ok(existsSync(path))

  const back = loadStore(path).sessions['repo:main']
  assert.equal(back.boosts, 1)
  assert.equal(back.restores, 1)
  assert.deepEqual(back.think, { ok: 1, fail: 1, attempts: 3 })
  assert.equal(back.lastScore, 0)
  assert.equal(back.history.length, 4)
  assert.equal(back.firstSeen, 1000)
})

test('TTL prunes idle entries but keeps fresh ones (0 keeps everything)', () => {
  const path = join(dir, 'ttl.json')
  const store = emptyStore()
  entryFor(store, 'fresh', 900_000)
  entryFor(store, 'stale', 100_000)
  saveStore(path, store)

  const pruned = loadStore(path, { ttlMs: 500_000, now: 1_000_000 })
  assert.ok(pruned.sessions.fresh)
  assert.equal(pruned.sessions.stale, undefined)

  const keepAll = loadStore(path, { ttlMs: 0, now: 1_000_000 })
  assert.ok(keepAll.sessions.stale)
})

test('history is capped while counters keep growing', () => {
  const store = emptyStore()
  const entry = entryFor(store, 'cap', 0)
  for (let i = 0; i < HISTORY_CAP + 10; i++) recordBoost(entry, i, i)
  assert.equal(entry.history.length, HISTORY_CAP)
  assert.equal(entry.boosts, HISTORY_CAP + 10)
})

test('unusable entries are replaced by entryFor', () => {
  const store = emptyStore()
  store.sessions.bad = { notAnEntry: true }
  const entry = entryFor(store, 'bad', 5)
  assert.equal(entry.boosts, 0)
  assert.ok(isUsableEntry(entry))
  assert.equal(isUsableEntry({ updatedAt: 'soon' }), false)
  assert.equal(isUsableEntry(null), false)
  assert.equal(isUsableEntry([1, 2]), false)
})

test('newEntry carries the documented shape', () => {
  const entry = newEntry(42)
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['boosts', 'firstSeen', 'history', 'lastScore', 'restores', 'think', 'updatedAt'],
  )
  assert.equal(entry.firstSeen, 42)
  assert.deepEqual(entry.think, { ok: 0, fail: 0, attempts: 0 })
  assert.equal(STORE_VERSION, 1)
})
