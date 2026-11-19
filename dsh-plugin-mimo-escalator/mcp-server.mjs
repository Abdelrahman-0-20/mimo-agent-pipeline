#!/usr/bin/env node
/**
 * Standalone stdio MCP server for the MiMo escalator engine
 * (mimo-agent-pipeline v0.6 — the reach lever).
 *
 * The SAME pure engine the DSH plugin runs — src/state.js (2-strike
 * hysteresis) and src/store.js (durable role-keyed entries) — exposed over
 * newline-delimited JSON-RPC so Cursor, Claude Code, and VS Code can drive
 * escalation decisions for their own agents:
 *
 *   mescal_status         read persisted strikes/metrics for a workspace
 *   mescal_record_round   record one pass/fail verification round and get
 *                         back the hysteresis decision (escalate/demote/none)
 *
 * Zero dependencies: MCP's stdio subset (initialize / tools/list /
 * tools/call / ping) is implemented directly.
 *
 * Environment:
 *   MIMO_ESCALATOR_STATE            state file path (default ./mimo-escalator-state.json)
 *   MIMO_ESCALATOR_THRESHOLD        failed rounds to escalate (default 2)
 *   MIMO_ESCALATOR_DEMOTE_THRESHOLD passing rounds to demote (default 2)
 *   MIMO_ESCALATOR_TTL_HOURS        prune entries idle longer than this (default 72, 0 = keep)
 */
import { createInterface } from 'node:readline'
import { basename, join } from 'node:path'
import { EscalationState } from './src/state.js'
import { stateKeyFor } from './src/index.js'
import {
  applySnapshot,
  countRound,
  entryFor,
  loadStore,
  recordTransition,
  saveStore,
} from './src/store.js'

const SERVER_INFO = { name: 'mimo-escalator', version: '1.0.0' }
const PROTOCOL_FALLBACK = '2025-06-18'

const envInt = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

const statePath = process.env.MIMO_ESCALATOR_STATE || join(process.cwd(), 'mimo-escalator-state.json')
const threshold = envInt('MIMO_ESCALATOR_THRESHOLD', 2)
const demoteThreshold = envInt('MIMO_ESCALATOR_DEMOTE_THRESHOLD', 2)
const ttlHours = envInt('MIMO_ESCALATOR_TTL_HOURS', 72)

const TOOLS = [
  {
    name: 'mescal_status',
    description:
      'Read the MiMo escalator state: per-role strikes, escalation flags, round counters, and effort-toggle metrics '
      + 'persisted for a workspace. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace path or name to report on; omit for every entry in the state file.',
        },
      },
    },
  },
  {
    name: 'mescal_record_round',
    description:
      'Record one verification round (a test/lint/typecheck run that passed or failed) for <workspace>:<role> and '
      + 'return the hysteresis decision: "escalate" after ' + String(threshold) + ' consecutive failures '
      + '(switch this role to the strong model), "demote" after ' + String(demoteThreshold)
      + ' consecutive passes while escalated (return to the cheap model), otherwise "none". '
      + 'Pass fromModel/toModel when you apply a switch so the transition history stays accurate.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['role', 'failed'],
      properties: {
        workspace: { type: 'string', description: 'Workspace path or name (defaults to the server cwd).' },
        role: { type: 'string', description: 'Role key segment, e.g. "main" or "builder".' },
        failed: { type: 'boolean', description: 'true when the verification round failed (nonzero exit).' },
        fromModel: { type: 'string', description: 'Model you are switching away from, if applying a switch.' },
        toModel: { type: 'string', description: 'Model you are switching to, if applying a switch.' },
      },
    },
  },
]

function resolveKey(workspace, role) {
  const ws = workspace === undefined || workspace === '' ? process.cwd() : workspace
  return stateKeyFor(ws, role)
}

function statusPayload(params) {
  const store = loadStore(statePath, { ttlMs: ttlHours * 3_600_000 })
  const prefix = params?.workspace === undefined || params.workspace === ''
    ? null
    : `${basename(params.workspace)}:`
  const entries = {}
  for (const [key, entry] of Object.entries(store.sessions)) {
    if (prefix !== null && !key.startsWith(prefix)) continue
    entries[key] = {
      strikes: entry.strikes,
      passes: entry.passes,
      escalated: entry.escalated,
      rounds: entry.rounds,
      escalations: entry.escalations ?? 0,
      demotions: entry.demotions ?? 0,
      effort: entry.effort ?? null,
      firstSeen: entry.firstSeen ?? null,
      updatedAt: entry.updatedAt ?? null,
      history: entry.history ?? [],
    }
  }
  return { statePath, threshold, demoteThreshold, entries }
}

function recordRoundPayload(params) {
  const role = params?.role
  if (typeof role !== 'string' || role.trim() === '') throw badParams('role must be a non-empty string')
  if (typeof params.failed !== 'boolean') throw badParams('failed must be a boolean')
  const key = resolveKey(params.workspace, role)
  const now = Date.now()
  const store = loadStore(statePath, { ttlMs: ttlHours * 3_600_000 })
  const entry = entryFor(store, key, now)
  const state = new EscalationState({
    threshold,
    demoteThreshold,
    initial: { strikes: entry.strikes, passes: entry.passes, escalated: entry.escalated },
  })
  const { action } = state.recordRound(params.failed)
  applySnapshot(entry, state.snapshot(), now)
  countRound(entry, params.failed ? 'fail' : 'pass', now)
  if (action !== 'none') {
    const hasModels = typeof params.fromModel === 'string' && typeof params.toModel === 'string'
    if (hasModels) {
      if (action === 'escalate') entry.original = { model: params.fromModel }
      else entry.original = null
      recordTransition(entry, action, params.fromModel, params.toModel, now)
    }
    if (action === 'demote') entry.original = null
  }
  saveStore(statePath, store)
  return {
    key,
    action,
    strikes: entry.strikes,
    passes: entry.passes,
    escalated: entry.escalated,
    rounds: entry.rounds,
    applied: action !== 'none',
    note: action === 'escalate'
      ? `switch this role to your strong model now (${params.fromModel ?? 'current'} -> ${params.toModel ?? 'strong'})`
      : action === 'demote'
        ? `return this role to your cheap model (${params.fromModel ?? 'current'} -> ${params.toModel ?? 'cheap'})`
        : 'keep the current model',
  }
}

function badParams(message) {
  const error = new Error(message)
  error.code = -32602
  return error
}

function callTool(params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  if (name === 'mescal_status') return statusPayload(args)
  if (name === 'mescal_record_round') return recordRoundPayload(args)
  const error = new Error(`unknown tool: ${String(name)}`)
  error.code = -32602
  throw error
}

function dispatch(request) {
  const method = request?.method
  if (method === 'initialize') {
    return {
      protocolVersion: request.params?.protocolVersion ?? PROTOCOL_FALLBACK,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }
  }
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') {
    const payload = callTool(request.params)
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
  }
  if (method === 'ping') return {}
  const error = new Error(`method not found: ${String(method)}`)
  error.code = -32601
  throw error
}

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let request
  try {
    request = JSON.parse(trimmed)
  } catch {
    respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  const isNotification = request.id === undefined || request.id === null
  try {
    const result = dispatch(request)
    if (!isNotification) respond({ jsonrpc: '2.0', id: request.id, result })
  } catch (error) {
    if (!isNotification) {
      respond({ jsonrpc: '2.0', id: request.id, error: { code: error.code ?? -32603, message: error.message ?? String(error) } })
    }
  }
})
rl.on('close', () => {
  process.exit(0)
})
