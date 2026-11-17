import test from 'node:test'
import assert from 'node:assert/strict'
import { EscalationState } from '../src/state.js'

test('escalates after two consecutive failures', () => {
  const state = new EscalationState()
  assert.deepEqual(state.recordRound(true), { action: 'none', strikes: 1, passes: 0, escalated: false })
  assert.deepEqual(state.recordRound(true), { action: 'escalate', strikes: 2, passes: 0, escalated: true })
  assert.equal(state.escalated, true)
})

test('a single failure never escalates', () => {
  const state = new EscalationState()
  assert.equal(state.recordRound(true).action, 'none')
  assert.equal(state.escalated, false)
})

test('a passing round resets the strike streak', () => {
  const state = new EscalationState()
  state.recordRound(true)
  state.recordRound(false)
  assert.equal(state.strikes, 0)
  assert.equal(state.recordRound(true).action, 'none')
  assert.equal(state.escalated, false)
})

test('demotes only after consecutive passes while escalated', () => {
  const state = new EscalationState()
  state.recordRound(true)
  state.recordRound(true) // escalate
  assert.equal(state.recordRound(false).action, 'none') // pass 1
  assert.equal(state.recordRound(false).action, 'demote') // pass 2
  assert.equal(state.escalated, false)
})

test('a failure while escalated clears the pass streak (hysteresis)', () => {
  const state = new EscalationState()
  state.recordRound(true)
  state.recordRound(true) // escalate
  state.recordRound(false) // pass 1
  assert.equal(state.recordRound(true).action, 'none') // fail wipes the streak
  assert.equal(state.passes, 0)
  assert.equal(state.escalated, true)
  assert.equal(state.recordRound(false).action, 'none') // pass 1 again
  assert.equal(state.recordRound(false).action, 'demote') // pass 2
})

test('never re-escalates while already escalated', () => {
  const state = new EscalationState()
  state.recordRound(true)
  state.recordRound(true)
  assert.equal(state.recordRound(true).action, 'none')
  assert.equal(state.escalated, true)
})

test('after demotion a full fresh streak is required to escalate again', () => {
  const state = new EscalationState()
  state.recordRound(true)
  state.recordRound(true) // escalate
  state.recordRound(false)
  state.recordRound(false) // demote
  assert.equal(state.strikes, 0)
  assert.equal(state.recordRound(true).action, 'none')
  assert.equal(state.recordRound(true).action, 'escalate')
})

test('threshold 1 escalates on the first failure', () => {
  const state = new EscalationState({ threshold: 1 })
  assert.equal(state.recordRound(true).action, 'escalate')
})

test('custom demoteThreshold demands that many passes', () => {
  const state = new EscalationState({ demoteThreshold: 3 })
  state.recordRound(true)
  state.recordRound(true) // escalate
  state.recordRound(false) // pass 1
  state.recordRound(false) // pass 2
  assert.equal(state.recordRound(false).action, 'demote') // 3rd pass meets demoteThreshold
  assert.equal(state.escalated, false)
  assert.equal(state.recordRound(false).action, 'none') // already back on the base model
})

test('rejects invalid options', () => {
  assert.throws(() => new EscalationState({ threshold: 0 }), RangeError)
  assert.throws(() => new EscalationState({ threshold: 1.5 }), RangeError)
  assert.throws(() => new EscalationState({ demoteThreshold: -1 }), RangeError)
})

test('state keys namespace by workspace basename and role (v0.5)', async () => {
  const { stateKeyFor } = await import('../src/index.js')
  assert.equal(stateKeyFor('/home/u/repo', 'builder'), 'repo:builder')
  assert.equal(stateKeyFor('/home/u/repo/', 'planner'), 'repo:planner')
  assert.equal(stateKeyFor('/home/u/other-repo', 'main'), 'other-repo:main')
  assert.equal(stateKeyFor(undefined, 'builder'), 'workspace:builder')
  assert.equal(stateKeyFor('', 'verifier'), 'workspace:verifier')
  // different roles in one workspace never share a key
  assert.notEqual(stateKeyFor('/repo', 'builder'), stateKeyFor('/repo', 'planner'))
})

test('hydrates from a persisted snapshot and continues the cycle', () => {
  const state = new EscalationState({ initial: { strikes: 1, passes: 0, escalated: false } })
  assert.equal(state.strikes, 1)
  assert.equal(state.recordRound(true).action, 'escalate') // second strike completes it
})

test('snapshot round-trips through restore', () => {
  const original = new EscalationState()
  original.recordRound(true)
  original.recordRound(true)
  const restored = new EscalationState({ initial: original.snapshot() })
  assert.deepEqual(restored.snapshot(), original.snapshot())
  assert.equal(restored.escalated, true)
  assert.equal(restored.recordRound(false).action, 'none')
  assert.equal(restored.recordRound(false).action, 'demote') // cycle continues correctly
})

test('restore ignores unusable stored values', () => {
  const state = new EscalationState({ initial: { strikes: 'x', passes: -5, escalated: 'yes' } })
  assert.deepEqual(state.snapshot(), { strikes: 0, passes: 0, escalated: false })
  state.restore(null)
  state.restore(undefined)
  assert.deepEqual(state.snapshot(), { strikes: 0, passes: 0, escalated: false })
})
