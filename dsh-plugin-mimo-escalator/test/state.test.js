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
