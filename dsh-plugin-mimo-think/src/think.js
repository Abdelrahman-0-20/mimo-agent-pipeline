/**
 * Deep-reasoning pass orchestration for dsh-plugin-mimo-think.
 *
 * Pure and spawner-injected, like the relay's runRelay: build the thinker's
 * prompt, race each attempt against its own deadline, validate the structured
 * handoff, and retry once with a recovery directive on the two failure
 * classes the relay actually observed (malformed handoff, infra death such as
 * quota/timeout). The spawner is injected so tests drive the sequence with
 * fakes; index.js binds it to the DSH subagents.startActivation backend.
 */

/** Structured-output contract enforced on the thinking child (object-rooted JSON Schema, enforced subset). */
export const THINK_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['analysis', 'answer', 'confidence', 'risks'],
  properties: {
    analysis: { type: 'string' },
    answer: { type: 'string' },
    confidence: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
})

/** Accepted confidence values (validated in code; the schema types it as a string). */
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low'])

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

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
 * Build the thinking child's prompt.
 * @param {{ question: string, context?: unknown, focus?: unknown }} input - the pass inputs.
 * @returns {string}
 */
export function thinkPrompt({ question, context, focus }) {
  const lines = [
    'You are the THINKER of dsh-plugin-mimo-think: one deep-reasoning pass over one hard question.',
    'You are READ-ONLY: never edit files and never run commands. Reading files to ground your reasoning is encouraged.',
    'Question: ' + question,
  ]
  if (nonEmpty(context)) lines.push('Context: ' + context)
  if (nonEmpty(focus)) lines.push('Focus: apply a ' + focus.trim() + ' lens to the analysis.')
  lines.push(
    'Think rigorously: restate the problem, enumerate the options and the criteria, weigh trade-offs and risks, test your conclusion against the constraints, then decide.',
    'Work in this turn only: never call mimo_think, mimo_relay, subagent tools, or scheduling tools; do not spawn background tasks, '
      + 'and do not end waiting for anything — keep using your own tools until you call structured_output; ending the turn without that call fails the think pass.',
    'When your analysis is ready, call the structured_output tool EXACTLY ONCE with '
      + '{"analysis": "<your step-by-step reasoning: options, criteria, trade-offs, why the answer wins>", '
      + '"answer": "<the direct final answer or recommendation>", '
      + '"confidence": "high" or "medium" or "low", '
      + '"risks": ["<remaining risks, unknowns, or follow-ups>"]}. '
      + 'Do not merely write the JSON as text; the tool call is the handoff.',
  )
  return lines.join('\n')
}

/**
 * Append the recovery directive to a failed pass's prompt (one retry covers
 * the failure classes actually observed).
 * @param {string} prompt - the original prompt.
 * @param {string} reason - why the previous attempt failed.
 * @returns {string}
 */
export function recoveryPrompt(prompt, reason) {
  return [
    prompt,
    '',
    '[think recovery] A previous attempt at this reasoning pass failed:',
    reason,
    'Produce the structured_output handoff directly for the same question. analysis and answer must be non-empty, '
      + 'confidence must be exactly "high", "medium", or "low", risks must be a list of strings, '
      + 'and this run must complete the pass.',
  ].join('\n')
}

/**
 * Validate one child's structured handoff against the contract.
 * @param {unknown} structured - the captured structured output.
 * @returns {{ ok: true, value: { analysis: string, answer: string, confidence: string, risks: string[] } } | { ok: false, reason: string }}
 */
export function validateThink(structured) {
  if (!isRecord(structured)) return { ok: false, reason: 'think child returned no structured handoff' }
  if (!nonEmpty(structured.analysis)) return { ok: false, reason: 'handoff.analysis must be a non-empty string' }
  if (!nonEmpty(structured.answer)) return { ok: false, reason: 'handoff.answer must be a non-empty string' }
  const confidence = typeof structured.confidence === 'string' ? structured.confidence.trim().toLowerCase() : ''
  if (!CONFIDENCE.includes(confidence)) {
    return { ok: false, reason: 'handoff.confidence must be one of high|medium|low' }
  }
  const risks = structured.risks === undefined ? [] : structured.risks
  if (!Array.isArray(risks) || risks.some(item => typeof item !== 'string')) {
    return { ok: false, reason: 'handoff.risks must be a list of strings' }
  }
  return {
    ok: true,
    value: {
      analysis: structured.analysis.trim(),
      answer: structured.answer.trim(),
      confidence,
      risks,
    },
  }
}

/** Abortable delay (a quota cool-off must not outlive the pass). */
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
 * Run one reasoning pass end to end.
 * @param {{
 *   question: string,
 *   context?: unknown,
 *   focus?: unknown,
 *   spawn(args: { prompt: string, outputSchema: object, signal?: AbortSignal }): Promise<{ structured?: unknown, stopReason: string, diagnostic?: string, output?: readonly unknown[] }>,
 *   timeoutMs?: number,
 *   retries?: number,
 *   signal?: AbortSignal,
 *   outputSchema?: object,
 *   sleep?(ms: number, signal?: AbortSignal): Promise<void>,
 *   log?(message: string): void,
 * }} input
 * @returns {Promise<{ ok: boolean, reason: string, result: object | null, attempts: number }>}
 */
export async function runThink(input) {
  const {
    question, context, focus, spawn,
    timeoutMs = 600_000,
    retries = 1,
    signal,
    outputSchema = THINK_SCHEMA,
    sleep = delay,
    log = () => {},
  } = input

  let prompt = thinkPrompt({ question, context, focus })
  let lastFailure = { ok: false, reason: 'think pass did not run' }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      log('retry ' + attempt + '/' + retries + ' after: ' + lastFailure.reason.slice(0, 140))
      if (/429|quota/i.test(lastFailure.reason)) {
        log('quota cool-off 60s')
        await sleep(60_000, signal)
      }
      prompt = recoveryPrompt(prompt, lastFailure.reason)
    }
    // Each attempt gets its own bounded signal and deadline: a hung child
    // can never outlive the pass budget.
    const attemptController = new AbortController()
    const onOuterAbort = () => attemptController.abort(signal.reason ?? new Error('think pass aborted'))
    if (signal !== undefined) {
      if (signal.aborted) onOuterAbort()
      else signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    const timer = setTimeout(
      () => attemptController.abort(new Error('think pass timed out after ' + timeoutMs + 'ms')),
      timeoutMs,
    )
    try {
      // An already-aborted attempt must not spawn a child: startActivation
      // throws ACTIVATION_CLOSING while the parent closes, and that child
      // promise would be orphaned by the race below. Fail with the abort
      // reason instead.
      if (attemptController.signal.aborted) {
        throw attemptController.signal.reason ?? new Error('think pass aborted')
      }
      const spawned = spawn({ prompt, outputSchema, signal: attemptController.signal })
      // The pass owns the deadline: race the spawn against the attempt signal
      // so even a spawn that ignores signals cannot overrun it. Attach the
      // spawn handlers BEFORE consulting the abort state: returning early
      // without them leaves `spawned` unhandled, and its later rejection is
      // an unhandled rejection that takes the whole process down.
      const result = await new Promise((resolve, reject) => {
        const onAbort = () => reject(attemptController.signal.reason ?? new Error('aborted'))
        spawned.then(
          (value) => { attemptController.signal.removeEventListener('abort', onAbort); resolve(value) },
          (error) => { attemptController.signal.removeEventListener('abort', onAbort); reject(error) },
        )
        if (attemptController.signal.aborted) {
          onAbort()
          return
        }
        attemptController.signal.addEventListener('abort', onAbort, { once: true })
      })
      if (result?.stopReason !== 'completed') {
        lastFailure = {
          ok: false,
          reason: 'think child ended with stopReason=' + String(result?.stopReason ?? 'unknown')
            + (result?.diagnostic ? ': ' + result.diagnostic : ''),
        }
        continue
      }
      const check = validateThink(result.structured)
      if (!check.ok) {
        lastFailure = check
        continue
      }
      if (attempt > 0) log('recovered on retry ' + attempt)
      return { ok: true, reason: '', result: check.value, attempts: attempt + 1 }
    } catch (error) {
      lastFailure = { ok: false, reason: reasonOf(error) }
      continue
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onOuterAbort)
    }
  }
  return { ok: false, reason: lastFailure.reason, result: null, attempts: retries + 1 }
}
