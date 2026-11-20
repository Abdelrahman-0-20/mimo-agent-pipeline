import test from 'node:test'
import assert from 'node:assert/strict'
import { LockRegistry } from '../src/locks.js'
import {
  PHASES,
  lockForPhase,
  roleForPhase,
  HANDOFF_SCHEMAS,
  validateHandoff,
  plannerPrompt,
  builderPrompt,
  verifierPrompt,
  runRelay,
} from '../src/relay.js'

const WORKSPACE = '/repo'
const BASE = {
  task: 'Add a greet() function with tests',
  workspace: WORKSPACE,
  plannerModel: 'mimo-v2.6-pro',
  workerModel: 'mimo-v2.6-flash',
  plannerReasoningEffort: 'high',
  workerReasoningEffort: null,
  // Single-shot unless a retry test opts in: the recovery behavior is tested
  // explicitly below so every legacy expectation stays exact.
  phaseRetries: 0,
}

const PLAN = { files: ['src/greet.js', 'test/greet.test.js'], testPlan: 'npm test && npm run lint' }
const BUILD = { status: 'pass', summary: 'implemented; npm test && npm run lint exit 0' }
const CLEAN = { defects: [], summary: 'all green' }

/**
 * A scripted fake spawner: asserts each phase holds exactly its own lock
 * while running, records the call, and returns the scripted result.
 */
function fakeSpawn(script, { locks, observed } = {}) {
  const counts = {}
  return async ({ phase, role, prompt, model, reasoningEffort, outputSchema, signal }) => {
    observed?.push({ phase, role, prompt, model, reasoningEffort, outputSchema, signal })
    if (locks !== undefined) {
      for (const p of PHASES) {
        assert.equal(
          locks.isHeld(lockForPhase(p, WORKSPACE)),
          p === phase,
          `${phase} phase must hold exactly the ${p === phase ? 'matching' : 'non-matching'} lock`,
        )
      }
    }
    const sequence = script[role]
    // An array scripts one entry per call (retry scenarios); a plain value repeats.
    const entry = Array.isArray(sequence)
      ? sequence[(counts[role] = (counts[role] ?? 0) + 1) - 1]
      : sequence
    if (entry instanceof Error) throw entry
    if (entry !== undefined && entry.stopReason !== undefined && entry.stopReason !== 'completed') {
      return { structured: entry.structured, stopReason: entry.stopReason, diagnostic: entry.diagnostic, output: [] }
    }
    return { structured: entry?.structured, stopReason: 'completed', output: [] }
  }
}

const happyScript = { planner: { structured: PLAN }, builder: { structured: BUILD }, verifier: { structured: CLEAN } }

test('happy path runs plan → build → verify with roles, models, and locks', async () => {
  const locks = new LockRegistry()
  const observed = []
  const report = await runRelay({ ...BASE, locks, spawn: fakeSpawn(happyScript, { locks, observed }) })

  assert.equal(report.ok, true)
  assert.equal(report.phase, 'done')
  assert.deepEqual(report.plan, PLAN)
  assert.deepEqual(report.build, BUILD)
  assert.deepEqual(report.verify, CLEAN)
  assert.deepEqual(observed.map(o => o.phase), ['plan', 'build', 'verify'])
  assert.deepEqual(observed.map(o => o.role), ['planner', 'builder', 'verifier'])
  assert.deepEqual(observed.map(o => o.model), ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-flash'])
  assert.deepEqual(observed.map(o => o.reasoningEffort), ['high', null, null])
  for (const call of observed) {
    assert.deepEqual(call.outputSchema, HANDOFF_SCHEMAS[call.role])
    assert.ok(call.prompt.includes(BASE.task), 'every prompt carries the task')
  }
  assert.ok(observed[1].prompt.includes(PLAN.testPlan), 'builder prompt carries the test plan')
  assert.ok(observed[2].prompt.includes(BUILD.summary), 'verifier prompt carries the builder claim')
  assert.deepEqual(locks.snapshot(), {}, 'all locks released after a clean run')
})

test('a missing planner handoff aborts before the builder and releases locks', async () => {
  const locks = new LockRegistry()
  const observed = []
  const report = await runRelay({
    ...BASE,
    locks,
    spawn: fakeSpawn({ planner: { structured: undefined } }, { locks, observed }),
  })
  assert.equal(report.ok, false)
  assert.equal(report.phase, 'plan')
  assert.match(report.reason, /no structured handoff/)
  assert.equal(observed.length, 1, 'builder never runs')
  assert.deepEqual(locks.snapshot(), {})
})

test('an invalid planner testPlan fails the contract check', async () => {
  const locks = new LockRegistry()
  const report = await runRelay({
    ...BASE,
    locks,
    spawn: fakeSpawn({ planner: { structured: { files: ['a.js'], testPlan: '   ' } } }, { locks }),
  })
  assert.equal(report.ok, false)
  assert.equal(report.phase, 'plan')
  assert.match(report.reason, /testPlan/)
  assert.deepEqual(locks.snapshot(), {})
})

test('a builder failure stops the relay before verification', async () => {
  const locks = new LockRegistry()
  const observed = []
  const report = await runRelay({
    ...BASE,
    locks,
    spawn: fakeSpawn(
      { planner: { structured: PLAN }, builder: { structured: { status: 'fail', summary: 'lint still red' } } },
      { locks, observed },
    ),
  })
  assert.equal(report.ok, false)
  assert.equal(report.phase, 'build')
  assert.match(report.reason, /lint still red/)
  assert.equal(observed.length, 2, 'verifier never runs')
  assert.deepEqual(locks.snapshot(), {})
})

test('verifier defects fail the relay and are reported', async () => {
  const locks = new LockRegistry()
  const report = await runRelay({
    ...BASE,
    locks,
    spawn: fakeSpawn(
      { planner: { structured: PLAN }, builder: { structured: BUILD }, verifier: { structured: { defects: ['src/greet.js: ignores empty input', 'test/greet.test.js: missing case'], summary: 'not clean' } } },
      { locks },
    ),
  })
  assert.equal(report.ok, false)
  assert.equal(report.phase, 'verify')
  assert.match(report.reason, /2 defect/)
  assert.equal(report.verify.defects.length, 2)
  assert.deepEqual(locks.snapshot(), {})
})

test('a non-completed stopReason surfaces the diagnostic', async () => {
  const locks = new LockRegistry()
  const report = await runRelay({
    ...BASE,
    locks,
    spawn: fakeSpawn({ planner: { stopReason: 'error', diagnostic: 'model unreachable' } }, { locks }),
  })
  assert.equal(report.ok, false)
  assert.equal(report.phase, 'plan')
  assert.match(report.reason, /stopReason=error/)
  assert.match(report.reason, /model unreachable/)
  assert.deepEqual(locks.snapshot(), {})
})

test('a throwing spawn becomes a report and still releases locks', async () => {
  const locks = new LockRegistry()
  const report = await runRelay({
    ...BASE,
    locks,
    spawn: fakeSpawn({ planner: new Error('backend exploded') }, { locks }),
  })
  assert.equal(report.ok, false)
  assert.equal(report.phase, 'plan', 'the failing phase is named, not a generic error')
  assert.match(report.reason, /backend exploded/)
  assert.deepEqual(locks.snapshot(), {})
})

test('an aborted signal stops the relay before any spawn', async () => {
  const locks = new LockRegistry()
  const controller = new AbortController()
  controller.abort()
  const observed = []
  const report = await runRelay({
    ...BASE,
    locks,
    signal: controller.signal,
    spawn: fakeSpawn(happyScript, { locks, observed }),
  })
  assert.equal(report.ok, false)
  assert.equal(report.phase, 'error')
  assert.match(report.reason, /aborted/)
  assert.equal(observed.length, 0)
  assert.deepEqual(locks.snapshot(), {})
})

test('a hung phase times out at phaseTimeoutMs, fails the report, and releases locks', async () => {
  const locks = new LockRegistry()
  const spawn = () => new Promise(() => {}) // never settles
  const report = await runRelay({ ...BASE, locks, spawn, phaseTimeoutMs: 50 })
  assert.equal(report.ok, false)
  assert.equal(report.phase, 'plan')
  assert.match(report.reason, /timed out after 50ms/)
  assert.deepEqual(locks.snapshot(), {}, 'the reader lock is released on timeout')
})

test('concurrent relays never overlap the same connector', async () => {
  const locks = new LockRegistry()
  const active = { plan: 0, build: 0, verify: 0 }
  const max = { plan: 0, build: 0, verify: 0 }
  const spawn = async ({ phase, role }) => {
    active[phase]++
    max[phase] = Math.max(max[phase], active[phase])
    await new Promise(resolve => setTimeout(resolve, 5)) // yield so the rival relay reaches its acquire
    active[phase]--
    const scripted = { planner: PLAN, builder: BUILD, verifier: CLEAN }[role]
    return { structured: scripted, stopReason: 'completed', output: [] }
  }
  const [a, b] = await Promise.all([
    runRelay({ ...BASE, locks, spawn }),
    runRelay({ ...BASE, locks, spawn }),
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  // The guarantees: single-writer, single-browser, and readers serialize
  // with each other (reader vs writer overlap across relays is allowed —
  // cross-relay snapshot isolation is deferred beyond v0.5).
  assert.equal(max.build, 1, 'two builds never run concurrently')
  assert.equal(max.verify, 1, 'two verifies never run concurrently')
  assert.equal(max.plan, 1, 'reader lock serializes planners')
  assert.deepEqual(locks.snapshot(), {})
})

test('role deny lists never name a preset or essential tool', async () => {
  const { COMMON_TOOL_DENY, ROLE_TOOL_DENY } = await import('../src/index.js')
  // Tools a relay child must always keep: its preset-mounted tools (bash/fs/
  // search, context7), the session cwd tool, and the capture tool.
  const ESSENTIALS = [
    'bash', 'read', 'write', 'edit', 'apply_patch', 'grep', 'read_image',
    'working_directory', 'structured_output',
    'mcp__context7__query-docs', 'mcp__context7__resolve-library-id',
  ]
  for (const name of [...COMMON_TOOL_DENY, ...Object.values(ROLE_TOOL_DENY).flat()]) {
    assert.ok(!ESSENTIALS.includes(name), `deny must never name an essential tool: ${name}`)
    assert.ok(!name.includes('*'), 'restrict() takes exact names — wildcards would throw')
  }
  // Each role denies ONLY the host servers it does not preset-mount, so a
  // deny name can never collide with its own scoped connector of the same name.
  assert.ok(ROLE_TOOL_DENY.planner.every(n => n.startsWith('mcp__playwright__')), 'planner keeps github+memory')
  assert.ok(!ROLE_TOOL_DENY.planner.some(n => n.startsWith('mcp__github__') || n.startsWith('mcp__memory__')))
  assert.ok(ROLE_TOOL_DENY.verifier.every(n => n.startsWith('mcp__github__') || n.startsWith('mcp__memory__')), 'verifier keeps playwright')
  assert.ok(!ROLE_TOOL_DENY.verifier.some(n => n.startsWith('mcp__playwright__')))
  for (const role of ['scout', 'builder']) {
    assert.ok(ROLE_TOOL_DENY[role].some(n => n.startsWith('mcp__github__')))
    assert.ok(ROLE_TOOL_DENY[role].some(n => n.startsWith('mcp__playwright__')))
  }
})

test('phase and role mappings and prompt contracts', () => {
  assert.deepEqual(PHASES, ['plan', 'build', 'verify'])
  assert.equal(lockForPhase('plan', 'ws'), 'reader:ws')
  assert.equal(lockForPhase('build', 'ws'), 'writer:ws')
  assert.equal(lockForPhase('verify', 'ws'), 'browser:ws')
  assert.throws(() => lockForPhase('nope', 'ws'), RangeError)
  assert.equal(roleForPhase('plan'), 'planner')
  assert.equal(roleForPhase('build'), 'builder')
  assert.equal(roleForPhase('verify'), 'verifier')
  assert.throws(() => roleForPhase('nope'), RangeError)

  assert.ok(plannerPrompt('the task').includes('READ-ONLY'))
  assert.ok(builderPrompt('the task', PLAN).includes(PLAN.testPlan))
  assert.ok(verifierPrompt('the task', PLAN, BUILD).includes(BUILD.summary))
  assert.ok(verifierPrompt('the task', PLAN, BUILD).includes('never patch'))
  // prompts must drive the structured_output capture tool, not JSON-as-text,
  // and must forbid the delegate-and-wait pattern that ends a turn uncaptured
  for (const prompt of [plannerPrompt('t'), builderPrompt('t', PLAN), verifierPrompt('t', PLAN, BUILD)]) {
    assert.ok(prompt.includes('structured_output'), 'each prompt names the capture tool')
    assert.ok(prompt.includes('EXACTLY ONCE'), 'each prompt demands a single capture call')
    assert.ok(prompt.includes('never call mimo_relay'), 'each prompt forbids relay recursion')
  }
})

test('validateHandoff rejects malformed contracts', () => {
  assert.equal(validateHandoff('planner', undefined).ok, false)
  assert.equal(validateHandoff('planner', { files: 'nope', testPlan: 'x' }).ok, false)
  assert.equal(validateHandoff('planner', { files: [1], testPlan: 'x' }).ok, false)
  assert.equal(validateHandoff('planner', { files: [], testPlan: 'npm test' }).ok, true, 'an empty file list is a valid plan')
  assert.equal(validateHandoff('builder', { status: 'maybe', summary: 'x' }).ok, false)
  assert.equal(validateHandoff('builder', { status: 'pass', summary: '' }).ok, false)
  assert.equal(validateHandoff('verifier', { defects: 'none', summary: 'x' }).ok, false)
  assert.equal(validateHandoff('verifier', { defects: [], summary: 'clean' }).ok, true)
  assert.equal(validateHandoff('unknown', {}).ok, false)
})

test('contract failure retries once with a recovery prompt and can recover', async () => {
  const locks = new LockRegistry()
  const observed = []
  const report = await runRelay({
    ...BASE,
    phaseRetries: 1,
    spawn: fakeSpawn({
      planner: [{ stopReason: 'completed', structured: undefined }, { structured: PLAN }],
      builder: { structured: BUILD },
      verifier: { structured: CLEAN },
    }, { locks, observed }),
    locks,
  })
  assert.equal(report.ok, true)
  const plannerCalls = observed.filter((e) => e.role === 'planner')
  assert.equal(plannerCalls.length, 2)
  assert.match(plannerCalls[1].prompt, /\[relay recovery\]/)
  assert.match(plannerCalls[1].prompt, /status must be exactly "pass" or "fail"/)
  assert.match(plannerCalls[1].prompt, /no structured handoff/)
  assert.ok(plannerCalls[1].prompt.startsWith(plannerCalls[0].prompt), 'original prompt is preserved')
})

test('infra failure with a quota error cools off 60s before the retry', async () => {
  const sleeps = []
  const report = await runRelay({
    ...BASE,
    phaseRetries: 1,
    spawn: fakeSpawn({
      planner: [{ stopReason: 'error', diagnostic: '429: {"code":"429","message":"quota exhausted"}' }, { structured: PLAN }],
      builder: { structured: BUILD },
      verifier: { structured: CLEAN },
    }),
    locks: new LockRegistry(),
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(report.ok, true)
  assert.deepEqual(sleeps, [60_000])
})

test('exhausted retries return the last failure with an attempts count', async () => {
  const observed = []
  const report = await runRelay({
    ...BASE,
    phaseRetries: 1,
    spawn: fakeSpawn({ planner: [undefined, undefined] }, { observed }),
    locks: new LockRegistry(),
  })
  assert.equal(report.ok, false)
  assert.equal(report.phase, 'plan')
  assert.match(report.reason, /no structured handoff/)
  assert.equal(report.attempts, 2)
  assert.equal(observed.length, 2)
})

test('a builder legitimately reporting fail is NOT retried', async () => {
  const observed = []
  const report = await runRelay({
    ...BASE,
    phaseRetries: 1,
    spawn: fakeSpawn({
      planner: { structured: PLAN },
      builder: { structured: { status: 'fail', summary: 'real failure' } },
    }, { observed }),
    locks: new LockRegistry(),
  })
  assert.equal(report.ok, false)
  assert.match(report.reason, /real failure/)
  assert.equal(observed.filter((e) => e.role === 'builder').length, 1)
})

test('an already-aborted phase fails without spawning a child', async () => {
  const controller = new AbortController()
  const locks = new LockRegistry()
  let spawnCalls = 0
  const report = await runRelay({
    ...BASE,
    signal: controller.signal,
    locks,
    log: (message) => {
      // Abort right after the lock is held: the phase must then fail on the
      // abort guard without ever reaching startActivation. (An abort BEFORE
      // acquisition fails in locks.acquire instead, which is not this path.)
      if (message.includes('acquired')) controller.abort(new Error('outer aborted'))
    },
    spawn: async () => {
      spawnCalls += 1
      return { structured: PLAN, stopReason: 'completed', output: [] }
    },
  })
  assert.equal(report.ok, false)
  assert.equal(spawnCalls, 0, 'a doomed child must never be spawned')
  assert.ok(report.reason.includes('outer aborted'), report.reason)
  assert.deepEqual(locks.snapshot(), {})
})

test('a spawn rejection after a phase abort is observed, never unhandled', async () => {
  const unhandled = []
  const onUnhandled = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const controller = new AbortController()
    const locks = new LockRegistry()
    const report = await runRelay({
      ...BASE,
      signal: controller.signal,
      locks,
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
    assert.deepEqual(locks.snapshot(), {})
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})

test('a plain-object rejection is reported as JSON, not [object Object]', async () => {
  const locks = new LockRegistry()
  const report = await runRelay({
    ...BASE,
    locks,
    spawn: async () => { throw { kind: 'parent' } },
  })
  assert.equal(report.ok, false)
  assert.equal(report.phase, 'plan')
  assert.equal(report.reason, '{"kind":"parent"}')
  assert.deepEqual(locks.snapshot(), {})
})
