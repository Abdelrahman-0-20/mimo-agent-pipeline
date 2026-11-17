import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadStore } from '../src/store.js'

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp-server.mjs')

/** Spawn the server and expose a JSON-RPC request/notification client. */
function startServer(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let buffer = ''
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
  })
  let nextId = 1
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for ${method}`))
    }, 5_000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error !== undefined) {
        reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      } else {
        resolve(message.result)
      }
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const notify = (method) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }
  return { child, request, notify }
}

const toolText = (result) => JSON.parse(result.content[0].text)

test('initialize, tools/list, and notifications speak the MCP stdio subset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimo-mcp-'))
  const server = startServer({ MIMO_ESCALATOR_STATE: join(dir, 'state.json') })
  try {
    const init = await server.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    assert.equal(init.serverInfo.name, 'mimo-escalator')
    assert.equal(init.protocolVersion, '2025-06-18', 'the client protocol version is echoed')
    assert.ok(init.capabilities.tools)

    server.notify('notifications/initialized') // no response expected; the stream must keep working
    const list = await server.request('tools/list')
    assert.deepEqual(list.tools.map(t => t.name), ['mescal_status', 'mescal_record_round'])
    for (const tool of list.tools) {
      assert.equal(tool.inputSchema.type, 'object')
      assert.equal(typeof tool.description, 'string')
    }

    await assert.rejects(server.request('no/such/method'), (error) => error.code === -32601)
    server.child.stdin.write('this is not json\n')
    const after = await server.request('ping')
    assert.deepEqual(after, {}, 'parse errors do not kill the stream')
  } finally {
    server.child.stdin.end()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('record_round drives the same hysteresis engine end to end and persists it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimo-mcp-'))
  const statePath = join(dir, 'state.json')
  const server = startServer({ MIMO_ESCALATOR_STATE: statePath, MIMO_ESCALATOR_THRESHOLD: '2', MIMO_ESCALATOR_DEMOTE_THRESHOLD: '2' })
  try {
    // two failures → escalate (the editor should switch models now)
    const first = toolText(await server.request('tools/call', { name: 'mescal_record_round', arguments: { workspace: '/repo', role: 'main', failed: true } }))
    assert.equal(first.action, 'none')
    assert.equal(first.strikes, 1)
    const second = toolText(await server.request('tools/call', {
      name: 'mescal_record_round',
      arguments: { workspace: '/repo', role: 'main', failed: true, fromModel: 'cheap-model', toModel: 'strong-model' },
    }))
    assert.equal(second.action, 'escalate')
    assert.equal(second.escalated, true)
    assert.match(second.note, /strong-model/)

    // two passes → demote (back to the cheap model)
    const third = toolText(await server.request('tools/call', { name: 'mescal_record_round', arguments: { workspace: '/repo', role: 'main', failed: false } }))
    assert.equal(third.action, 'none')
    const fourth = toolText(await server.request('tools/call', {
      name: 'mescal_record_round',
      arguments: { workspace: '/repo', role: 'main', failed: false, fromModel: 'strong-model', toModel: 'cheap-model' },
    }))
    assert.equal(fourth.action, 'demote')
    assert.equal(fourth.escalated, false)

    // the file is the DSH plugin's own format: same store version, full history
    const store = loadStore(statePath, { ttlMs: 0 })
    const entry = store.sessions['repo:main']
    assert.ok(entry, 'entry keyed <workspace>:<role>')
    assert.equal(entry.rounds.fail, 2)
    assert.equal(entry.rounds.pass, 2)
    assert.equal(entry.escalations, 1)
    assert.equal(entry.demotions, 1)
    assert.deepEqual(entry.history.map(h => h.action), ['escalate', 'demote'])
    assert.equal(entry.original, null, 'the restore selection is cleared after demote')

    // status reads it back, scoped by workspace
    const status = toolText(await server.request('tools/call', { name: 'mescal_status', arguments: { workspace: '/repo' } }))
    assert.equal(status.threshold, 2)
    assert.ok(status.entries['repo:main'])
    assert.equal(status.entries['repo:main'].rounds.fail, 2)
    const other = toolText(await server.request('tools/call', { name: 'mescal_status', arguments: { workspace: '/elsewhere' } }))
    assert.deepEqual(other.entries, {}, 'other workspaces are not reported')
  } finally {
    server.child.stdin.end()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parameter and tool validation return JSON-RPC errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mimo-mcp-'))
  const server = startServer({ MIMO_ESCALATOR_STATE: join(dir, 'state.json') })
  try {
    await assert.rejects(
      server.request('tools/call', { name: 'mescal_record_round', arguments: { workspace: '/repo', failed: true } }),
      (error) => error.code === -32602 && /role/.test(error.message),
      'missing role is rejected',
    )
    await assert.rejects(
      server.request('tools/call', { name: 'nope', arguments: {} }),
      (error) => error.code === -32602,
      'unknown tool is rejected',
    )
  } finally {
    server.child.stdin.end()
    rmSync(dir, { recursive: true, force: true })
  }
})
