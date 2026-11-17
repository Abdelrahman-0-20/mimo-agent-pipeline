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
