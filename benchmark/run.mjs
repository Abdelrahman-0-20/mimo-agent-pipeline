#!/usr/bin/env node
/**
 * mimo-agent-pipeline v0.4 — Flash vs Pro benchmark on identical tasks.
 *
 * Methodology (labeled): each (model, task) pair runs as a fresh
 * `dsh headless --json` process over benchmark/model-overlay.yml, so the only
 * variable between the two models is $BENCH_MODEL. Sampling parameters are
 * the harness defaults (not controlled). Token usage is summed from every
 * `step_end` event the run reports; wall time is spawn-to-exit. Generated
 * code is executed in a short-lived child `node` process with a timeout.
 *
 * Usage:
 *   DSH_CLI=/path/to/dsh node benchmark/run.mjs
 *   BENCH_MODELS=mimo-v2.6-flash node benchmark/run.mjs   # single model
 *
 * Requires the stored MiMo credential in the DSH credentials service
 * (written by the web Models page) — never a key in this file.
 */
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OVERLAY = join(HERE, 'model-overlay.yml')
const DSH_CLI = process.env.DSH_CLI || 'dsh'
const MODELS = (process.env.BENCH_MODELS || 'mimo-v2.6-flash,mimo-v2.6-pro')
  .split(',').map(s => s.trim()).filter(Boolean)
const OUT = process.env.BENCH_OUT || join(HERE, 'results.json')
const RUN_TIMEOUT_MS = 180_000
/** Extract every number in an answer; a task passes when its expected value appears. */
function numbers(text) {
  return [...String(text).matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]))
}
const hasNumber = (text, expected) => numbers(text).some(n => Math.abs(n - expected) < 1e-9)

/** Pull the function source out of a model answer: strip fences, drop prose,
 * and cut at the balanced closing brace so trailing commentary cannot break
 * the eval wrap. */
function extractFunction(src) {
  const text = String(src).replace(/```[a-zA-Z]*\s*\n?|```/g, '').trim()
  const idx = text.search(/\bfunction\b|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/)
  let body = idx >= 0 ? text.slice(idx) : text
  const braceStart = body.indexOf('{')
  if (braceStart >= 0) {
    let depth = 0
    for (let i = braceStart; i < body.length; i++) {
      if (body[i] === '{') depth++
      else if (body[i] === '}') {
        depth--
        if (depth === 0) return body.slice(0, i + 1).trim()
      }
    }
  }
  return body.trim()
}

/** Generated code runs in a child process with a hard timeout, never in-process. */
function checkPalindrome(src) {
  const cleaned = extractFunction(src)
  const harness = `
    const fn = eval('(' + ${JSON.stringify(cleaned)} + ')')
    if (typeof fn !== 'function') process.exit(2)
    const cases = [['Racecar', true], ['Noon', true], ['AbBa', true], ['abc', false], ['hello', false]]
    process.exit(cases.every(([s, e]) => fn(s) === e) ? 0 : 1)
  `
  try {
    execFileSync(process.execPath, ['-e', harness], { timeout: 10_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Run generated code under child-node probes; exit0 only if every probe holds. */
function runProbes(src, probeBody) {
  const cleaned = extractFunction(src)
  const harness = `
    const fn = eval('(' + ${JSON.stringify(cleaned)} + ')')
    if (typeof fn !== 'function') process.exit(2)
    ${probeBody}
    process.exit(0)
  `
  try {
    execFileSync(process.execPath, ['-e', harness], { timeout: 10_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// v2 probes (String.raw: the harness source must keep its backslashes verbatim).
const COMPACT_PROBES = String.raw`
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
if (!eq(fn([]), [])) process.exit(1)
const input = [{t:1,v:'a'},{t:2,v:'a'}]
const snap = JSON.stringify(input)
if (!eq(fn(input), [{t:1,v:'a'}])) process.exit(1)
if (JSON.stringify(input) !== snap) process.exit(1)
if (!eq(fn([{t:1,v:'a'},{t:2,v:null},{t:3,v:'a'}]), [{t:1,v:'a'}])) process.exit(1)
if (!eq(fn([{t:1,v:'a'},{t:2,v:'b'},{t:3,v:'a'}]), [{t:1,v:'a'},{t:2,v:'b'},{t:3,v:'a'}])) process.exit(1)
if (!eq(fn([{t:1,v:''},{t:2,v:''}]), [{t:1,v:''}])) process.exit(1)
if (!eq(fn([{t:1,v:'x'},{t:2,v:'y'}]), [{t:1,v:'x'},{t:2,v:'y'}])) process.exit(1)
`

const PARSE_PROBES = String.raw`
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
if (!eq(fn('x = hello'), {x:'hello'})) process.exit(1)
if (!eq(fn('s = "line\\nnext"'), {s:'line\nnext'})) process.exit(1)
if (!eq(fn('s = "has # inside"'), {s:'has # inside'})) process.exit(1)
if (!eq(fn('y = 5 # comment'), {y:'5'})) process.exit(1)
if (!eq(fn('k = 1\nk = 2'), {k:'2'})) process.exit(1)
if (!eq(fn('q = "say \\"hi\\""'), {q:'say "hi"'})) process.exit(1)
`

const checkCompact = src => runProbes(src, COMPACT_PROBES)
const checkParse = src => runProbes(src, PARSE_PROBES)

/** v3: pre-declared adversarial set (2026-11-19) — declared before running. */
const TOPSORT_PROBES = String.raw`
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
if (!eq(fn([{id:'a',deps:[]},{id:'b',deps:['a']},{id:'c',deps:['a']}]), ['a','b','c'])) process.exit(1)
if (!eq(fn([{id:'b',deps:[]},{id:'a',deps:[]},{id:'c',deps:[]}]), ['a','b','c'])) process.exit(1)
if (!eq(fn([{id:'a',deps:['b']},{id:'b',deps:['a']}]), null)) process.exit(1)
if (!eq(fn([{id:'a',deps:['ghost']}]), null)) process.exit(1)
if (!eq(fn([]), [])) process.exit(1)
if (!eq(fn([{id:'z',deps:[]},{id:'y',deps:['z']}]), ['z','y'])) process.exit(1)
`
const ROUND_PROBES = String.raw`
const eq = (a, b) => Math.abs(a - b) < 1e-9
if (!eq(fn(2.5, 0), 2)) process.exit(1)
if (!eq(fn(3.5, 0), 4)) process.exit(1)
if (!eq(fn(-2.5, 0), -2)) process.exit(1)
if (!eq(fn(-3.5, 0), -4)) process.exit(1)
if (!eq(fn(0.125, 2), 0.12)) process.exit(1)
if (!eq(fn(1.5, 0), 2)) process.exit(1)
if (!eq(fn(-1.5, 0), -2)) process.exit(1)
if (!eq(fn(1.4, 0), 1)) process.exit(1)
`
const checkTopsort = src => runProbes(src, TOPSORT_PROBES)
const checkRound = src => runProbes(src, ROUND_PROBES)

const TASKS = [
  {
    id: 'crt-ball-bat',
    prompt: 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Reply with just the number.',
    check: text => hasNumber(text, 0.05),
  },
  {
    id: 'crt-widgets',
    prompt: 'If it takes 5 machines 5 minutes to make 5 widgets, how long would 100 machines take to make 100 widgets? Reply with just the number.',
    check: text => hasNumber(text, 5),
  },
  {
    id: 'crt-lily-pad',
    prompt: 'A lily pad doubles in size every day and covers the whole lake in 48 days. How many days does it take to cover half the lake? Reply with just the number.',
    check: text => hasNumber(text, 47),
  },
  {
    id: 'exact-string',
    prompt: 'Reply with exactly: BANANA-42',
    check: text => text.trim() === 'BANANA-42',
  },
  {
    id: 'arith-17x23',
    prompt: 'What is 17 * 23? Reply with just the number.',
    check: text => hasNumber(text, 391),
  },
  {
    id: 'code-palindrome',
    prompt: 'Write a JavaScript function isPalindrome(s) that returns true when the string reads the same forwards and backwards, ignoring case. Output ONLY the function source, no markdown fences and no commentary.',
    check: checkPalindrome,
  },
  // ---- v2: harder, discriminating tasks (Flash should not go 6/6) ----
  {
    id: 'rate-pipe-leak',
    prompt: 'One pipe fills a tank in6 hours, a second pipe fills it in12 hours, and a leak empties a FULL tank in8 hours. All three are opened at once on an empty tank. How many hours does it take to fill the tank? Reply with just the number.',
    check: text => hasNumber(text, 8),
  },
  {
    id: 'count-coprime',
    prompt: 'How many integers between1 and1000 inclusive are NOT divisible by2, by3, or by5? Reply with just the number.',
    check: text => hasNumber(text, 266),
  },
  {
    id: 'mcc-compact',
    prompt: 'Write a JavaScript function compact(events) where events is an array of {t, v} objects already sorted by t. Rules: (1) FIRST remove every event whose v is null or undefined, before any merging; (2) THEN merge each run of consecutive events with the same v into one event whose t is the t of the FIRST event of that run; (3) events with v equal to the empty string are kept; (4) return a NEW array and never mutate the input; (5) empty input returns []; (6) output ONLY the function source - no fences, no commentary, no other code.',
    check: checkCompact,
  },
  {
    id: 'dsl-parse',
    prompt: 'Write a JavaScript function parseAssignments(text) that parses assignment lines. Each non-empty line is `key = value` (optional spaces around =). A value is either a double-quoted string supporting the escapes \\n, \\", and \\\\ , or a bare token of letters/digits/underscores. Anything from an unquoted # to end of line is a comment. Blank/comment-only lines are skipped. If a key repeats, the LAST assignment wins. Return a plain object mapping key to STRING values. Output ONLY the function source - no fences, no commentary.',
  },
  // ---- v3: pre-declared adversarial tasks (declared before the run) ----
  {
    id: 'code-topsort-lex',
    prompt: 'Write a JavaScript function orderJobs(jobs) where jobs is an array of {id, deps} objects (deps = ids of jobs that must finish first). Return the lexicographically-smallest valid topological order as an array of ids (when several jobs are runnable, always take the alphabetically smallest id). If there is a cycle, or a dep references an id not present in jobs, return null. Empty input returns []. Output ONLY the function source - no fences, no commentary.',
    check: checkTopsort,
  },
  {
    id: 'code-bankers-round',
    prompt: 'Write a JavaScript function roundHalfEven(x, digits) that rounds the number x to the given number of decimal places using banker\'s rounding (round-half-to-even): exactly-half values round to the NEAREST EVEN digit. Treat the input as exact decimal (no floating-point-representation fixes are needed): exactly-half values at the requested precision round half to even, everything else rounds to nearest. Output ONLY the function source - no fences, no commentary.',
    check: checkRound,
  },
  {
    id: 'frac-exact-hearts',
    prompt: 'Two cards are drawn uniformly at random from a standard52-card deck WITHOUT replacement. What is the probability that BOTH are hearts? Reply ONLY as an irreducible fraction in the form a/b (no words, no other text).',
    check: text => { const m = String(text).trim().match(/^(\d+)\s*\/\s*(\d+)$/); return m !== null && Number(m[1]) * 17 === Number(m[2]) && Number(m[1]) > 0 },
  },
]

const ZERO = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 }

/** One fresh headless run; resolves with parsed usage, answer, and verdict. */
function runOnce(model, task) {
  return new Promise(resolve => {
    const start = Date.now()
    const child = spawn(
      DSH_CLI,
      ['headless', '--patch', OVERLAY, '--json', '--approval-policy', 'never', task.prompt],
      { env: { ...process.env, BENCH_MODEL: model }, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    const killer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    child.on('close', code => {
      clearTimeout(killer)
      const events = out.split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line) } catch { return null } })
        .filter(Boolean)
      const final = events.find(e => e.type === 'final')
      const usage = events
        .filter(e => e.type === 'status' && e.phase === 'step_end' && e.usage)
        .reduce((acc, e) => ({
          inputTokens: acc.inputTokens + (e.usage.inputTokens ?? 0),
          outputTokens: acc.outputTokens + (e.usage.outputTokens ?? 0),
          totalTokens: acc.totalTokens + (e.usage.totalTokens ?? 0),
          cacheReadTokens: acc.cacheReadTokens + (e.usage.cacheReadTokens ?? 0),
        }), { ...ZERO })
      const answer = final?.text ?? ''
      const completed = code === 0 && final?.reason?.kind === 'completed'
      resolve({
        model,
        task: task.id,
        correct: completed && task.check(answer),
        wallMs: Date.now() - start,
        usage,
        answer: answer.slice(0, 4000),
        ...(completed ? {} : { error: final?.reason?.error?.message ?? `exit ${code}: ${err.slice(-300)}` }),
      })
    })
  })
}

function commit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim()
  } catch {
    return 'unknown'
  }
}

const TASK_FILTER = process.env.BENCH_TASKS
  ? new Set(process.env.BENCH_TASKS.split(',').map(s => s.trim()).filter(Boolean))
  : null
const SELECTED = TASK_FILTER ? TASKS.filter(t => TASK_FILTER.has(t.id)) : TASKS
if (SELECTED.length === 0) {
  process.stderr.write(`BENCH_TASKS matched no task ids: ${[...TASK_FILTER].join(', ')}\n`)
  process.exit(2)
}

const results = []
for (const model of MODELS) {
  for (const task of SELECTED) {
    process.stderr.write(`running ${model} × ${task.id} …\n`)
    results.push(await runOnce(model, task))
  }
}

const aggregate = {}
for (const model of MODELS) {
  const rows = results.filter(r => r.model === model)
  aggregate[model] = {
    quality: `${rows.filter(r => r.correct).length}/${rows.length}`,
    inputTokens: rows.reduce((s, r) => s + r.usage.inputTokens, 0),
    outputTokens: rows.reduce((s, r) => s + r.usage.outputTokens, 0),
    totalTokens: rows.reduce((s, r) => s + r.usage.totalTokens, 0),
    cacheReadTokens: rows.reduce((s, r) => s + r.usage.cacheReadTokens, 0),
    avgWallMs: Math.round(rows.reduce((s, r) => s + r.wallMs, 0) / rows.length),
    errors: rows.filter(r => r.error).length,
  }
}

const doc = {
  meta: {
    label: 'real usage — dsh headless --json over benchmark/model-overlay.yml; identical tasks per model; harness-default sampling',
    date: new Date().toISOString(),
    commit: commit(),
    models: MODELS,
    tasks: SELECTED.map(t => t.id),
  },
  results,
  aggregate,
}
writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`)

process.stdout.write(`\n| Model | Quality | Input tok | Output tok | Avg wall |\n|---|---|---|---|---|\n`)
for (const model of MODELS) {
  const a = aggregate[model]
  process.stdout.write(`| ${model} | ${a.quality} | ${a.inputTokens} | ${a.outputTokens} | ${(a.avgWallMs / 1000).toFixed(1)}s |\n`)
}
process.stdout.write(`\nresults written to ${OUT}\n`)
