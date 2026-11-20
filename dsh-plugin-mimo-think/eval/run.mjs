#!/usr/bin/env node
/**
 * eval/run.mjs — the mimo-think scorer eval harness (Phase 2 of eval/DESIGN.md).
 *
 * Pure-function, zero-dependency, deterministic: imports src/score.js and
 * src/boost.js directly (no spawn, no network, no model calls), scores the
 * frozen golden set in two contexts (fresh session / boosted post-TTL),
 * runs the label-derived sequence simulations through the REAL BoostPolicy
 * with an injected clock, and enforces the gate against eval/baseline.json.
 *
 * Exit codes (the CI contract):
 *   0  gate passed (or baseline recorded)
 *   1  eval regression / stale baseline / sequence violation / append-only breach
 *   2  eval infrastructure error (missing, corrupt, or inconsistent inputs) —
 *      message always names the cause AND the fix; never a bare stack trace
 *
 * Output contract:
 *   default        human summary on stdout (signal breakdown FIRST)
 *   --json         machine JSON on stdout, human summary on stderr
 *   --record       re-record the baseline (requires --rationale; refuses
 *                  regressions beyond delta against the previous baseline)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { scorePrompt } from '../src/score.js'
import { BoostPolicy } from '../src/boost.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

/** Eval infrastructure failure — exit 2. Message must name cause AND fix. */
export class InfraError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InfraError'
  }
}

export const DEFAULT_PATHS = {
  golden: join(HERE, 'golden_set.json'),
  costs: join(HERE, 'costs.json'),
  baseline: join(HERE, 'baseline.json'),
  config: join(HERE, '..', 'cordis.patch.yml'),
}

// --------------------------------------------------------------------------
// integrity: golden-set hashing, loading, threshold extraction
// --------------------------------------------------------------------------

/**
 * Canonical content hash of the examples array — the tamper-evidence pin.
 * @param {unknown[]} examples
 * @returns {string} "sha256:<hex>"
 */
export function canonicalHash(examples) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(examples)).digest('hex')
}

/**
 * Scorer fingerprint: sha256 of the two source files the eval measures.
 * Any edit to score.js/boost.js makes a recorded baseline stale (F7).
 * @returns {string} "sha256:<hex>"
 */
export function scorerFingerprint() {
  const hash = createHash('sha256')
  for (const file of ['score.js', 'boost.js']) {
    hash.update(file)
    hash.update(readFileSync(join(HERE, '..', 'src', file)))
  }
  return 'sha256:' + hash.digest('hex')
}

const VALID_LABELS = new Set(['should_boost', 'should_release', 'ambiguous'])
const VALID_ACTIONS = new Set(['boost', 'restore', 'none'])

/**
 * Load and fully validate the golden set (infra checks -> InfraError).
 * @param {string} path
 * @returns {{ set: object, examples: object[] }}
 */
export function loadGoldenSet(path) {
  if (!existsSync(path)) {
    throw new InfraError(
      'golden set not found at ' + path
      + ' — restore it: git checkout HEAD -- dsh-plugin-mimo-think/eval/golden_set.json',
    )
  }
  let set
  try {
    set = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new InfraError('golden set at ' + path + ' is not valid JSON (' + error.message
      + ') — restore it: git checkout HEAD -- dsh-plugin-mimo-think/eval/golden_set.json')
  }
  if (set === null || typeof set !== 'object' || !Array.isArray(set.examples) || !Array.isArray(set.sequences)) {
    throw new InfraError('golden set at ' + path + ' must be an object with "examples" and "sequences" arrays')
  }
  if (set.provenance?.hash !== canonicalHash(set.examples)) {
    throw new InfraError('golden set hash mismatch: provenance.hash says ' + String(set.provenance?.hash)
      + ' but content hashes to ' + canonicalHash(set.examples)
      + ' — the file was modified outside the append-only protocol; restore it or re-freeze via review')
  }
  const seen = new Set()
  for (const example of set.examples) {
    if (typeof example?.id !== 'string' || seen.has(example.id)) {
      throw new InfraError('golden set has a missing or duplicate example id: ' + String(example?.id))
    }
    seen.add(example.id)
    if (!VALID_LABELS.has(example.label)) {
      throw new InfraError('example ' + example.id + ' has invalid label ' + String(example.label)
        + ' — labels must be should_boost | should_release | ambiguous')
    }
    if (typeof example.text !== 'string' || example.text.trim() === '') {
      throw new InfraError('example ' + example.id + ' has empty text')
    }
  }
  const composition = set.composition ?? {}
  const actual = countLabels(set.examples)
  for (const label of VALID_LABELS) {
    if (composition[label] !== undefined && composition[label] !== actual[label]) {
      throw new InfraError('golden set composition.' + label + ' says ' + composition[label]
        + ' but the file contains ' + actual[label] + ' — re-record composition when appending')
    }
  }
  return { set, examples: set.examples }
}

/** @param {object[]} examples */
export function countLabels(examples) {
  const counts = { should_boost: 0, should_release: 0, ambiguous: 0 }
  for (const example of examples) counts[example.label] += 1
  return counts
}

/** Load costs.json + delta (infra checks). */
export function loadCosts(path) {
  if (!existsSync(path)) throw new InfraError('costs file not found at ' + path + ' — restore eval/costs.json from git')
  let costs
  try {
    costs = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new InfraError('costs file at ' + path + ' is not valid JSON (' + error.message + ')')
  }
  const w = costs?.weights
  if (w === null || typeof w !== 'object') throw new InfraError('costs file must contain a "weights" object')
  for (const key of ['missBoost', 'wrongRelease', 'falseBoost', 'stuckBoost', 'ambiguousBoost', 'ambiguousMiss', 'ambiguousHold']) {
    if (typeof w[key] !== 'number') throw new InfraError('costs.weights.' + key + ' must be a number')
  }
  // Asymmetry floor (F6): the ordering IS the claim.
  if (!(w.wrongRelease > w.missBoost && w.missBoost > w.falseBoost && w.falseBoost >= w.ambiguousBoost)) {
    throw new InfraError('cost weights break the asymmetry floor (wrongRelease > missBoost > falseBoost >= ambiguousBoost); got '
      + [w.wrongRelease, w.missBoost, w.falseBoost, w.ambiguousBoost].join(' > '))
  }
  const delta = typeof costs.delta === 'number' && costs.delta > 0 ? costs.delta : 0.05
  return { costs, weights: w, delta }
}

/**
 * Parse the effective thresholds from the plugin's cordis.patch.yml text.
 * Line-scoped to the mimo-think row (plain YAML, no !!js — verified).
 * @param {string} text
 * @returns {{ boostThreshold: number, releaseThreshold: number, boostTtlMinutes: number }}
 */
export function parseThresholds(text) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^\s*- id:\s*mimo-think\s*$/.test(line))
  if (start === -1) {
    throw new InfraError('no "mimo-think" row found in cordis.patch.yml — restore the bundle patch'
      + ' (git checkout HEAD -- dsh-plugin-mimo-think/cordis.patch.yml)')
  }
  const block = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*- id:\s*\S/.test(lines[i])) break
    block.push(lines[i])
  }
  const read = (key) => {
    const match = block.map(line => line.match(new RegExp('^\\s*' + key + ':\\s*(\\d+)\\s*$'))).find(Boolean)
    if (match === undefined) {
      throw new InfraError('"' + key + '" not found in the cordis.patch.yml mimo-think block'
        + ' — restore the config (git checkout HEAD -- dsh-plugin-mimo-think/cordis.patch.yml)'
        + ' or pass --config <path>')
    }
    return Number(match[1])
  }
  return {
    boostThreshold: read('boostThreshold'),
    releaseThreshold: read('releaseThreshold'),
    boostTtlMinutes: read('boostTtlMinutes'),
  }
}

/** @param {string} path */
export function extractThresholds(path) {
  if (!existsSync(path)) throw new InfraError('config not found at ' + path + ' — pass --config <path>')
  return parseThresholds(readFileSync(path, 'utf8'))
}

// --------------------------------------------------------------------------
// scoring, decisions, costs
// --------------------------------------------------------------------------

/**
 * Score every example once; both contexts and the signal breakdown share it.
 * @param {object[]} examples
 */
export function scoreAll(examples) {
  return examples.map(example => {
    const { score, hits } = scorePrompt(example.text)
    return { example, score, hits }
  })
}

/** Fresh (unboosted) session decision. */
export function decideFresh(score, th) {
  return score >= th.boostThreshold ? 'boost' : 'none'
}

/** Boosted session, TTL elapsed — the release-decision context. */
export function decideBoosted(score, th) {
  if (score >= th.boostThreshold) return 'boost'
  if (score <= th.releaseThreshold) return 'restore'
  return 'none'
}

/** RCU cost of one (label, decision) cell in the fresh context. */
export function freshCost(label, decision, w) {
  if (label === 'should_boost') return decision === 'boost' ? 0 : w.missBoost
  if (label === 'should_release') return decision === 'boost' ? w.falseBoost : 0
  return decision === 'boost' ? w.ambiguousBoost : w.ambiguousHold
}

/** RCU cost of one (label, decision) cell in the boosted post-TTL context. */
export function boostedCost(label, decision, w) {
  if (label === 'should_boost') return decision === 'restore' ? w.wrongRelease : 0
  if (label === 'should_release') {
    if (decision === 'restore') return 0
    if (decision === 'none') return w.stuckBoost
    return w.falseBoost
  }
  if (decision === 'boost') return w.ambiguousBoost
  if (decision === 'restore') return w.ambiguousMiss
  return w.ambiguousHold
}

/**
 * Both-context cost evaluation.
 * meanCost = (freshTotal + boostedTotal) / (2 * n) — average per example per
 * context, so per-id deltas stay comparable when the set grows.
 * @param {ReturnType<typeof scoreAll>} scored
 * @param {object} th thresholds
 * @param {object} w weights
 */
export function costModel(scored, th, w) {
  const perExample = {}
  const fresh = { cells: {}, total: 0 }
  const boosted = { cells: {}, total: 0 }
  const bump = (bucket, label, decision) => {
    const key = label + '/' + decision
    bucket.cells[key] = (bucket.cells[key] ?? 0) + 1
  }
  for (const { example, score } of scored) {
    const freshDecision = decideFresh(score, th)
    const boostedDecision = decideBoosted(score, th)
    const freshCell = freshCost(example.label, freshDecision, w)
    const boostedCell = boostedCost(example.label, boostedDecision, w)
    fresh.total += freshCell
    boosted.total += boostedCell
    bump(fresh, example.label, freshDecision)
    bump(boosted, example.label, boostedDecision)
    perExample[example.id] = (freshCell + boostedCell) / 2
  }
  const n = scored.length || 1
  return {
    meanCost: (fresh.total + boosted.total) / (2 * n),
    fresh,
    boosted,
    perExample,
  }
}

/**
 * Per-signal breakdown — ALWAYS emitted first (diagnosability principle).
 * @param {ReturnType<typeof scoreAll>} scored
 */
export function signalBreakdown(scored) {
  const bySignal = new Map()
  for (const { example, score, hits } of scored) {
    for (const signal of hits) {
      let row = bySignal.get(signal)
      if (row === undefined) {
        row = { signal, fired: 0, should_boost: 0, should_release: 0, ambiguous: 0, scoreSum: 0 }
        bySignal.set(signal, row)
      }
      row.fired += 1
      row[example.label] += 1
      row.scoreSum += score
    }
  }
  return [...bySignal.values()]
    .map(row => ({ ...row, avgScore: row.fired === 0 ? 0 : Math.round((row.scoreSum / row.fired) * 10) / 10 }))
    .sort((a, b) => b.fired - a.fired || a.signal.localeCompare(b.signal))
}

/** Seeded mulberry32 PRNG — determinism is part of the CLI contract. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Seeded bootstrap 95% CI over per-example costs (diagnostic, not gated).
 * @param {number[]} values
 * @param {{ iters?: number, seed?: number }} [options]
 * @returns {{ lo: number, hi: number }}
 */
export function bootstrapCI(values, { iters = 2000, seed = 42 } = {}) {
  if (values.length === 0) return { lo: 0, hi: 0 }
  const rand = mulberry32(seed)
  const means = []
  for (let i = 0; i < iters; i++) {
    let sum = 0
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(rand() * values.length)]
    means.push(sum / values.length)
  }
  means.sort((a, b) => a - b)
  return {
    lo: means[Math.floor(iters * 0.025)],
    hi: means[Math.floor(iters * 0.975)],
  }
}

// --------------------------------------------------------------------------
// sequence simulation — the real BoostPolicy, label-derived expectations
// --------------------------------------------------------------------------

const VALID_STEP_TYPES = new Set(['inbox', 'tool'])

/**
 * Validate a sequence entry's shape (used by tests and the loader).
 * @returns {string[]} problems (empty = valid)
 */
export function sequenceProblems(seq, exampleIds) {
  const problems = []
  if (typeof seq?.id !== 'string') problems.push('missing id')
  if (seq?.initial?.model === undefined) problems.push('missing initial.model')
  if (!Array.isArray(seq?.steps) || seq.steps.length === 0) problems.push('missing steps')
  if (!Array.isArray(seq?.expect) || seq.expect.length !== seq?.steps?.length) {
    problems.push('expect length must equal steps length')
    return problems
  }
  seq.steps.forEach((step, i) => {
    if (!VALID_STEP_TYPES.has(step.type)) problems.push('step ' + i + ': unknown type ' + String(step.type))
    if (step.type === 'inbox' && !exampleIds.has(step.exampleId)) problems.push('step ' + i + ': unknown example ' + String(step.exampleId))
    if (step.type === 'tool' && !['work', 'discovery'].includes(step.toolClass)) problems.push('step ' + i + ': toolClass must be work|discovery')
    for (const action of seq.expect[i] ?? []) {
      if (!VALID_ACTIONS.has(action)) problems.push('step ' + i + ': invalid expected action ' + String(action))
    }
    if ((seq.expect[i] ?? []).length === 0) problems.push('step ' + i + ': empty expectation')
  })
  return problems
}

/**
 * Run one sequence through the REAL BoostPolicy with an injected clock.
 * Expectations are label-derived (DESIGN.md 4.2) — never scorer-derived.
 * @param {object} seq
 * @param {Map<string, object>} textById
 * @param {string[]} seedTexts texts that score >= boostThreshold (for pre-boost seeding)
 * @param {object} th thresholds
 * @returns {{ id: string, violations: object[], actions: string[] }}
 */
export function runSequence(seq, textById, seedTexts, th) {
  const t0 = 1_700_000_000_000
  let now = t0
  const policy = new BoostPolicy({
    boostThreshold: th.boostThreshold,
    releaseThreshold: th.releaseThreshold,
    boostTtlMs: th.boostTtlMinutes * 60_000,
    now: () => now,
  })
  const state = { effort: seq.initial.effort, model: seq.initial.model }
  const applyDecisionState = (decision) => {
    if (decision?.action === 'boost') state.effort = 'high'
    else if (decision?.action === 'restore') state.effort = decision.effort
  }

  // Pre-boosted sequences are seeded with a real hard message so the policy
  // reaches the same active state a previous inbox boost would have left.
  if (seq.initial.boosted === true) {
    const seed = seedTexts[0]
    if (seed === undefined) {
      throw new InfraError('sequence ' + seq.id + ' needs a pre-boost seed but no example scores >= boostThreshold'
        + ' — add a clearly-hard example to the golden set')
    }
    const current = { model: state.model, ...(state.effort === undefined ? {} : { reasoningEffort: state.effort }) }
    applyDecisionState(policy.observe('seq', { kind: 'inbox', text: seed, current }))
  }

  const violations = []
  const actions = []
  seq.steps.forEach((step, i) => {
    now += Number.isFinite(step.advanceMs) ? step.advanceMs : 0
    if (typeof step.modelOverride === 'string') state.model = step.modelOverride
    let decision = null
    if (step.type === 'inbox') {
      const text = textById.get(step.exampleId)
      if (text === undefined) throw new InfraError('sequence ' + seq.id + ' step ' + i + ': unknown example ' + String(step.exampleId))
      const current = { model: state.model, ...(state.effort === undefined ? {} : { reasoningEffort: state.effort }) }
      decision = policy.observe('seq', { kind: 'inbox', text, current })
    } else {
      const effort = step.effortOverride !== undefined ? step.effortOverride : state.effort
      const current = { model: state.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
      decision = policy.observe('seq', { kind: 'tool', toolClass: step.toolClass, current })
    }
    applyDecisionState(decision)
    const action = decision === null ? 'none' : decision.action
    actions.push(action)
    const allowed = seq.expect[i] ?? []
    if (!allowed.includes(action)) {
      violations.push({ sequence: seq.id, step: i, action, allowed, ref: step.exampleId ?? step.toolClass })
    }
  })
  return { id: seq.id, violations, actions }
}

/**
 * Run every sequence; validate shapes first (infra on malformed entries).
 * @param {object[]} sequences
 * @param {ReturnType<typeof scoreAll>} scored
 * @param {object} th
 */
export function runSequences(sequences, scored, th) {
  const exampleIds = new Set(scored.map(row => row.example.id))
  const textById = new Map(scored.map(row => [row.example.id, row.example.text]))
  const seedTexts = scored.filter(row => row.score >= th.boostThreshold).map(row => row.example.text)
  const violations = []
  const perSeq = []
  for (const seq of sequences) {
    const problems = sequenceProblems(seq, exampleIds)
    if (problems.length > 0) {
      throw new InfraError('sequence ' + String(seq?.id) + ' is malformed: ' + problems.join('; '))
    }
    const result = runSequence(seq, textById, seedTexts, th)
    violations.push(...result.violations)
    perSeq.push({ id: result.id, actions: result.actions, ok: result.violations.length === 0 })
  }
  return { violations, perSeq }
}

// --------------------------------------------------------------------------
// append-only integrity (vs a git base ref)
// --------------------------------------------------------------------------

/**
 * Pure append-only diff: additions are fine; removals and mutations fail.
 * @param {object} oldSet parsed golden set from the base ref
 * @param {object} newSet current parsed golden set
 * @returns {object[]} violations
 */
export function diffAppendOnly(oldSet, newSet) {
  const violations = []
  const currentById = new Map((newSet.examples ?? []).map(example => [example.id, example]))
  for (const old of oldSet.examples ?? []) {
    const now = currentById.get(old.id)
    if (now === undefined) {
      violations.push({ id: old.id, problem: 'removed (golden set is append-only)' })
      continue
    }
    if (now.text !== old.text) violations.push({ id: old.id, problem: 'text mutated' })
    if (now.label !== old.label) violations.push({ id: old.id, problem: 'label mutated (' + old.label + ' -> ' + now.label + ')' })
  }
  return violations
}

/** Read the golden set from a git ref (thin plumbing around diffAppendOnly). */
export function goldenSetAtRef(ref) {
  const repoPath = relative(REPO_ROOT, DEFAULT_PATHS.golden).split('\\').join('/')
  let raw
  try {
    raw = execFileSync('git', ['show', ref + ':' + repoPath], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new InfraError('cannot read golden set at git ref "' + ref + '" (' + String(error.message).split('\n')[0] + ')'
      + ' — fetch the base first (CI needs actions/checkout with fetch-depth: 0), or drop --append-only-ref')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new InfraError('golden set at git ref "' + ref + '" is not valid JSON — the base branch copy is corrupt')
  }
}

// --------------------------------------------------------------------------
// baseline: stale detection, δ-guarded recording
// --------------------------------------------------------------------------

/** Factors the baseline pins; any drift = stale (F7). */
export function staleFactors(baseline, pins) {
  const stale = []
  if (baseline.goldenSetHash !== pins.goldenSetHash) stale.push('goldenSetHash')
  if (baseline.scorerFingerprint !== pins.scorerFingerprint) stale.push('scorerFingerprint')
  if (JSON.stringify(baseline.thresholds) !== JSON.stringify(pins.thresholds)) stale.push('thresholds')
  if (JSON.stringify(baseline.costWeights) !== JSON.stringify(pins.costWeights)) stale.push('costWeights')
  if (baseline.protocolVersion !== pins.protocolVersion) stale.push('protocolVersion')
  return stale
}

/**
 * δ-guarded comparison against the previous baseline (record mode).
 * Compares per-id costs over the ids the previous baseline already knew, so
 * appending new examples can never masquerade as a scorer regression.
 * @returns {{ ok: boolean, deltaMean: number, worst: object[] }}
 */
export function compareWithPrevious(previous, perExample, delta) {
  const rows = []
  let missing = []
  for (const [id, oldCost] of Object.entries(previous.exampleCosts ?? {})) {
    if (!(id in perExample)) {
      missing.push(id)
      continue
    }
    rows.push({ id, old: oldCost, now: perExample[id], diff: perExample[id] - oldCost })
  }
  if (missing.length > 0) {
    return { ok: false, deltaMean: Number.POSITIVE_INFINITY, worst: missing.map(id => ({ id, problem: 'present in baseline but missing now (removal?)' })), missing }
  }
  const deltaMean = rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.diff, 0) / rows.length
  const worst = rows.filter(row => row.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 10)
  return { ok: deltaMean <= delta, deltaMean, worst, missing: [] }
}

// --------------------------------------------------------------------------
// evaluation pipeline
// --------------------------------------------------------------------------

/**
 * Run the full evaluation. Throws InfraError for exit-2 conditions;
 * returns a structured result for gating.
 * @param {{ paths?: object, appendOnlyRef?: string | null }} [options]
 */
export function evaluate(options = {}) {
  const paths = { ...DEFAULT_PATHS, ...(options.paths ?? {}) }
  const startedAt = Date.now()
  const { set, examples } = loadGoldenSet(paths.golden)
  const { weights, delta } = loadCosts(paths.costs)
  const th = extractThresholds(paths.config)
  const scored = scoreAll(examples)
  const model = costModel(scored, th, weights)
  const signals = signalBreakdown(scored)
  const sequences = runSequences(set.sequences, scored, th)
  const ci = bootstrapCI(Object.values(model.perExample))

  // Sensitivity: recompute the full model under single-weight perturbations.
  const sensitivity = []
  for (const key of ['missBoost', 'falseBoost', 'wrongRelease']) {
    for (const factor of [0.5, 2]) {
      const perturbed = costModel(scored, th, { ...weights, [key]: weights[key] * factor })
      sensitivity.push({ key, factor, meanCost: perturbed.meanCost })
    }
  }

  const offenders = Object.entries(model.perExample)
    .map(([id, cost]) => ({ id, cost }))
    .filter(row => row.cost > 0)
    .sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id))
    .slice(0, 10)
    .map(row => {
      const found = examples.find(example => example.id === row.id)
      const { score, hits } = scorePrompt(found.text)
      return { id: row.id, cost: row.cost, label: found.label, score, hits, rationale: found.rationale ?? '' }
    })

  let appendOnly = null
  if (options.appendOnlyRef) {
    const oldSet = goldenSetAtRef(options.appendOnlyRef)
    const violations = diffAppendOnly(oldSet, set)
    appendOnly = { ref: options.appendOnlyRef, violations }
  }

  return {
    paths,
    protocolVersion: set.protocolVersion,
    goldenSetHash: canonicalHash(examples),
    scorerFingerprint: scorerFingerprint(),
    thresholds: th,
    costWeights: weights,
    delta,
    counts: countLabels(examples),
    n: examples.length,
    meanCost: model.meanCost,
    fresh: model.fresh,
    boosted: model.boosted,
    exampleCosts: model.perExample,
    bootstrap: ci,
    sensitivity,
    signals,
    sequences: sequences.perSeq,
    sequenceViolations: sequences.violations,
    appendOnly,
    offenders,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Gate an evaluation result against the baseline.
 * @returns {{ code: 0 | 1, reasons: string[] }}
 */
export function gate(result, baseline) {
  const reasons = []
  const pins = {
    goldenSetHash: result.goldenSetHash,
    scorerFingerprint: result.scorerFingerprint,
    thresholds: result.thresholds,
    costWeights: result.costWeights,
    protocolVersion: result.protocolVersion,
  }
  const stale = staleFactors(baseline, pins)
  if (stale.length > 0) {
    reasons.push('baseline is stale (' + stale.join(', ') + ') — after verifying the change, re-record:'
      + ' node eval/run.mjs --record --rationale "<why>"')
  }
  if (result.sequenceViolations.length > 0) {
    for (const violation of result.sequenceViolations) {
      reasons.push('sequence violation: ' + violation.sequence + ' step ' + violation.step
        + ' did ' + violation.action + ', allowed [' + violation.allowed.join(', ') + '] (' + String(violation.ref) + ')')
    }
  }
  if (result.appendOnly !== null && result.appendOnly.violations.length > 0) {
    for (const violation of result.appendOnly.violations) {
      reasons.push('append-only breach: ' + violation.id + ' ' + violation.problem)
    }
  }
  const recorded = typeof baseline.meanCost === 'number' ? baseline.meanCost : null
  if (stale.length === 0 && recorded !== null && result.meanCost > recorded * (1 + result.delta) + 1e-12) {
    reasons.push('meanCost ' + result.meanCost.toFixed(4) + ' exceeds baseline ' + recorded.toFixed(4)
      + ' x (1 + ' + result.delta + ')')
  }
  if (stale.length === 0 && recorded !== null && Math.abs(result.meanCost - recorded) > 1e-9) {
    reasons.push('meanCost drifted from baseline without a config change (baseline '
      + recorded.toFixed(6) + ', now ' + result.meanCost.toFixed(6) + ') — inputs changed outside the pinned factors')
  }
  return { code: reasons.length > 0 ? 1 : 0, reasons }
}

/** Load baseline.json (infra check). */
export function loadBaseline(path) {
  if (!existsSync(path)) {
    throw new InfraError('baseline not found at ' + path
      + ' — record the first baseline: node eval/run.mjs --record --rationale "initial freeze"')
  }
  try {
    const baseline = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof baseline.meanCost !== 'number' || baseline.exampleCosts === undefined) {
      throw new Error('missing meanCost/exampleCosts')
    }
    return baseline
  } catch (error) {
    throw new InfraError('baseline at ' + path + ' is corrupt (' + error.message
      + ') — restore it: git checkout HEAD -- dsh-plugin-mimo-think/eval/baseline.json')
  }
}

/**
 * Record mode: refuse regressions against the previous baseline (δ guard),
 * then write the new baseline. Returns reasons on refusal (exit 1).
 */
export function recordBaseline(result, rationale, baselinePath) {
  if (typeof rationale !== 'string' || rationale.trim() === '') {
    throw new InfraError('--record requires --rationale "<why this change is intentional>"'
      + ' — the rationale is stored in baseline.json as the audit trail')
  }
  if (result.sequenceViolations.length > 0) {
    return { code: 1, reasons: ['refusing to record: ' + result.sequenceViolations.length + ' sequence violation(s) — fix the policy/labels first'] }
  }
  if (result.appendOnly !== null && result.appendOnly.violations.length > 0) {
    return { code: 1, reasons: ['refusing to record: append-only breach — removals/mutations are never recordable'] }
  }
  if (existsSync(baselinePath)) {
    let previous
    try {
      previous = JSON.parse(readFileSync(baselinePath, 'utf8'))
    } catch {
      previous = null
    }
    if (previous !== null && previous.exampleCosts !== undefined) {
      const comparison = compareWithPrevious(previous, result.exampleCosts, result.delta)
      if (!comparison.ok) {
        return {
          code: 1,
          reasons: [
            'refusing to record: mean cost on previously-known examples regressed by '
            + comparison.deltaMean.toFixed(4) + ' RCU (delta allowed: ' + result.delta + ')',
            ...comparison.worst.map(row => '  worse: ' + row.id + ' ' + (row.old ?? '?') + ' -> ' + (row.now ?? 'missing')
              + (row.problem ? ' (' + row.problem + ')' : '')),
            'threshold/scorer/set changes that regress the eval cannot land (DESIGN.md gate rule)',
          ],
        }
      }
    }
  }
  const baseline = {
    recordedAt: new Date().toISOString(),
    rationale: rationale.trim(),
    protocolVersion: result.protocolVersion,
    goldenSetHash: result.goldenSetHash,
    scorerFingerprint: result.scorerFingerprint,
    thresholds: result.thresholds,
    costWeights: result.costWeights,
    delta: result.delta,
    meanCost: result.meanCost,
    exampleCosts: result.exampleCosts,
    sequenceViolations: 0,
    n: result.n,
  }
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf8')
  return { code: 0, reasons: ['baseline recorded (' + result.n + ' examples, meanCost ' + result.meanCost.toFixed(4) + ')'], baseline }
}

// --------------------------------------------------------------------------
// human output (signal breakdown FIRST — diagnosability principle)
// --------------------------------------------------------------------------

function pad(value, width) {
  const text = String(value)
  return text + ' '.repeat(Math.max(0, width - text.length))
}

/** @returns {string} */
export function renderHuman(result, verdict) {
  const lines = []
  lines.push('mimo-think eval — ' + result.n + ' examples (' + result.counts.should_boost + ' boost / '
    + result.counts.should_release + ' release / ' + result.counts.ambiguous + ' ambiguous), '
    + result.protocolVersion)
  lines.push('')
  lines.push('1) SIGNAL BREAKDOWN (diagnostic, always first)')
  lines.push('   ' + pad('signal', 16) + pad('fired', 7) + pad('on-boost', 10) + pad('on-release', 12) + pad('on-amb', 8) + 'avgScore')
  for (const row of result.signals) {
    lines.push('   ' + pad(row.signal, 16) + pad(row.fired, 7) + pad(row.should_boost, 10)
      + pad(row.should_release, 12) + pad(row.ambiguous, 8) + row.avgScore)
  }
  lines.push('')
  lines.push('2) COST-WEIGHTED CONFUSION (gated metric)')
  lines.push('   fresh context:     ' + JSON.stringify(result.fresh.cells) + '  total=' + result.fresh.total)
  lines.push('   boosted context:   ' + JSON.stringify(result.boosted.cells) + '  total=' + result.boosted.total)
  lines.push('   meanCost = ' + result.meanCost.toFixed(4) + ' RCU   bootstrap95% = ['
    + result.bootstrap.lo.toFixed(4) + ', ' + result.bootstrap.hi.toFixed(4) + ']')
  const envelope = result.sensitivity.map(row => row.meanCost.toFixed(3))
  lines.push('   sensitivity (single-weight x0.5/x2): min=' + Math.min(...result.sensitivity.map(r => r.meanCost)).toFixed(3)
    + ' max=' + Math.max(...result.sensitivity.map(r => r.meanCost)).toFixed(3) + ' [' + envelope.join(', ') + ']')
  lines.push('')
  lines.push('3) SEQUENCE SIMULATION (exact, zero-tolerance)')
  for (const seq of result.sequences) {
    lines.push('   ' + (seq.ok ? 'PASS' : 'FAIL') + ' ' + pad(seq.id, 28) + seq.actions.join(' -> '))
  }
  for (const violation of result.sequenceViolations) {
    lines.push('   VIOLATION ' + violation.sequence + ' step ' + violation.step + ': did ' + violation.action
      + ', allowed [' + violation.allowed.join(', ') + ']')
  }
  if (result.appendOnly !== null) {
    lines.push('   append-only vs ' + result.appendOnly.ref + ': '
      + (result.appendOnly.violations.length === 0 ? 'clean' : result.appendOnly.violations.length + ' breach(es)'))
  }
  lines.push('')
  lines.push('4) WORST OFFENDERS (cost > 0)')
  if (result.offenders.length === 0) lines.push('   none — every example lands on its label')
  for (const row of result.offenders) {
    lines.push('   ' + pad(row.id, 8) + pad(row.label, 15) + pad('score=' + row.score, 10)
      + pad('cost=' + row.cost.toFixed(1), 11) + '[' + row.hits.join(',') + '] ' + row.rationale)
  }
  lines.push('')
  lines.push('5) GATE: ' + (verdict.code === 0 ? 'PASS (exit 0)' : 'FAIL (exit ' + verdict.code + ')'))
  for (const reason of verdict.reasons) lines.push('   - ' + reason)
  lines.push('   thresholds: boost=' + result.thresholds.boostThreshold + ' release=' + result.thresholds.releaseThreshold
    + ' ttl=' + result.thresholds.boostTtlMinutes + 'm   delta=' + result.delta
    + '   scorer=' + result.scorerFingerprint.slice(0, 15) + '…')
  return lines.join('\n')
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const USAGE = [
  'usage: node eval/run.mjs [options]',
  '',
  '  --json                  machine JSON on stdout (human summary moves to stderr)',
  '  --record                re-record baseline.json (requires --rationale; refuses regressions)',
  '  --rationale <text>      why the record is intentional (stored in baseline.json)',
  '  --append-only-ref <ref> also check golden set append-only vs a git ref (needs fetch-depth: 0)',
  '  --golden <path>         override golden set path',
  '  --costs <path>          override costs path',
  '  --baseline <path>       override baseline path',
  '  --config <path>         override cordis.patch.yml path',
  '  --help                  this text',
  '',
  'exit: 0 gate passed | 1 regression/stale/violation | 2 infrastructure error (message names the fix)',
].join('\n')

export function parseArgs(argv) {
  const args = { json: false, record: false, rationale: null, appendOnlyRef: null, help: false, paths: {} }
  const take = (i, flag) => {
    const value = argv[i + 1]
    if (value === undefined) throw new InfraError(flag + ' requires a value — ' + USAGE.split('\n')[0])
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') args.json = true
    else if (arg === '--record') args.record = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--rationale') { args.rationale = take(i, arg); i += 1 }
    else if (arg === '--append-only-ref') { args.appendOnlyRef = take(i, arg); i += 1 }
    else if (arg === '--golden') { args.paths.golden = resolve(take(i, arg)); i += 1 }
    else if (arg === '--costs') { args.paths.costs = resolve(take(i, arg)); i += 1 }
    else if (arg === '--baseline') { args.paths.baseline = resolve(take(i, arg)); i += 1 }
    else if (arg === '--config') { args.paths.config = resolve(take(i, arg)); i += 1 }
    else throw new InfraError('unknown flag "' + arg + '" — ' + USAGE.split('\n')[0])
  }
  return args
}

export async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  const result = evaluate({ paths: args.paths, appendOnlyRef: args.appendOnlyRef })
  let verdict
  if (args.record) {
    verdict = recordBaseline(result, args.rationale, args.paths.baseline ?? DEFAULT_PATHS.baseline)
  } else {
    const baseline = loadBaseline(args.paths.baseline ?? DEFAULT_PATHS.baseline)
    verdict = gate(result, baseline)
  }
  const human = renderHuman(result, verdict)
  if (args.json) {
    console.log(JSON.stringify({ exitCode: verdict.code, reasons: verdict.reasons, result }, null, 2))
    console.error(human)
  } else {
    console.log(human)
  }
  return verdict.code
}

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error) => {
      if (error instanceof InfraError) {
        console.error('EVAL INFRA (exit 2): ' + error.message)
        process.exitCode = 2
      } else {
        console.error('EVAL CRASH (exit 2): ' + (error?.stack ?? error))
        process.exitCode = 2
      }
    },
  )
}
