/**
 * Pure orchestration for the Planner → Builder → verifier relay
 * (mimo-agent-pipeline v0.5).
 *
 * The handoff contract lives here as provider-captured `outputSchema`
 * objects: the planner returns `{files, testPlan}`, the builder returns
 * `{status, summary}` (pass only when every testPlan command exited 0), and
 * the verifier returns `{defects, summary}` (defects empty means clean —
 * and it never patches). Each phase runs under its connector lock for its
 * whole lifetime. The spawner is injected so tests drive the sequence with
 * fakes; index.js binds it to the DSH `spawn` subagent backend.
 */

/** Relay phases in execution order. */
export const PHASES = Object.freeze(['plan', 'build', 'verify'])

/** Lock identity for one phase within one workspace. */
export function lockForPhase(phase, workspace) {
  if (phase === 'plan') return `reader:${workspace}`
  if (phase === 'build') return `writer:${workspace}`
  if (phase === 'verify') return `browser:${workspace}`
  throw new RangeError(`unknown relay phase: ${phase}`)
}

/** Role (preset id) driving one phase. */
export function roleForPhase(phase) {
  if (phase === 'plan') return 'planner'
  if (phase === 'build') return 'builder'
  if (phase === 'verify') return 'verifier'
  throw new RangeError(`unknown relay phase: ${phase}`)
}

/**
 * Handoff schemas: object-rooted JSON Schema in the enforced subset the
 * `spawn` backend validates the child's final output against.
 */
export const HANDOFF_SCHEMAS = Object.freeze({
  planner: {
    type: 'object',
    additionalProperties: false,
    required: ['files', 'testPlan'],
    properties: {
      files: { type: 'array', items: { type: 'string' } },
      testPlan: { type: 'string' },
    },
  },
  builder: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary'],
    properties: {
      status: { type: 'string' },
      summary: { type: 'string' },
    },
  },
  verifier: {
    type: 'object',
    additionalProperties: false,
    required: ['defects', 'summary'],
    properties: {
      defects: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
  },
})

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0

/**
 * Human-readable failure text for any thrown value: its message when present,
 * JSON for the plain-object abort reasons DSH uses, String() as the last
 * resort — never the "[object Object]" String() alone produces.
 * @param {unknown} error - the caught rejection or thrown value.
 * @returns {string}
 */
const reasonOf = (error) => {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (isRecord(error)) {
    if (typeof error.message === 'string') return error.message
    try { return JSON.stringify(error) ?? String(error) } catch { /* circular */ }
  }
  return String(error)
}

/**
 * Validate one phase's structured handoff against the contract.
 * @param {'planner' | 'builder' | 'verifier'} role - contract owner.
 * @param {unknown} structured - the captured structured output.
 * @returns {{ ok: true, value: object } | { ok: false, reason: string }}
 */
export function validateHandoff(role, structured) {
  if (!isRecord(structured)) return { ok: false, reason: `${role} returned no structured handoff` }
  if (role === 'planner') {
    if (!Array.isArray(structured.files) || structured.files.some(f => typeof f !== 'string')) {
      return { ok: false, reason: 'planner handoff.files must be a list of strings' }
    }
    if (!nonEmpty(structured.testPlan)) {
      return { ok: false, reason: 'planner handoff.testPlan must be a non-empty string' }
    }
    return { ok: true, value: { files: structured.files, testPlan: structured.testPlan } }
  }
  if (role === 'builder') {
    if (structured.status !== 'pass' && structured.status !== 'fail') {
      return { ok: false, reason: 'builder handoff.status must be "pass" or "fail"' }
    }
    if (!nonEmpty(structured.summary)) {
      return { ok: false, reason: 'builder handoff.summary must be a non-empty string' }
    }
    return { ok: true, value: { status: structured.status, summary: structured.summary } }
  }
  if (role === 'verifier') {
    if (!Array.isArray(structured.defects) || structured.defects.some(d => typeof d !== 'string')) {
      return { ok: false, reason: 'verifier handoff.defects must be a list of strings' }
    }
    if (!nonEmpty(structured.summary)) {
      return { ok: false, reason: 'verifier handoff.summary must be a non-empty string' }
    }
    return { ok: true, value: { defects: structured.defects, summary: structured.summary } }
  }
  return { ok: false, reason: `unknown relay role: ${role}` }
}

/** The planner's contract: read-only, ends with the handoff via structured_output. */
export function plannerPrompt(task) {
  return [
    'You are the PLANNER of a three-role relay: planner -> builder -> verifier.',
    'You are READ-ONLY: never edit files, never run write commands, never install anything.',
    `Task: ${task}`,
    'Inspect what you need (repository layout, docs, CI), then decide exactly which files must be created or changed and how the work will be verified.',
    'Work in this turn only: never call mimo_relay, workflow, subagent_claude_code, or subagent_codex, do not spawn background tasks, and do not end waiting for anything — keep using your own tools until you call structured_output; ending the turn without that call fails the relay.',
    'When your plan is ready, call the structured_output tool EXACTLY ONCE with {"files": ["path", ...], "testPlan": "<concrete shell commands, separated by &&, that a later builder must run and see exit 0 — include test, lint, and typecheck>"}. Do not merely write the JSON as text; the tool call is the handoff.',
  ].join('\n')
}

/** The builder's contract: implement the plan, pass the plan's commands. */
export function builderPrompt(task, plan) {
  return [
    'You are the BUILDER of a three-role relay: planner -> builder -> verifier.',
    `Task: ${task}`,
    `Planner handoff — files to change: ${JSON.stringify(plan.files)}`,
    `Verification you must satisfy (every command must exit 0): ${plan.testPlan}`,
    'Implement only what the plan calls for. Run the testPlan commands and iterate until they all exit 0. Never weaken or delete a test to pass.',
    'Work in this turn only: never call mimo_relay, workflow, subagent_claude_code, or subagent_codex, do not spawn background tasks, and do not end waiting for anything — keep using your own tools until you call structured_output; ending the turn without that call fails the relay.',
    'When done, call the structured_output tool EXACTLY ONCE with {"status": "pass" | "fail", "summary": "<what changed and the testPlan result>"} — status is "pass" only when every testPlan command exited 0. Do not merely write the JSON as text.',
  ].join('\n')
}

/** The verifier's contract: run the plan, report defects, never patch. */
export function verifierPrompt(task, plan, build) {
  return [
    'You are the VERIFIER of a three-role relay: planner -> builder -> verifier.',
    `Task: ${task}`,
    `Planner handoff — files: ${JSON.stringify(plan.files)}; testPlan: ${plan.testPlan}`,
    `Builder's claim: ${build.status} — ${build.summary}`,
    'You are READ-ONLY: never patch anything. Run the testPlan yourself, inspect the changed files for correctness against the task, and report every defect you find.',
    'Run the testPlan FIRST with bash, in order. Stay on task: do not explore session logs, debug tooling, or take detours — if playwright or any optional tool fails, ignore it and continue with bash. As soon as the testPlan results and a quick file inspection are in hand, call structured_output.',
    'Work in this turn only: never call mimo_relay, workflow, subagent_claude_code, or subagent_codex, do not spawn background tasks, and do not end waiting for anything — keep using your own tools until you call structured_output; ending the turn without that call fails the relay.',
    'When finished, call the structured_output tool EXACTLY ONCE with {"defects": ["file: detail", ...], "summary": "<overall verdict>"} — defects is empty only when everything genuinely passes. Do not merely write the JSON as text.',
  ].join('\n')
}

/**
 * Append the recovery directive to a failed phase's prompt. One retry per
 * phase covers both failure classes we actually observed: a malformed
 * handoff (e.g. empty status) and an infra death (quota/timeout) — the
 * retrying child inspects existing work first instead of starting over.
 * @param {string} prompt - the original phase prompt.
 * @param {string} reason - why the previous attempt failed.
 * @returns {string}
 */
export function recoveryPrompt(prompt, reason) {
  return [
    prompt,
    '',
    '[relay recovery] A previous attempt at this phase failed:',
    reason,
    'Inspect any existing work first — if it already satisfies the task, produce the handoff directly; otherwise finish it. '
      + 'Your structured_output status must be exactly "pass" or "fail" (never empty), and this run must complete the phase.',
  ].join('\n')
}

/** Abortable delay (a quota cool-off must not outlive the relay). */
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted === true) {
    reject(signal.reason ?? new Error('aborted'))
    return
  }
  let timer
  const onAbort = () => {
    clearTimeout(timer)
    reject(signal.reason ?? new Error('aborted'))
  }
  timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  signal?.addEventListener('abort', onAbort, { once: true })
})

/**
 * Run one relay end to end.
 * @param {{
 *   task: string,
 *   workspace: string,
 *   locks: { acquire(name: string, holder?: string, signal?: AbortSignal): Promise<() => Promise<void>>, isHeld(name: string): boolean },
 *   spawn(args: { phase: string, role: string, prompt: string, model: string, reasoningEffort?: string, outputSchema: object, signal?: AbortSignal }): Promise<{ structured?: unknown, stopReason: string, diagnostic?: string, output?: readonly unknown[] }>,
 *   plannerModel: string,
 *   workerModel: string,
 *   plannerReasoningEffort?: string | null,
 *   workerReasoningEffort?: string | null,
 *   phaseTimeoutMs?: number,
 *   phaseRetries?: number,
 *   provider?: string,
 *   signal?: AbortSignal,
 *   sleep?(ms: number, signal?: AbortSignal): Promise<void>,
 *   log?(message: string): void,
 * }} input
 * @returns {Promise<object>} the relay report ({ok:false, phase, reason} on any failure; locks always released).
 */
export async function runRelay(input) {
  const {
    task, workspace, spawn, locks,
    plannerModel, workerModel,
    plannerReasoningEffort = null, workerReasoningEffort = null,
    phaseTimeoutMs = 600_000,
    phaseRetries = 1,
    signal, sleep = delay, log = () => {},
  } = input
  const held = []

  const runPhase = async (phase, initialPrompt, model, reasoningEffort) => {
    const lock = lockForPhase(phase, workspace)
    const role = roleForPhase(phase)
    const release = await locks.acquire(lock, role, signal)
    held.push(lock)
    log(`${phase}: acquired ${lock} (${role})`)
    try {
      let prompt = initialPrompt
      let lastFailure
      for (let attempt = 0; attempt <= phaseRetries; attempt++) {
        if (attempt > 0) {
          log(`${phase}: retry ${attempt}/${phaseRetries} after: ${lastFailure.reason.slice(0, 140)}`)
          if (/429|quota/i.test(lastFailure.reason)) {
            log(`${phase}: quota cool-off 60s`)
            await sleep(60_000, signal)
          }
          prompt = recoveryPrompt(prompt, lastFailure.reason)
        }
        // Each attempt gets its own bounded signal and deadline: a hung child
        // can never hold the connector past one phase budget.
        const phaseController = new AbortController()
        const onOuterAbort = () => phaseController.abort(signal.reason ?? new Error('relay aborted'))
        if (signal !== undefined) {
          if (signal.aborted) onOuterAbort()
          else signal.addEventListener('abort', onOuterAbort, { once: true })
        }
        const timer = setTimeout(
          () => phaseController.abort(new Error(`phase ${phase} timed out after ${phaseTimeoutMs}ms`)),
          phaseTimeoutMs,
        )
        try {
          // An already-aborted phase must not spawn a child: startActivation
          // throws ACTIVATION_CLOSING while the parent closes, and that child
          // promise would be orphaned by the race below. Fail with the abort
          // reason instead.
          if (phaseController.signal.aborted) {
            throw phaseController.signal.reason ?? new Error('relay phase aborted')
          }
          const spawned = spawn({
            phase, role, prompt, model, reasoningEffort,
            outputSchema: HANDOFF_SCHEMAS[role],
            signal: phaseController.signal,
          })
          // The relay owns the deadline: race the spawn against the phase
          // signal so even a spawn that ignores signals cannot overrun it.
          // Attach the spawn handlers BEFORE consulting the abort state:
          // returning early without them leaves `spawned` unhandled, and its
          // later rejection is an unhandled rejection that takes the whole
          // process down.
          const result = await new Promise((resolve, reject) => {
            const onAbort = () => reject(phaseController.signal.reason ?? new Error('aborted'))
            spawned.then(
              (value) => { phaseController.signal.removeEventListener('abort', onAbort); resolve(value) },
              (error) => { phaseController.signal.removeEventListener('abort', onAbort); reject(error) },
            )
            if (phaseController.signal.aborted) {
              onAbort()
              return
            }
            phaseController.signal.addEventListener('abort', onAbort, { once: true })
          })
          if (result.stopReason !== 'completed') {
            lastFailure = { ok: false, phase, reason: `${role} ended with stopReason=${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''}` }
            continue
          }
          const check = validateHandoff(role, result.structured)
          if (!check.ok) {
            lastFailure = { ok: false, phase, reason: check.reason }
            continue
          }
          if (attempt > 0) log(`${phase}: recovered on retry ${attempt}`)
          return { value: check.value }
        } catch (error) {
          lastFailure = { ok: false, phase, reason: reasonOf(error) }
          continue
        } finally {
          clearTimeout(timer)
          if (signal !== undefined) signal.removeEventListener('abort', onOuterAbort)
        }
      }
      return { failed: { ...lastFailure, attempts: phaseRetries + 1 } }
    } finally {
      await release()
      held.pop()
      log(`${phase}: released ${lock}`)
    }
  }

  try {
    const planResult = await runPhase('plan', plannerPrompt(task), plannerModel, plannerReasoningEffort)
    if ('failed' in planResult) return planResult.failed
    const plan = planResult.value

    const buildResult = await runPhase('build', builderPrompt(task, plan), workerModel, workerReasoningEffort)
    if ('failed' in buildResult) return buildResult.failed
    const build = buildResult.value
    if (build.status !== 'pass') {
      return { ok: false, phase: 'build', reason: `builder reported failure: ${build.summary}`, plan }
    }

    const verifyResult = await runPhase('verify', verifierPrompt(task, plan, build), workerModel, workerReasoningEffort)
    if ('failed' in verifyResult) return { ...verifyResult.failed, plan, build }
    const verify = verifyResult.value
    if (verify.defects.length > 0) {
      return { ok: false, phase: 'verify', reason: `verifier found ${verify.defects.length} defect(s)`, plan, build, verify }
    }

    log('relay complete: plan -> build -> verify all clean')
    return { ok: true, phase: 'done', reason: '', plan, build, verify }
  } catch (error) {
    return {
      ok: false,
      phase: 'error',
      reason: reasonOf(error),
      heldLocks: held.slice(),
    }
  }
}
