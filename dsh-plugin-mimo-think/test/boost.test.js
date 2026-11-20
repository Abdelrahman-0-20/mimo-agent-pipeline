import test from 'node:test'
import assert from 'node:assert/strict'
import { BoostPolicy, EFFORT_RANK, effortRank } from '../src/boost.js'
import { scorePrompt } from '../src/score.js'

/** The markdown code-fence marker, built without a literal backtick in source. */
const FENCE = String.fromCharCode(96).repeat(3)

const HARD = [
  'Design the migration architecture for our service: analyze the trade-offs of each option,',
  'we must move without downtime, the schema must stay compatible, and the security model must not weaken.',
  FENCE + 'js',
  'export const value = 1',
  FENCE,
  '1. dual-write',
  '2. backfill',
  '3. cut over',
  'Why could this fail? What breaks under load? Explain the rollback.',
].join('\n')
const EASY = 'ok'
const MID = 'explain this error'

// Lock the fixtures against the default thresholds (boost 4, release 1).
assert.ok(scorePrompt(HARD).score >= 4, 'HARD fixture must score >= 4')
assert.ok(scorePrompt(EASY).score <= 1, 'EASY fixture must score <= 1')
const midScore = scorePrompt(MID).score
assert.ok(midScore > 1 && midScore < 4, 'MID fixture must sit in the hysteresis band, got ' + midScore)

const FLASH = { provider: 'xiaomi-mimo', model: 'mimo-v2.6-flash' }

test('effortRank orders known levels and never downgrades unknown ones', () => {
  assert.equal(effortRank(undefined), -1)
  assert.equal(effortRank(null), -1)
  assert.equal(effortRank(''), -1)
  assert.equal(effortRank('off'), EFFORT_RANK.off)
  assert.equal(effortRank('low'), 1)
  assert.equal(effortRank('medium'), 2)
  assert.equal(effortRank('high'), 3)
  assert.equal(effortRank('xhigh'), 4)
  assert.equal(effortRank('ultra'), Number.POSITIVE_INFINITY)
  assert.equal(effortRank(42), Number.POSITIVE_INFINITY)
  assert.ok(effortRank('off') < effortRank('high'))
})

test('constructor enforces hysteresis and sane ranges', () => {
  assert.throws(() => new BoostPolicy({ boostThreshold: 1, releaseThreshold: 1 }), RangeError)
  assert.throws(() => new BoostPolicy({ boostThreshold: 0 }), RangeError)
  assert.throws(() => new BoostPolicy({ releaseThreshold: -1 }), RangeError)
  assert.throws(() => new BoostPolicy({ boostTtlMs: -5 }), RangeError)
  assert.throws(() => new BoostPolicy({ boostEffort: '' }), TypeError)
})

test('a hard prompt boosts once, then stays quiet while already boosted', () => {
  const clock = { t: 1_000_000 }
  const policy = new BoostPolicy({ now: () => clock.t })
  const low = { ...FLASH, reasoningEffort: 'low' }

  const first = policy.observe('s1', { kind: 'inbox', text: HARD, current: low })
  assert.equal(first.action, 'boost')
  assert.equal(first.first, true)
  assert.ok(first.score >= 4)

  const state = policy.stateOf('s1')
  assert.equal(state.active, true)
  assert.equal(state.savedEffort, 'low')
  assert.equal(state.savedModel, 'mimo-v2.6-flash')

  // Second hard message while already at high: no select needed.
  const second = policy.observe('s1', { kind: 'inbox', text: HARD, current: { ...FLASH, reasoningEffort: 'high' } })
  assert.equal(second, null)
  assert.equal(policy.stateOf('s1').active, true)
})

test('a hard prompt does not downgrade an already-higher effort', () => {
  const policy = new BoostPolicy()
  const decision = policy.observe('s2', { kind: 'inbox', text: HARD, current: { ...FLASH, reasoningEffort: 'xhigh' } })
  assert.equal(decision, null)
  assert.equal(policy.stateOf('s2').active, true)
})

test('a trivial prompt while inactive changes nothing', () => {
  const policy = new BoostPolicy()
  assert.equal(policy.observe('s3', { kind: 'inbox', text: EASY, current: FLASH }), null)
  assert.equal(policy.stateOf('s3').active, false)
})

test('work results re-assert a boosted effort that was lowered underneath', () => {
  const clock = { t: 1_000_000 }
  const policy = new BoostPolicy({ now: () => clock.t })
  policy.observe('s4', { kind: 'inbox', text: HARD, current: { ...FLASH, reasoningEffort: 'low' } })

  // The escalator's discovery-off policy (or anything else) lowered effort.
  const reassert = policy.observe('s4', { kind: 'tool', toolClass: 'work', current: { ...FLASH, reasoningEffort: 'off' } })
  assert.equal(reassert.action, 'boost')
  assert.equal(reassert.first, false, 're-asserts must not count as new boosts')

  // Discovery results never re-assert (thinking-off-on-discovery keeps saving).
  assert.equal(policy.observe('s4', { kind: 'tool', toolClass: 'discovery', current: { ...FLASH, reasoningEffort: 'off' } }), null)
})

test('work re-assert never fires for inactive sessions or foreign models', () => {
  const policy = new BoostPolicy()
  assert.equal(policy.observe('s5', { kind: 'tool', toolClass: 'work', current: { ...FLASH, reasoningEffort: 'off' } }), null)

  policy.observe('s5', { kind: 'inbox', text: HARD, current: { ...FLASH, reasoningEffort: 'low' } })
  const foreign = { provider: 'xiaomi-mimo', model: 'mimo-v2.6-pro', reasoningEffort: 'low' }
  assert.equal(policy.observe('s5', { kind: 'tool', toolClass: 'work', current: foreign }), null)
})

test('release needs both a trivial score and the TTL to elapse', () => {
  const clock = { t: 2_000_000 }
  const ttlMs = 30 * 60_000
  const policy = new BoostPolicy({ now: () => clock.t, boostTtlMs: ttlMs })
  policy.observe('s6', { kind: 'inbox', text: HARD, current: { ...FLASH, reasoningEffort: 'medium' } })

  // Too soon: trivial prompt inside the TTL keeps the boost.
  assert.equal(policy.observe('s6', { kind: 'inbox', text: EASY, current: { ...FLASH, reasoningEffort: 'high' } }), null)
  assert.equal(policy.stateOf('s6').active, true)

  // Mid-band score after the TTL: still no release (hysteresis).
  clock.t += ttlMs + 1
  assert.equal(policy.observe('s6', { kind: 'inbox', text: MID, current: { ...FLASH, reasoningEffort: 'high' } }), null)
  assert.equal(policy.stateOf('s6').active, true)

  // Trivial score after the TTL: restore the saved effort.
  const release = policy.observe('s6', { kind: 'inbox', text: EASY, current: { ...FLASH, reasoningEffort: 'high' } })
  assert.equal(release.action, 'restore')
  assert.equal(release.effort, 'medium')
  assert.equal(policy.stateOf('s6').active, false)
})

test('release drops the effort field when the boost started from adapter default', () => {
  const clock = { t: 3_000_000 }
  const ttlMs = 1_000
  const policy = new BoostPolicy({ now: () => clock.t, boostTtlMs: ttlMs })
  const bare = { provider: 'xiaomi-mimo', model: 'mimo-v2.6-flash' }
  policy.observe('s7', { kind: 'inbox', text: HARD, current: bare })
  clock.t += ttlMs + 1
  const release = policy.observe('s7', { kind: 'inbox', text: EASY, current: { ...bare, reasoningEffort: 'high' } })
  assert.equal(release.action, 'restore')
  assert.equal(release.effort, undefined)
})

test('release forgets quietly when the model changed (never stomps a manual /model)', () => {
  const clock = { t: 4_000_000 }
  const ttlMs = 1_000
  const policy = new BoostPolicy({ now: () => clock.t, boostTtlMs: ttlMs })
  policy.observe('s8', { kind: 'inbox', text: HARD, current: { ...FLASH, reasoningEffort: 'low' } })
  clock.t += ttlMs + 1
  const switched = { provider: 'xiaomi-mimo', model: 'mimo-v2.6-pro', reasoningEffort: 'high' }
  assert.equal(policy.observe('s8', { kind: 'inbox', text: EASY, current: switched }), null)
  assert.equal(policy.stateOf('s8').active, false)
})

test('reset forgets a session entirely', () => {
  const policy = new BoostPolicy()
  policy.observe('s9', { kind: 'inbox', text: HARD, current: FLASH })
  assert.notEqual(policy.stateOf('s9'), null)
  policy.reset('s9')
  assert.equal(policy.stateOf('s9'), null)
})
