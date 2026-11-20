import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PATHS, canonicalHash, loadGoldenSet, countLabels, sequenceProblems,
} from '../eval/run.mjs'

const { set, examples } = loadGoldenSet(DEFAULT_PATHS.golden)

test('golden set hash pins the content (tamper-evident)', () => {
  assert.equal(set.provenance.hash, canonicalHash(examples))
  assert.ok(set.provenance.hash.startsWith('sha256:'))
  assert.equal(set.protocolVersion, 'blind-dual-v1')
})

test('labels, ids, rationales, and sources are well-formed', () => {
  const ids = new Set()
  for (const example of examples) {
    assert.ok(!ids.has(example.id), 'duplicate id ' + example.id)
    ids.add(example.id)
    assert.ok(['should_boost', 'should_release', 'ambiguous'].includes(example.label), example.id)
    assert.ok(typeof example.rationale === 'string' && example.rationale.trim() !== '', example.id + ' needs a rationale')
    assert.ok(['synthetic', 'session-anon'].includes(example.source), example.id + ' needs a known source')
    assert.ok(typeof example.text === 'string' && example.text.trim() !== '', example.id)
  }
  assert.equal(ids.size, examples.length)
})

test('composition matches the actual labels and covers all three classes', () => {
  const counts = countLabels(examples)
  const { sequences: sequenceCount, ...labelComposition } = set.composition
  assert.deepEqual(labelComposition, counts)
  assert.equal(sequenceCount, set.sequences.length)
  assert.ok(counts.should_boost >= 25, 'expected >= 25 boost examples, got ' + counts.should_boost)
  assert.ok(counts.should_release >= 25, 'expected >= 25 release examples, got ' + counts.should_release)
  assert.ok(counts.ambiguous >= 8, 'expected >= 8 ambiguous examples, got ' + counts.ambiguous)
})

test('labeling provenance: two blind passes with recorded adjudication', () => {
  assert.equal(set.provenance.labelers, 2)
  assert.ok(set.provenance.note === undefined || typeof set.provenance.note === 'string')
  const adjudicated = examples.filter(example => example.adjudication !== null && example.adjudication !== undefined)
  assert.ok(set.provenance.adjudications === adjudicated.length,
    'provenance.adjudications (' + set.provenance.adjudications + ') must equal annotated examples (' + adjudicated.length + ')')
})

test('the session-anon tranche is present', () => {
  const session = examples.filter(example => example.source === 'session-anon')
  assert.ok(session.length >= 7, 'expected >= 7 session-anon examples, got ' + session.length)
})

test('texts are unique (no duplicate evidence)', () => {
  const seen = new Set()
  for (const example of examples) {
    assert.ok(!seen.has(example.text), 'duplicate text at ' + example.id)
    seen.add(example.text)
  }
})

test('sequences are well-formed and cover the design required families', () => {
  assert.ok(set.sequences.length >= 8, 'expected >= 8 sequences, got ' + set.sequences.length)
  const ids = new Set(examples.map(example => example.id))
  for (const seq of set.sequences) {
    const problems = sequenceProblems(seq, ids)
    assert.deepEqual(problems, [], 'sequence ' + seq.id + ': ' + problems.join('; '))
  }
  const restoreCount = set.sequences.filter(seq => seq.expect.some(actions => actions.includes('restore'))).length
  assert.ok(restoreCount >= 4, 'expected >= 4 sequences exercising restore, got ' + restoreCount)
  const toolCount = set.sequences.filter(seq => seq.steps.some(step => step.type === 'tool')).length
  assert.ok(toolCount >= 2, 'expected >= 2 tool sequences, got ' + toolCount)
  const modelCount = set.sequences.filter(seq => seq.steps.some(step => typeof step.modelOverride === 'string')).length
  assert.ok(modelCount >= 2, 'expected >= 2 model-change sequences, got ' + modelCount)
})
