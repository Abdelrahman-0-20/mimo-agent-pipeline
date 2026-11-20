import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIDENCE, THINK_SCHEMA, recoveryPrompt, runThink, thinkPrompt, validateThink,
} from '../src/think.js'

const GOOD = { analysis: 'considered the options', answer: 'ship it', confidence: 'high', risks: [] }

test('thinkPrompt carries the question, context, focus, and handoff contract', () => {
  const prompt = thinkPrompt({ question: 'Should we shard the events table?', context: '40 GB and growing', focus: 'risk' })
  assert.ok(prompt.includes('Question: Should we shard the events table?'))
  assert.ok(prompt.includes('Context: 40 GB and growing'))
  assert.ok(prompt.includes('Focus: apply a risk lens'))
  assert.ok(prompt.includes('structured_output'))
  assert.ok(prompt.includes('READ-ONLY'))
  assert.ok(prompt.includes('mimo_think'))
  assert.ok(prompt.includes('"confidence"'))

  const bare = thinkPrompt({ question: 'q' })
  assert.equal(bare.includes('Context:'), false)
  assert.equal(bare.includes('Focus:'), false)
})

test('THINK_SCHEMA is the enforced object-rooted contract', () => {
  assert.equal(THINK_SCHEMA.type, 'object')
  assert.equal(THINK_SCHEMA.additionalProperties, false)
  assert.deepEqual([...THINK_SCHEMA.required].sort(), ['analysis', 'answer', 'confidence', 'risks'])
  assert.equal(THINK_SCHEMA.properties.risks.items.type, 'string')
  assert.deepEqual([...CONFIDENCE], ['high', 'medium', 'low'])
})

test('recoveryPrompt appends the failure reason and the contract reminder', () => {
  const prompt = recoveryPrompt('base prompt', 'handoff.answer must be a non-empty string')
  assert.ok(prompt.includes('base prompt'))
  assert.ok(prompt.includes('[think recovery]'))
  assert.ok(prompt.includes('handoff.answer must be a non-empty string'))
  assert.ok(prompt.includes('"high"'))
})

test('validateThink accepts a valid handoff and normalizes it', () => {
  const check = validateThink({ analysis: '  deep reasoning  ', answer: ' the answer ', confidence: ' High ', risks: ['unknown'] })
  assert.equal(check.ok, true)
  assert.equal(check.value.analysis, 'deep reasoning')
  assert.equal(check.value.answer, 'the answer')
  assert.equal(check.value.confidence, 'high')
  assert.deepEqual(check.value.risks, ['unknown'])

  const defaulted = validateThink({ analysis: 'a', answer: 'b', confidence: 'low' })
  assert.equal(defaulted.ok, true)
  assert.deepEqual(defaulted.value.risks, [])
})

test('validateThink rejects malformed handoffs with precise reasons', () => {
  assert.equal(validateThink(undefined).ok, false)
  assert.equal(validateThink('text').ok, false)
  assert.equal(validateThink([]).ok, false)
  assert.equal(validateThink({ analysis: '', answer: 'b', confidence: 'high', risks: [] }).reason, 'handoff.analysis must be a non-empty string')
  assert.equal(validateThink({ analysis: 'a', answer: '   ', confidence: 'high', risks: [] }).reason, 'handoff.answer must be a non-empty string')
  assert.equal(validateThink({ analysis: 'a', answer: 'b', confidence: 'sure', risks: [] }).reason, 'handoff.confidence must be one of high|medium|low')
  assert.equal(validateThink({ analysis: 'a', answer: 'b', confidence: 42, risks: [] }).reason, 'handoff.confidence must be one of high|medium|low')
  assert.equal(validateThink({ analysis: 'a', answer: 'b', confidence: 'high', risks: 'none' }).reason, 'handoff.risks must be a list of strings')
  assert.equal(validateThink({ analysis: 'a', answer: 'b', confidence: 'high', risks: [1] }).reason, 'handoff.risks must be a list of strings')
})

test('runThink succeeds on a completed child with a valid handoff', async () => {
  const seen = []
  const report = await runThink({
    question: 'Should we shard?',
    retries: 0,
    spawn: async ({ prompt, outputSchema, signal }) => {
      seen.push({ prompt, outputSchema, hasSignal: signal !== undefined })
      return { stopReason: 'completed', structured: { ...GOOD } }
    },
  })
  assert.equal(report.ok, true)
  assert.equal(report.attempts, 1)
  assert.equal(report.reason, '')
  assert.equal(report.result.answer, 'ship it')
  assert.equal(seen.length, 1)
  assert.ok(seen[0].prompt.includes('Question: Should we shard?'))
  assert.equal(seen[0].outputSchema, THINK_SCHEMA)
  assert.equal(seen[0].hasSignal, true)
})

test('an invalid handoff triggers the recovery retry and can recover', async () => {
  const prompts = []
  let calls = 0
  const report = await runThink({
    question: 'q',
    retries: 1,
    spawn: async ({ prompt }) => {
      prompts.push(prompt)
      calls += 1
      if (calls === 1) {
        return { stopReason: 'completed', structured: { analysis: '', answer: '', confidence: 'sure', risks: 'no' } }
      }
      return { stopReason: 'completed', structured: { ...GOOD } }
    },
  })
  assert.equal(report.ok, true)
  assert.equal(report.attempts, 2)
  assert.equal(prompts.length, 2)
  assert.ok(prompts[1].includes('[think recovery]'))
  assert.ok(prompts[1].includes('Question: q'))
})

test('a missing structured output is treated as a failed attempt', async () => {
  let calls = 0
  const report = await runThink({
    question: 'q',
    retries: 1,
    spawn: async () => {
      calls += 1
      if (calls === 1) return { stopReason: 'completed' }
      return { stopReason: 'completed', structured: { ...GOOD } }
    },
  })
  assert.equal(report.ok, true)
  assert.equal(report.attempts, 2)
})

test('a non-completed child fails after retries with stopReason context', async () => {
  const report = await runThink({
    question: 'q',
    retries: 0,
    spawn: async () => ({ stopReason: 'error', diagnostic: 'backend exploded' }),
  })
  assert.equal(report.ok, false)
  assert.equal(report.result, null)
  assert.equal(report.attempts, 1)
  assert.ok(report.reason.includes('stopReason=error'))
  assert.ok(report.reason.includes('backend exploded'))
})

test('a thrown spawn is reported, not propagated', async () => {
  const report = await runThink({
    question: 'q',
    retries: 0,
    spawn: async () => { throw new Error('spawn died') },
  })
  assert.equal(report.ok, false)
  assert.equal(report.reason, 'spawn died')
  assert.equal(report.attempts, 1)
})

test('a quota failure cools off through the injected sleep before retrying', async () => {
  const sleeps = []
  let calls = 0
  const report = await runThink({
    question: 'q',
    retries: 1,
    sleep: async (ms) => { sleeps.push(ms) },
    spawn: async () => {
      calls += 1
      if (calls === 1) return { stopReason: 'error', diagnostic: '429 quota exhausted' }
      return { stopReason: 'completed', structured: { ...GOOD } }
    },
  })
  assert.equal(report.ok, true)
  assert.equal(report.attempts, 2)
  assert.deepEqual(sleeps, [60_000])
})

test('a hung child is bounded by the attempt timeout', async () => {
  const report = await runThink({
    question: 'q',
    retries: 0,
    timeoutMs: 30,
    spawn: () => new Promise(() => {}),
  })
  assert.equal(report.ok, false)
  assert.ok(report.reason.includes('timed out'), report.reason)
  assert.equal(report.attempts, 1)
})

test('an outer abort fails the pass with the abort reason', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error('outer aborted')), 20)
  const report = await runThink({
    question: 'q',
    retries: 0,
    signal: controller.signal,
    spawn: () => new Promise(() => {}),
  })
  assert.equal(report.ok, false)
  assert.ok(report.reason.includes('outer aborted'), report.reason)
})

test('an already-aborted pass fails without spawning a child', async () => {
  const controller = new AbortController()
  controller.abort(new Error('outer aborted'))
  let spawnCalls = 0
  const report = await runThink({
    question: 'q',
    retries: 1,
    signal: controller.signal,
    spawn: async () => {
      spawnCalls += 1
      return { stopReason: 'completed', structured: { ...GOOD } }
    },
  })
  assert.equal(report.ok, false)
  assert.equal(spawnCalls, 0, 'a doomed child must never be spawned')
  assert.ok(report.reason.includes('outer aborted'), report.reason)
})

test('a spawn rejection after an abort is observed, never unhandled', async () => {
  const unhandled = []
  const onUnhandled = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const controller = new AbortController()
    const report = await runThink({
      question: 'q',
      retries: 1,
      signal: controller.signal,
      spawn: () => {
        // Abort synchronously while the spawn promise is still pending: the
        // race must still observe the spawn's later rejection, or it becomes
        // an unhandled rejection that fails the whole harness process.
        controller.abort(new Error('outer aborted'))
        return new Promise((resolve, reject) => { setTimeout(() => reject(new Error('spawn died')), 10) })
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(report.ok, false)
    assert.ok(report.reason.includes('outer aborted'), report.reason)
    assert.deepEqual(unhandled, [], 'the spawn rejection must be observed by the race')
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})

test('a plain-object rejection is reported as JSON, not [object Object]', async () => {
  const report = await runThink({
    question: 'q',
    retries: 0,
    spawn: async () => { throw { kind: 'parent' } },
  })
  assert.equal(report.ok, false)
  assert.equal(report.reason, '{"kind":"parent"}')
})
