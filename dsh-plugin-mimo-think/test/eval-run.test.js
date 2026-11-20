import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  InfraError, DEFAULT_PATHS, canonicalHash, parseThresholds, loadGoldenSet, loadCosts,
  decideFresh, decideBoosted, freshCost, boostedCost, costModel, countLabels,
  signalBreakdown, bootstrapCI, sequenceProblems, runSequence,
  diffAppendOnly, staleFactors, compareWithPrevious, evaluate, parseArgs,
} from '../eval/run.mjs'

const TH = { boostThreshold: 4, releaseThreshold: 1, boostTtlMinutes: 30 }
const W = { missBoost: 10, wrongRelease: 12, falseBoost: 2, stuckBoost: 1, ambiguousBoost: 1, ambiguousMiss: 1, ambiguousHold: 0 }

const dir = mkdtempSync(join(tmpdir(), 'mimo-think-eval-'))
after(() => { rmSync(dir, { recursive: true, force: true }) })

function makeSet(examples, sequences = []) {
  return {
    protocolVersion: 'blind-dual-v1',
    provenance: { hash: canonicalHash(examples), labelers: 2 },
    composition: countLabels(examples),
    examples,
    sequences,
  }
}

test('T1: cost model matches a hand-computed fixture', () => {
  const scored = [
    { example: { id: 'h', label: 'should_boost', text: 'hard' }, score: 0, hits: [] },
    { example: { id: 'e', label: 'should_release', text: 'easy' }, score: 0, hits: [] },
    { example: { id: 'a', label: 'ambiguous', text: 'mid' }, score: 2, hits: [] },
    { example: { id: 'f', label: 'should_release', text: 'false-boost' }, score: 5, hits: [] },
  ]
  const model = costModel(scored, TH, W)
  // h: fresh miss 10 + boosted wrongRelease 12 -> per-example (10+12)/2 = 11
  assert.equal(model.perExample.h, 11)
  // e: clean both contexts
  assert.equal(model.perExample.e, 0)
  // a: abstention both contexts
  assert.equal(model.perExample.a, 0)
  // f: falseBoost in both contexts -> 2
  assert.equal(model.perExample.f, 2)
  assert.equal(model.fresh.total, 12)
  assert.equal(model.boosted.total, 14)
  assert.equal(model.meanCost, 26 / 8)
  assert.equal(model.fresh.cells['should_release/boost'], 1)
  assert.equal(model.boosted.cells['should_boost/restore'], 1)
})

test('T1b: decision and cell helpers cover every label x decision', () => {
  assert.equal(decideFresh(4, TH), 'boost')
  assert.equal(decideFresh(3, TH), 'none')
  assert.equal(decideBoosted(5, TH), 'boost')
  assert.equal(decideBoosted(1, TH), 'restore')
  assert.equal(decideBoosted(2, TH), 'none')
  assert.equal(freshCost('should_boost', 'none', W), 10)
  assert.equal(freshCost('should_boost', 'boost', W), 0)
  assert.equal(freshCost('should_release', 'boost', W), 2)
  assert.equal(freshCost('ambiguous', 'boost', W), 1)
  assert.equal(freshCost('ambiguous', 'none', W), 0)
  assert.equal(boostedCost('should_boost', 'restore', W), 12)
  assert.equal(boostedCost('should_release', 'restore', W), 0)
  assert.equal(boostedCost('should_release', 'none', W), 1)
  assert.equal(boostedCost('ambiguous', 'restore', W), 1)
  assert.equal(boostedCost('ambiguous', 'none', W), 0)
})

test('T2: real costs.json passes the asymmetry floor; broken weights are rejected', () => {
  const { weights, delta } = loadCosts(DEFAULT_PATHS.costs)
  assert.ok(weights.wrongRelease > weights.missBoost)
  assert.ok(weights.missBoost > weights.falseBoost)
  assert.ok(weights.falseBoost >= weights.ambiguousBoost)
  assert.equal(delta, 0.05)

  const badPath = join(dir, 'bad-costs.json')
  writeFileSync(badPath, JSON.stringify({ weights: { ...W, wrongRelease: 1 }, delta: 0.05 }))
  assert.throws(() => loadCosts(badPath), (error) => error instanceof InfraError && /asymmetry floor/.test(error.message))
})

test('T3: golden set integrity — valid loads, tamper and corruption fail closed', () => {
  const examples = [{ id: 'x1', text: 'hi', label: 'should_release', rationale: 'greeting' }]
  const goodPath = join(dir, 'good.json')
  writeFileSync(goodPath, JSON.stringify(makeSet(examples)))
  const loaded = loadGoldenSet(goodPath)
  assert.equal(loaded.examples.length, 1)

  // Tampered content with a stale hash -> fail closed.
  const tampered = makeSet(examples)
  tampered.examples = [{ id: 'x1', text: 'hi there', label: 'should_release', rationale: 'greeting' }]
  const tamperedPath = join(dir, 'tampered.json')
  writeFileSync(tamperedPath, JSON.stringify(tampered))
  assert.throws(() => loadGoldenSet(tamperedPath), (error) => error instanceof InfraError && /hash mismatch/.test(error.message))

  // Corrupt JSON -> fail closed with a fix.
  const corruptPath = join(dir, 'corrupt.json')
  writeFileSync(corruptPath, '{not json')
  assert.throws(() => loadGoldenSet(corruptPath), (error) => error instanceof InfraError && /not valid JSON/.test(error.message))

  // Composition mismatch -> fail closed.
  const wrongComposition = makeSet(examples)
  wrongComposition.composition.should_release = 5
  const wrongPath = join(dir, 'wrong-composition.json')
  writeFileSync(wrongPath, JSON.stringify(wrongComposition))
  assert.throws(() => loadGoldenSet(wrongPath), (error) => error instanceof InfraError && /composition/.test(error.message))
})

test('T4: missing golden set names the restore command', () => {
  assert.throws(
    () => loadGoldenSet(join(dir, 'nope.json')),
    (error) => error instanceof InfraError && /git checkout HEAD/.test(error.message),
  )
})

test('T5: threshold extraction is line-scoped and loud when keys vanish', () => {
  const good = [
    '- insert:',
    '    - id: mimo-think',
    '      name: dsh-plugin-mimo-think',
    '      config:',
    '        boostThreshold: 4',
    '        releaseThreshold: 1',
    '        boostTtlMinutes: 30',
    '    - id: preset-thinker',
    '      name: @deepseek-ai/dsh-agent-preset',
  ].join('\n')
  assert.deepEqual(parseThresholds(good), { boostThreshold: 4, releaseThreshold: 1, boostTtlMinutes: 30 })

  const missingKey = good.replace('        boostThreshold: 4\n', '')
  assert.throws(() => parseThresholds(missingKey), (error) => error instanceof InfraError && /boostThreshold/.test(error.message))

  assert.throws(
    () => parseThresholds('- insert:\n    - id: other\n'),
    (error) => error instanceof InfraError && /mimo-think/.test(error.message),
  )
})

test('T6: sequence shapes are validated and violations are reported', () => {
  const ids = new Set(['q'])
  const bad1 = { id: 's', initial: { model: 'm' }, steps: [{ type: 'inbox', exampleId: 'ghost', advanceMs: 0 }], expect: [['boost']] }
  assert.ok(sequenceProblems(bad1, ids).some(p => /unknown example/.test(p)))

  const bad2 = { id: 's', initial: { model: 'm' }, steps: [{ type: 'inbox', exampleId: 'q' }], expect: [] }
  assert.ok(sequenceProblems(bad2, ids).some(p => /length/.test(p)))

  const bad3 = { id: 's', initial: { model: 'm' }, steps: [{ type: 'teleport', exampleId: 'q' }], expect: [['boost']] }
  assert.ok(sequenceProblems(bad3, ids).some(p => /unknown type/.test(p)))

  const bad4 = { id: 's', initial: { model: 'm' }, steps: [{ type: 'inbox', exampleId: 'q' }], expect: [['yeet']] }
  assert.ok(sequenceProblems(bad4, ids).some(p => /invalid expected action/.test(p)))

  // A correct-shape sequence whose expectation the policy does not meet -> violation.
  const seq = { id: 'x', initial: { boosted: false, effort: 'low', model: 'm' }, steps: [{ type: 'inbox', exampleId: 'q', advanceMs: 0 }], expect: [['restore']] }
  const result = runSequence(seq, new Map([['q', 'hi']]), ['hard design text'], TH)
  assert.equal(result.violations.length, 1)
  assert.equal(result.violations[0].action, 'none')
  assert.deepEqual(result.violations[0].allowed, ['restore'])
})

test('T7: bootstrap CI is byte-identical across runs (seeded)', () => {
  const values = [0, 1, 0, 2, 0, 0, 3, 1, 0, 0, 1, 0]
  assert.deepEqual(bootstrapCI(values), bootstrapCI(values))
  const other = bootstrapCI(values, { seed: 7 })
  assert.deepEqual(other, bootstrapCI(values, { seed: 7 }))
})

test('T8: stale detection names exactly the drifted factors', () => {
  const pins = {
    goldenSetHash: 'sha256:a', scorerFingerprint: 'sha256:b',
    thresholds: { ...TH }, costWeights: { ...W }, protocolVersion: 'blind-dual-v1',
  }
  assert.deepEqual(staleFactors({ ...pins }, pins), [])
  assert.deepEqual(staleFactors({ ...pins, thresholds: { ...TH, boostThreshold: 9 } }, pins), ['thresholds'])
  assert.deepEqual(staleFactors({ ...pins, goldenSetHash: 'sha256:z' }, pins), ['goldenSetHash'])
  assert.deepEqual(staleFactors({ ...pins, scorerFingerprint: 'sha256:z' }, pins), ['scorerFingerprint'])
  assert.deepEqual(staleFactors({ ...pins, costWeights: { ...W, missBoost: 99 } }, pins), ['costWeights'])
})

test('T10: append-only diff allows additions, rejects removals and mutations', () => {
  const oldSet = { examples: [
    { id: 'a', text: 'one', label: 'should_boost' },
    { id: 'b', text: 'two', label: 'should_release' },
  ] }
  const added = { examples: [...oldSet.examples, { id: 'c', text: 'three', label: 'ambiguous' }] }
  assert.deepEqual(diffAppendOnly(oldSet, added), [])

  const removed = { examples: [oldSet.examples[0]] }
  assert.equal(diffAppendOnly(oldSet, removed).length, 1)
  assert.match(diffAppendOnly(oldSet, removed)[0].problem, /removed/)

  const mutated = { examples: [oldSet.examples[0], { id: 'b', text: 'TWO', label: 'should_release' }] }
  assert.match(diffAppendOnly(oldSet, mutated)[0].problem, /text mutated/)

  const relabeled = { examples: [oldSet.examples[0], { id: 'b', text: 'two', label: 'ambiguous' }] }
  assert.match(diffAppendOnly(oldSet, relabeled)[0].problem, /label mutated/)
})

test('T8b: compareWithPrevious applies delta over previously-known ids only', () => {
  const previous = { exampleCosts: { a: 1, b: 0 } }
  const same = { a: 1, b: 0 }
  const better = { a: 0.5, b: 0 }
  const worse = { a: 1.2, b: 0 }
  assert.equal(compareWithPrevious(previous, same, 0.05).ok, true)
  assert.equal(compareWithPrevious(previous, better, 0.05).ok, true)
  const regression = compareWithPrevious(previous, worse, 0.05)
  assert.equal(regression.ok, false)
  assert.ok(regression.deltaMean > 0.05)
  const missing = compareWithPrevious(previous, { a: 1 }, 0.05)
  assert.equal(missing.ok, false)
  // Appending new ids never counts against the delta.
  const appended = { a: 1, b: 0, brandNew: 100 }
  assert.equal(compareWithPrevious(previous, appended, 0.05).ok, true)
})

test('T9: the full evaluation runs against the real files in under 2s', () => {
  const started = Date.now()
  const result = evaluate()
  const elapsed = Date.now() - started
  assert.ok(result.n >= 60, 'expected at least 60 examples, got ' + result.n)
  assert.equal(Object.keys(result.counts).reduce((sum, key) => sum + result.counts[key], 0), result.n)
  assert.equal(typeof result.meanCost, 'number')
  assert.ok(Number.isFinite(result.meanCost))
  assert.ok(result.signals.length > 0, 'signal breakdown must be populated')
  assert.ok(Array.isArray(result.sequences) && result.sequences.length >= 8)
  assert.equal(result.sequenceViolations.length, 0, JSON.stringify(result.sequenceViolations))
  assert.ok(elapsed < 2000, 'evaluation took ' + elapsed + 'ms')
})

test('signalBreakdown groups hits per label and sorts by frequency', () => {
  const scored = [
    { example: { id: '1', label: 'should_boost', text: 'a' }, score: 5, hits: ['design', 'code'] },
    { example: { id: '2', label: 'should_release', text: 'b' }, score: 0, hits: ['design'] },
    { example: { id: '3', label: 'ambiguous', text: 'c' }, score: 2, hits: ['why'] },
  ]
  const rows = signalBreakdown(scored)
  assert.equal(rows[0].signal, 'design')
  assert.equal(rows[0].fired, 2)
  assert.equal(rows[0].should_boost, 1)
  assert.equal(rows[0].should_release, 1)
  assert.equal(rows.find(row => row.signal === 'why').ambiguous, 1)
})

test('parseArgs: flags parse, unknown flags fail with usage', () => {
  const args = parseArgs(['--json', '--record', '--rationale', 'because', '--append-only-ref', 'origin/main'])
  assert.equal(args.json, true)
  assert.equal(args.record, true)
  assert.equal(args.rationale, 'because')
  assert.equal(args.appendOnlyRef, 'origin/main')
  assert.throws(() => parseArgs(['--frobnicate']), (error) => error instanceof InfraError && /unknown flag/.test(error.message))
  assert.throws(() => parseArgs(['--rationale']), (error) => error instanceof InfraError && /requires a value/.test(error.message))
})
