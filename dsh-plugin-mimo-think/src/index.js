/**
 * dsh-plugin-mimo-think — mimo-agent-pipeline.
 *
 * The reasoning/thinking enhancer for Xiaomi MiMo on DeepSeek Harness:
 *
 *  1. PROACTIVE THINKING BOOST — every incoming user message (the
 *     agent/inbox/inserted event, which fires before claim/pre-step/step
 *     preparation, so agent.model.select() still governs the upcoming
 *     request) is scored for difficulty; a prompt at or above boostThreshold
 *     raises the session's reasoning effort to boostEffort. A trivial prompt
 *     at or below releaseThreshold, arriving boostTtlMinutes after the last
 *     hard one, restores the effort that was in effect before the boost.
 *  2. RE-ASSERT ON WORK — a completed tool result classified as work
 *     re-asserts an active boost when something (typically the escalator's
 *     discovery-off effort policy) lowered the effort underneath it;
 *     discovery results never re-assert, so thinking-off-on-discovery
 *     savings still apply while a boosted task is only reading.
 *  3. mimo_think TOOL — spawn a read-only thinker child (preset 'thinker',
 *     pinned to thinkModel at thinkReasoningEffort) that grounds its
 *     analysis in files and returns the structured handoff
 *     { analysis, answer, confidence, risks }, enforced by the spawn
 *     backend's outputSchema and validated again in src/think.js.
 *  4. mthink_status TOOL — read-only metrics: boost state, persisted
 *     counters, store diagnostics, and the effective config.
 *
 * Division of labor with dsh-plugin-mimo-escalator (no overlap, by design):
 * the escalator is REACTIVE and owns the model tier (2 failed verification
 * rounds -> Pro, hysteresis) plus thinking-off-on-discovery; this plugin is
 * PREDICTIVE and only owns the effort level of the current model — it never
 * switches models, never touches a selection it did not create, and never
 * counts verification rounds.
 *
 * Extension points, verified against the DSH source checkout:
 *  - 'agent/inbox/inserted' (packages/core/agent runtime-types) — a fresh
 *    user message, before claim/pre-step and step preparation.
 *  - 'tools/result' + agent.model.select() — the escalator's own pair,
 *    reused here for effort re-assertion between steps.
 *  - 'agent/created' + agentTools.restrict({deny}) with the fail-soft
 *    fallback in src/scoping.js (restrict() throws on unknown names).
 *  - subagents.startActivation (packages/subagent/subagent) with
 *    delivery 'caller', agentPreset, agentOptions, outputSchema — the
 *    relay's proven spawn pattern.
 */
import { basename, isAbsolute, join } from 'node:path'
import { BoostPolicy } from './boost.js'
import { messageText, toolClass } from './score.js'
import { THINK_SCHEMA, runThink } from './think.js'
import { restrictWithFallback } from './scoping.js'
import { entryFor, loadStore, recordBoost, recordRestore, recordThink, saveStore } from './store.js'

/**
 * Activate only after the tools service exists. Without this edge, a cold
 * boot can start this fiber in parallel with dsh-base's tools row: apply()
 * would then see ctx.get('tools') === undefined and the tools would silently
 * fail to register while the fiber reports active (the failure mode both
 * sibling plugins were hardened against).
 */
export const inject = ['tools']

/** The agent preset id this plugin's bundle declares for the reasoning child. */
export const THINKER_PRESET = 'thinker'

/** Globals no thinker child ever needs (the relay's verified-live set, plus this plugin's own tools). */
export const COMMON_TOOL_DENY = [
  'get_expert_team', 'list_expert_teams', 'list_experts',
  'summon_expert', 'summon_experts', 'summon_expert_team',
  'propose_custom_expert', 'open_custom_expert_editor',
  'propose_expert_team', 'open_expert_team_editor',
  'mescal_status', 'mimo_relay', 'mimo_think', 'mthink_status',
  'list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource',
  'subagent_claude_code', 'subagent_codex',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
]

const GITHUB_TOOLS = [
  'add_issue_comment', 'create_branch', 'create_issue', 'create_or_update_file',
  'create_pull_request', 'create_pull_request_review', 'create_repository', 'fork_repository',
  'get_file_contents', 'get_issue', 'get_pull_request', 'get_pull_request_comments',
  'get_pull_request_files', 'get_pull_request_reviews', 'get_pull_request_status',
  'list_commits', 'list_issues', 'list_pull_requests', 'merge_pull_request', 'push_files',
  'search_code', 'search_issues', 'search_repositories', 'search_users',
  'update_issue', 'update_pull_request_branch',
]

/** Host memory writes are denied; the read trio (search/open/read_graph) stays for grounding. */
const MEMORY_WRITE_TOOLS = [
  'add_observations', 'create_entities', 'create_relations',
  'delete_entities', 'delete_observations', 'delete_relations',
]

const PLAYWRIGHT_TOOLS = [
  'browser_click', 'browser_close', 'browser_console_messages', 'browser_drag', 'browser_drop',
  'browser_emulate_media', 'browser_evaluate', 'browser_file_upload', 'browser_fill_form',
  'browser_find', 'browser_handle_dialog', 'browser_hover', 'browser_navigate',
  'browser_navigate_back', 'browser_network_request', 'browser_network_requests',
  'browser_press_key', 'browser_resize', 'browser_run_code_unsafe', 'browser_select_option',
  'browser_snapshot', 'browser_tabs', 'browser_take_screenshot', 'browser_type', 'browser_wait_for',
]

const mcpNames = (server, toolList) => toolList.map(name => 'mcp__' + server + '__' + name)

/** Full thinker deny list: verified-present globals minus anything a reasoning pass could misuse. */
export const THINK_TOOL_DENY = [
  ...COMMON_TOOL_DENY,
  ...mcpNames('github', GITHUB_TOOLS),
  ...mcpNames('memory', MEMORY_WRITE_TOOLS),
  ...mcpNames('playwright', PLAYWRIGHT_TOOLS),
]

/** Top-level shape returned by the mimo_think tool. */
const THINK_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'reason', 'result', 'attempts', 'model', 'durationMs'],
  properties: {
    ok: { type: 'boolean' },
    reason: { type: 'string' },
    result: { oneOf: [{ type: 'object' }, { type: 'null' }] },
    attempts: { type: 'number' },
    model: { type: 'string' },
    durationMs: { type: 'number' },
  },
}

/** Plugin defaults; the Config schema fills every omitted field with these. */
const DEFAULTS = {
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
}

function issue(path, message) {
  return { path: [path], message }
}

function nonEmptyString(input, key, issues, value) {
  if (input[key] === undefined) return
  if (typeof input[key] !== 'string' || input[key].trim() === '') {
    issues.push(issue(key, key + ' must be a non-empty string'))
    return
  }
  value[key] = input[key]
}

function integerInRange(input, key, issues, value, min, max) {
  if (input[key] === undefined) return
  if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) {
    issues.push(issue(key, key + ' must be an integer between ' + min + ' and ' + max))
    return
  }
  value[key] = input[key]
}

/**
 * Config schema as a synchronous Standard Schema (what the Cordis fiber
 * reads through Config['~standard'].validate). Hand-rolled on purpose:
 * a profile-linked bundle resolves its imports from the checkout, so a
 * zero-dependency schema is the only one guaranteed to load everywhere.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'mimo-think',
    validate(raw) {
      if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
        return { issues: [{ path: [], message: 'config must be an object' }] }
      }
      const input = raw ?? {}
      const issues = []
      const value = { ...DEFAULTS }

      nonEmptyString(input, 'thinkModel', issues, value)
      nonEmptyString(input, 'boostEffort', issues, value)

      if (input.thinkReasoningEffort !== undefined) {
        if (input.thinkReasoningEffort === null) {
          value.thinkReasoningEffort = null
        } else if (typeof input.thinkReasoningEffort === 'string' && input.thinkReasoningEffort !== '') {
          value.thinkReasoningEffort = input.thinkReasoningEffort
        } else {
          issues.push(issue('thinkReasoningEffort', 'thinkReasoningEffort must be a non-empty string or null'))
        }
      }

      if (input.provider !== undefined) {
        if (input.provider === null) {
          value.provider = undefined
        } else if (typeof input.provider === 'string' && input.provider !== '') {
          value.provider = input.provider
        } else {
          issues.push(issue('provider', 'provider must be a non-empty string'))
        }
      }

      integerInRange(input, 'boostThreshold', issues, value, 1, 50)
      integerInRange(input, 'releaseThreshold', issues, value, 0, 49)
      if (value.releaseThreshold >= value.boostThreshold) {
        issues.push(issue('releaseThreshold', 'releaseThreshold must be < boostThreshold (hysteresis)'))
      }

      integerInRange(input, 'boostTtlMinutes', issues, value, 0, 1440)

      if (input.boostPresets !== undefined) {
        if (input.boostPresets !== 'main' && input.boostPresets !== 'all') {
          issues.push(issue('boostPresets', 'boostPresets must be "main" or "all"'))
        } else {
          value.boostPresets = input.boostPresets
        }
      }

      if (input.statePath !== undefined) {
        if (typeof input.statePath !== 'string') {
          issues.push(issue('statePath', 'statePath must be a string (empty disables persistence)'))
        } else {
          value.statePath = input.statePath
        }
      }

      integerInRange(input, 'stateTtlHours', issues, value, 0, 87_600)
      integerInRange(input, 'thinkTimeoutMs', issues, value, 60_000, 1_800_000)
      integerInRange(input, 'thinkRetries', issues, value, 0, 3)

      if (input.thinkReadOnly !== undefined) {
        if (typeof input.thinkReadOnly !== 'boolean') {
          issues.push(issue('thinkReadOnly', 'thinkReadOnly must be a boolean'))
        } else {
          value.thinkReadOnly = input.thinkReadOnly
        }
      }

      const known = new Set(Object.keys(DEFAULTS))
      for (const key of Object.keys(input)) {
        if (!known.has(key)) issues.push(issue(key, 'unknown option "' + key + '"'))
      }

      return issues.length > 0 ? { issues } : { value }
    },
  },
}

/**
 * Mount the reasoning enhancer: score incoming prompts and manage the
 * session's reasoning effort, scope thinker children, and expose the
 * mimo_think and mthink_status tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {object} config - validated row config.
 */
export function apply(ctx, config) {
  /** Boost decisions live in memory only (a fresh session starts unboosted). */
  const policy = new BoostPolicy({
    boostEffort: config.boostEffort,
    boostThreshold: config.boostThreshold,
    releaseThreshold: config.releaseThreshold,
    boostTtlMs: config.boostTtlMinutes * 60_000,
  })
  /** @type {Map<string, { store: object }>} */
  const stores = new Map()
  /** One think pass at a time per process — also stops runaway concurrency. */
  let activeThink = false
  /** Why the most recent think pass did or did not succeed (status diagnostics). */
  const diagnostics = { lastThink: null }

  /** The session's working directory, or undefined when it cannot be resolved. */
  const dirFor = (agent) => {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory === undefined) return undefined
    try {
      const dir = workingDirectory.get(agent.session)
      return typeof dir === 'string' && dir !== '' ? dir : undefined
    } catch {
      return undefined
    }
  }

  /** The agent's role: its preset id, or 'main' for default sessions. */
  const roleFor = (agent) => {
    const presets = ctx.get('agentPresets')
    try {
      return presets?.presetForSession?.(agent.session) ?? 'main'
    } catch {
      return 'main'
    }
  }

  /** Absolute store path for this workspace, or undefined when persistence is off. */
  const storePathFor = (dir) => {
    if (typeof config.statePath !== 'string' || config.statePath === '') return undefined
    if (isAbsolute(config.statePath)) return config.statePath
    if (dir === undefined) return undefined
    return join(dir, config.statePath)
  }

  /** Durable metrics domain: '<workspace>:<role>', like the escalator's keys. */
  const stateKeyFor = (dir, role) => {
    const ws = typeof dir === 'string' && dir !== '' ? basename(dir) : 'workspace'
    return ws + ':' + role
  }

  /** Load (once per path, TTL-pruned) the shared store file. */
  const slotFor = (path) => {
    let slot = stores.get(path)
    if (slot === undefined) {
      slot = { store: loadStore(path, { ttlMs: config.stateTtlHours * 3_600_000 }) }
      stores.set(path, slot)
    }
    return slot
  }

  /** Persist a metric mutation for one agent's domain (no-op when persistence is off). */
  const record = (agent, mutate) => {
    const dir = dirFor(agent)
    const path = storePathFor(dir)
    if (path === undefined) return
    try {
      const slot = slotFor(path)
      mutate(entryFor(slot.store, stateKeyFor(dir, roleFor(agent)), Date.now()))
      saveStore(path, slot.store)
    } catch (error) {
      console.warn('[mimo-think] metrics persistence failed:', error)
    }
  }

  /** Whether this session participates in the proactive boost (preset scoping). */
  const boostScoped = (agent) => config.boostPresets === 'all' || roleFor(agent) === 'main'

  /** Apply one boost-policy decision to the session (select + metrics + log). */
  const applyDecision = (agent, decision) => {
    if (decision === null) return
    const current = agent.model.current()
    if (current === undefined) return
    const key = stateKeyFor(dirFor(agent), roleFor(agent))
    if (decision.action === 'boost') {
      agent.model.select({ ...current, reasoningEffort: config.boostEffort })
      if (decision.first === true) {
        record(agent, entry => recordBoost(entry, decision.score, Date.now()))
      }
      console.info('[mimo-think] boost ' + key + ': effort -> ' + config.boostEffort
        + ' (score ' + decision.score + (decision.first === true ? '' : ', re-assert') + ')')
    } else if (decision.action === 'restore') {
      const selection = { ...current }
      if (decision.effort === undefined || decision.effort === null) delete selection.reasoningEffort
      else selection.reasoningEffort = decision.effort
      agent.model.select(selection)
      record(agent, entry => recordRestore(entry, decision.score, Date.now()))
      console.info('[mimo-think] restore ' + key + ': effort -> ' + (decision.effort ?? 'adapter default'))
    }
  }

  // 1) Proactive boost: fires before step preparation, so the select() below
  //    governs the very request this message will trigger.
  ctx.on('agent/inbox/inserted', (payload) => {
    try {
      const agent = payload?.agent
      if (agent === undefined || agent === null) return
      if (!boostScoped(agent)) return
      const current = agent.model.current()
      if (current === undefined) return
      const text = messageText(payload.message)
      if (text.trim() === '') return
      applyDecision(agent, policy.observe(agent.session.id, { kind: 'inbox', text, current }))
    } catch (error) {
      // An observer must never break inbox notification.
      console.warn('[mimo-think] inbox observation failed:', error)
    }
  })

  // 2) Re-assert on work: discovery results are ignored on purpose so the
  //    escalator's thinking-off-on-discovery savings survive a boost.
  ctx.on('tools/result', (exec) => {
    try {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return
      if (!boostScoped(agent)) return
      const current = agent.model.current()
      if (current === undefined) return
      const decision = policy.observe(agent.session.id, {
        kind: 'tool',
        toolClass: toolClass(exec?.name ?? ''),
        current,
      })
      applyDecision(agent, decision)
    } catch (error) {
      // An observer must never break tool-result notification.
      console.warn('[mimo-think] tool observation failed:', error)
    }
  })

  // 3) Fail-soft scoping for thinker children (restrict() throws on unknown
  //    names; the fallback drops exactly those and retries once).
  ctx.on('agent/created', async ({ agent }) => {
    try {
      if (config.thinkReadOnly !== true) return
      const presets = ctx.get('agentPresets')
      const preset = presets === undefined ? undefined : presets.presetForSession?.(agent.session)
      if (preset !== THINKER_PRESET) return
      const agentTools = agent.ctx.get('tools')
      if (agentTools === undefined) return
      const { disposer, dropped } = restrictWithFallback(
        agentTools.restrict.bind(agentTools),
        THINK_TOOL_DENY,
      )
      if (dropped.length > 0) {
        console.warn('[mimo-think] thinker scoping dropped unknown name(s): ' + dropped.join(', '))
      }
      if (disposer !== null) {
        console.info('[mimo-think] scoped thinker child: hid '
          + (THINK_TOOL_DENY.length - dropped.length) + ' irrelevant global tool schemas')
      }
    } catch (error) {
      console.warn('[mimo-think] tool scoping failed (child left unsliced):', error)
    }
  })

  const registerThinkTool = (tools) => {
    const toolTimeoutMs = config.thinkTimeoutMs * (config.thinkRetries + 1) + 60_000
    tools.register({
      name: 'mimo_think',
      description:
        'Run one deep-reasoning pass on a hard question: spawns a read-only MiMo Pro thinker at '
        + config.thinkReasoningEffort + ' that grounds its analysis in files and returns a structured '
        + '{analysis, answer, confidence, risks} verdict. Use it for design decisions, root-cause '
        + 'analysis, trade-off evaluation, or any question worth real thinking before acting.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['question'],
        properties: {
          question: {
            type: 'string',
            description: 'The hard question, decision, or analysis request.',
          },
          context: {
            type: 'string',
            description: 'Optional context: constraints, facts, file paths, prior attempts.',
          },
          focus: {
            type: 'string',
            description: 'Optional reasoning lens, e.g. analytical, creative, critique, risk.',
          },
        },
      },
      output: {
        schema: THINK_REPORT_SCHEMA,
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      timeoutMs: toolTimeoutMs,
      async execute(args, exec) {
        const startedAt = Date.now()
        const fail = (reason, attempts = 0) => ({
          ok: false,
          reason,
          result: null,
          attempts,
          model: config.thinkModel,
          durationMs: Date.now() - startedAt,
        })
        if (typeof args?.question !== 'string' || args.question.trim() === '') {
          return fail('question must be a non-empty string')
        }
        const parent = exec?.agent
        if (parent === undefined || parent === null) return fail('no calling agent')
        // Resolved at call time, never captured at apply (cold-boot fiber race).
        const subagents = ctx.get('subagents')
        if (subagents === undefined) return fail('subagents service unavailable (spawn backend not mounted)')
        if (activeThink) return fail('another think pass is already running in this process; retry when it finishes')

        const workingDirectory = ctx.get('workingDirectory')
        let workspace
        try {
          workspace = workingDirectory === undefined ? undefined : workingDirectory.get(parent.session)
        } catch {
          workspace = undefined
        }

        const spawn = async ({ prompt, outputSchema, signal }) => {
          const provider = config.provider ?? parent.model.current()?.provider
          const agentOptions = { model: config.thinkModel }
          if (provider !== undefined && provider !== null && provider !== '') agentOptions.provider = provider
          if (config.thinkReasoningEffort !== null && config.thinkReasoningEffort !== undefined) {
            agentOptions.reasoningEffort = config.thinkReasoningEffort
          }
          const activation = await subagents.startActivation({
            provider: 'spawn',
            label: 'mimo-think',
            parent,
            prompt: [{ type: 'text', text: prompt }],
            signal,
            delivery: 'caller',
            agentPreset: THINKER_PRESET,
            agentOptions,
            outputSchema,
            ...(workspace === undefined || workspace === '' ? {} : { cwd: workspace }),
          })
          // Race the child against the attempt signal: a hung child can never
          // outlive its deadline, and an aborted attempt disposes its child.
          return new Promise((resolve, reject) => {
            let settled = false
            const onAbort = () => {
              if (settled) return
              settled = true
              if (signal !== undefined) signal.removeEventListener('abort', onAbort)
              activation.dispose().catch(() => {}).then(() => {
                reject(signal?.reason ?? new Error('aborted'))
              })
            }
            if (signal?.aborted === true) {
              onAbort()
              return
            }
            signal?.addEventListener('abort', onAbort, { once: true })
            activation.result.then(
              (value) => {
                if (settled) return
                settled = true
                if (signal !== undefined) signal.removeEventListener('abort', onAbort)
                resolve(value)
              },
              (error) => {
                if (settled) return
                settled = true
                if (signal !== undefined) signal.removeEventListener('abort', onAbort)
                reject(error)
              },
            )
          })
        }

        activeThink = true
        diagnostics.lastThink = { startedAt: new Date(startedAt).toISOString(), status: 'running' }
        try {
          const report = await runThink({
            question: args.question.trim(),
            context: typeof args.context === 'string' ? args.context : undefined,
            focus: typeof args.focus === 'string' ? args.focus : undefined,
            spawn,
            timeoutMs: config.thinkTimeoutMs,
            retries: config.thinkRetries,
            signal: exec?.signal,
            outputSchema: THINK_SCHEMA,
            log: (message) => console.info('[mimo-think] ' + message),
          })
          record(parent, entry => recordThink(entry, report.ok, report.attempts, Date.now()))
          diagnostics.lastThink = {
            at: new Date().toISOString(),
            ok: report.ok,
            reason: report.reason,
            attempts: report.attempts,
          }
          return {
            ok: report.ok,
            reason: report.reason,
            result: report.result,
            attempts: report.attempts,
            model: config.thinkModel,
            durationMs: Date.now() - startedAt,
          }
        } catch (error) {
          const reason = error?.message ?? String(error)
          record(parent, entry => recordThink(entry, false, 1, Date.now()))
          diagnostics.lastThink = { at: new Date().toISOString(), ok: false, reason, attempts: 1 }
          return fail(reason, 1)
        } finally {
          activeThink = false
        }
      },
    })
  }

  const registerStatusTool = (tools) => {
    const configSummary = () => ({
      boostEffort: config.boostEffort,
      boostThreshold: config.boostThreshold,
      releaseThreshold: config.releaseThreshold,
      boostTtlMinutes: config.boostTtlMinutes,
      boostPresets: config.boostPresets,
      thinkModel: config.thinkModel,
      thinkReasoningEffort: config.thinkReasoningEffort,
    })
    tools.register({
      name: 'mthink_status',
      description: 'Report the MiMo think boost state, persisted boost/think metrics, and store diagnostics for this session. Read-only.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionId', 'stateKey', 'role', 'model', 'boost', 'metrics', 'storePath', 'persistence', 'diagnostics', 'config'],
          properties: {
            sessionId: { type: 'string' },
            stateKey: { type: 'string' },
            role: { type: 'string' },
            model: { oneOf: [{ type: 'object' }, { type: 'null' }] },
            boost: { oneOf: [{ type: 'object' }, { type: 'null' }] },
            metrics: { oneOf: [{ type: 'object' }, { type: 'null' }] },
            storePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            persistence: { type: 'string' },
            diagnostics: { type: 'object' },
            config: { type: 'object' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(_args, exec) {
        const base = {
          sessionId: '',
          stateKey: '',
          role: '',
          model: null,
          boost: null,
          metrics: null,
          storePath: null,
          persistence: 'no-agent',
          diagnostics: { ...diagnostics },
          config: configSummary(),
        }
        const agent = exec?.agent
        if (agent === undefined || agent === null) return base
        const dir = dirFor(agent)
        const role = roleFor(agent)
        const path = storePathFor(dir)
        let metrics = null
        if (path !== undefined) {
          try {
            const entry = entryFor(slotFor(path).store, stateKeyFor(dir, role), Date.now())
            metrics = {
              boosts: entry.boosts ?? 0,
              restores: entry.restores ?? 0,
              think: entry.think ?? null,
              lastScore: entry.lastScore ?? null,
              firstSeen: entry.firstSeen ?? null,
              updatedAt: entry.updatedAt ?? null,
              history: entry.history ?? [],
            }
          } catch {
            metrics = null
          }
        }
        return {
          sessionId: agent.session.id,
          stateKey: stateKeyFor(dir, role),
          role,
          model: agent.model.current() ?? null,
          boost: policy.stateOf(agent.session.id),
          metrics,
          storePath: path ?? null,
          persistence: config.statePath === '' ? 'disabled-by-config' : path === undefined ? 'unavailable' : 'active',
          diagnostics: { ...diagnostics },
          config: configSummary(),
        }
      },
    })
  }

  const tools = ctx.get('tools')
  if (tools === undefined) {
    console.warn('[mimo-think] tools service unavailable; mimo_think and mthink_status not registered')
  } else {
    registerThinkTool(tools)
    registerStatusTool(tools)
  }
}
