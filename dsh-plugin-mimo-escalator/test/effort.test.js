import test from 'node:test'
import assert from 'node:assert/strict'
import { toolClass, EffortPolicy } from '../src/effort.js'

test('classification: reads are discovery, everything else is work', () => {
  assert.equal(toolClass('read'), 'discovery')
  assert.equal(toolClass('grep'), 'discovery')
  assert.equal(toolClass('working_directory'), 'discovery')
  assert.equal(toolClass('mcp__github__get_pull_request_status'), 'discovery')
  assert.equal(toolClass('mcp__github__list_pull_requests'), 'discovery')
  assert.equal(toolClass('mcp__github__search_repositories'), 'discovery')
  assert.equal(toolClass('mcp__context7__query-docs'), 'discovery')
  assert.equal(toolClass('mcp__memory__search_nodes'), 'discovery')
  assert.equal(toolClass('mcp__playwright__browser_snapshot'), 'discovery')
  // work side
  assert.equal(toolClass('bash'), 'work')
  assert.equal(toolClass('edit'), 'work')
  assert.equal(toolClass('write'), 'work')
  assert.equal(toolClass('mcp__github__create_issue'), 'work')
  assert.equal(toolClass('mcp__memory__create_entities'), 'work')
  assert.equal(toolClass('mimo_relay'), 'work')
  assert.equal(toolClass('mcp__playwright__browser_navigate'), 'work')
  // unknown / malformed names count as work (reasoning stays on)
  assert.equal(toolClass(undefined), 'work')
  assert.equal(toolClass(''), 'work')
})

test('effort goes OFF only after the configured discovery streak', () => {
  let now = 1_000_000
  const policy = new EffortPolicy({ discoverySteps: 3, minToggleGapMs: 0, now: () => now })
  assert.equal(policy.observe('s1', 'read', 'high'), null)
  assert.equal(policy.observe('s1', 'grep', 'high'), null)
  assert.deepEqual(policy.observe('s1', 'read', 'high'), { action: 'off' }, 'third consecutive discovery flips')
  // the caller applies 'off' now; the next work result restores the saved effort
  const on = policy.observe('s1', 'bash', 'high')
  assert.deepEqual(on, { action: 'on', effort: 'high' })
})

test('a single work result restores the effort immediately and clears the streak', () => {
  const policy = new EffortPolicy({ discoverySteps: 5, minToggleGapMs: 0 })
  policy.observe('s1', 'read', 'medium')
  policy.observe('s1', 'grep', 'medium')
  policy.observe('s1', 'bash', 'medium') // work resets the streak before threshold
  assert.equal(policy.stateOf('s1').streak, 0)
  assert.equal(policy.stateOf('s1').off, false)
  // off → immediate on with the saved effort
  policy.observe('s1', 'read', 'medium')
  policy.observe('s1', 'read', 'medium')
  policy.observe('s1', 'read', 'medium') // off at default steps? steps=5 → not yet
  assert.equal(policy.stateOf('s1').off, false)
})

test('saved effort round-trips through an off/on cycle', () => {
  const policy = new EffortPolicy({ discoverySteps: 1, minToggleGapMs: 0 })
  assert.deepEqual(policy.observe('s1', 'read', 'high'), { action: 'off' })
  const on = policy.observe('s1', 'bash', 'high')
  assert.deepEqual(on, { action: 'on', effort: 'high' }, 'the pre-toggle effort is restored')
  // after restore, saved effort is cleared — a second on cannot fire
  assert.equal(policy.observe('s1', 'bash', 'high'), null)
})

test('the OFF flip respects the debounce gap; work restores regardless', () => {
  let now = 0
  const policy = new EffortPolicy({ discoverySteps: 1, minToggleGapMs: 10_000, now: () => now })
  assert.deepEqual(policy.observe('s1', 'read', undefined), { action: 'off' })
  assert.deepEqual(policy.observe('s1', 'bash', undefined), { action: 'on', effort: undefined })
  now = 5_000 // inside the gap
  assert.equal(policy.observe('s1', 'read', undefined), null, 'gap blocks a rapid re-off')
  now = 10_001
  assert.deepEqual(policy.observe('s1', 'read', undefined), { action: 'off' }, 'gap elapsed, off again')
})

test('sessions are independent and reset clears stale saved effort', () => {
  const policy = new EffortPolicy({ discoverySteps: 1, minToggleGapMs: 0 })
  assert.deepEqual(policy.observe('a', 'read', 'high'), { action: 'off' })
  assert.equal(policy.stateOf('b'), null, 'other sessions untouched')
  policy.reset('a')
  assert.equal(policy.stateOf('a'), null)
  // after reset, a stale work result cannot resurrect the old saved effort
  assert.equal(policy.observe('a', 'bash', undefined), null)
})

test('invalid options are rejected', () => {
  assert.throws(() => new EffortPolicy({ discoverySteps: 0 }), RangeError)
  assert.throws(() => new EffortPolicy({ minToggleGapMs: -1 }), RangeError)
})
