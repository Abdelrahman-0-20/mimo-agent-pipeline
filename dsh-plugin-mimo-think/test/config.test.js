import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/index.js'

const validate = (raw) => Config['~standard'].validate(raw)

const ok = (raw) => {
  const result = validate(raw)
  assert.ok(!('issues' in result), 'unexpected issues: ' + JSON.stringify(result.issues))
  return result.value
}

const bad = (raw, needle) => {
  const result = validate(raw)
  assert.ok('issues' in result, 'expected issues for ' + JSON.stringify(raw))
  assert.ok(
    result.issues.some(entry => entry.message.includes(needle)),
    'no issue matching "' + needle + '" in ' + JSON.stringify(result.issues),
  )
}

test('defaults fill every omitted field', () => {
  assert.deepEqual(ok(undefined), {
    provider: undefined,
    thinkModel: 'mimo-v2.6-pro',
    thinkReasoningEffort: 'high',
    boostEffort: 'high',
    boostThreshold: 4,
    releaseThreshold: 1,
    boostTtlMinutes: 30,
    boostPresets: 'main',
    statePath: 'mimo-think-state.json',
    stateTtlHours: 72,
    thinkTimeoutMs: 600_000,
    thinkRetries: 1,
    thinkReadOnly: true,
  })
})

test('non-object configs are rejected', () => {
  bad('nope', 'config must be an object')
  bad(null, 'config must be an object')
  bad([1], 'config must be an object')
})

test('unknown options are rejected', () => {
  bad({ mystery: 1 }, 'unknown option')
  bad({ boostThreshold: 4, typoBoost: true }, 'unknown option')
})

test('threshold ranges and hysteresis are enforced', () => {
  bad({ boostThreshold: 0 }, 'integer between 1 and 50')
  bad({ boostThreshold: 51 }, 'integer between 1 and 50')
  bad({ boostThreshold: 2.5 }, 'integer between 1 and 50')
  bad({ releaseThreshold: -1 }, 'integer between 0 and 49')
  bad({ boostThreshold: 1 }, 'hysteresis')
  bad({ boostThreshold: 4, releaseThreshold: 4 }, 'hysteresis')
})

test('range checks cover every numeric option', () => {
  bad({ boostTtlMinutes: -1 }, 'integer between 0 and 1440')
  bad({ boostTtlMinutes: 99_999 }, 'integer between 0 and 1440')
  bad({ stateTtlHours: -1 }, 'integer between 0 and 87600')
  bad({ thinkTimeoutMs: 1 }, 'integer between 60000 and 1800000')
  bad({ thinkRetries: 9 }, 'integer between 0 and 3')
})

test('string and enum options are enforced', () => {
  bad({ thinkModel: '' }, 'thinkModel must be a non-empty string')
  bad({ boostEffort: 42 }, 'boostEffort must be a non-empty string')
  bad({ thinkReasoningEffort: 42 }, 'non-empty string or null')
  bad({ provider: '' }, 'provider must be a non-empty string')
  bad({ statePath: 42 }, 'statePath must be a string')
  bad({ boostPresets: 'any' }, 'must be "main" or "all"')
  bad({ thinkReadOnly: 'yes' }, 'must be a boolean')

  assert.equal(ok({ boostPresets: 'all' }).boostPresets, 'all')
  assert.equal(ok({ thinkReasoningEffort: null }).thinkReasoningEffort, null)
  assert.equal(ok({ provider: null }).provider, undefined)
  assert.equal(ok({ statePath: '' }).statePath, '')
})

test('valid overrides land in the value', () => {
  const value = ok({
    thinkModel: 'mimo-v2.6-flash',
    thinkReasoningEffort: 'medium',
    boostEffort: 'medium',
    boostThreshold: 6,
    releaseThreshold: 2,
    boostTtlMinutes: 10,
    thinkTimeoutMs: 120_000,
    thinkRetries: 0,
    thinkReadOnly: false,
  })
  assert.equal(value.thinkModel, 'mimo-v2.6-flash')
  assert.equal(value.thinkReasoningEffort, 'medium')
  assert.equal(value.boostEffort, 'medium')
  assert.equal(value.boostThreshold, 6)
  assert.equal(value.releaseThreshold, 2)
  assert.equal(value.boostTtlMinutes, 10)
  assert.equal(value.thinkTimeoutMs, 120_000)
  assert.equal(value.thinkRetries, 0)
  assert.equal(value.thinkReadOnly, false)
})
