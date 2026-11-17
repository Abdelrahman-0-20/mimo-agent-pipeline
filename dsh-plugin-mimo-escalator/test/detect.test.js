import test from 'node:test'
import assert from 'node:assert/strict'
import { isVerificationCommand, roundOutcome } from '../src/index.js'

const bashExec = (command) => ({ name: 'bash', arguments: { command } })
const success = (value) => ({ isError: false, value })

test('recognizes verification commands', () => {
  const commands = [
    'npm test',
    'npm run test',
    'pnpm test',
    'yarn lint',
    'bun run check',
    'node --test test/',
    'cd dsh-plugin-mimo-escalator && npm test',
    'npx vitest run',
    'npx -y eslint .',
    'pytest -q',
    'python3 -m pytest tests/',
    'go test ./...',
    'cargo test',
    'tsc --noEmit',
    './verify.sh',
    'FOO=1 npm test',
    'time npm run typecheck',
  ]
  for (const command of commands) {
    assert.equal(isVerificationCommand(command), true, command)
  }
})

test('ignores commands that only mention tests or mask the exit code', () => {
  const commands = [
    'grep -rn "npm test" .',
    'echo npm test',
    'ls -la',
    'git log --oneline',
    'cat package.json',
    'bash -n install.sh',
    'npm run build',
    'npm test | tail -20', // tail owns the exit code — not trustworthy
    'npm test; echo done', // echo owns the exit code — not trustworthy
  ]
  for (const command of commands) {
    assert.equal(isVerificationCommand(command), false, command)
  }
})

test('foreground exit codes become pass/fail', () => {
  assert.equal(roundOutcome(bashExec('npm test'), success({ kind: 'foreground', exitCode: 0 })), 'pass')
  assert.equal(roundOutcome(bashExec('npm test'), success({ kind: 'foreground', exitCode: 1 })), 'fail')
  assert.equal(roundOutcome(bashExec('npm test'), success({ kind: 'foreground', exitCode: 127 })), 'fail')
})

test('a timeout counts as a failed round', () => {
  assert.equal(
    roundOutcome(bashExec('npm test'), success({ kind: 'foreground', exitCode: null, timedOut: true })),
    'fail',
  )
})

test('ambiguous outcomes are ignored', () => {
  assert.equal(roundOutcome(bashExec('npm test'), success({ kind: 'foreground', exitCode: null, signal: 'SIGTERM' })), null)
  assert.equal(roundOutcome(bashExec('npm test'), success({ kind: 'foreground', exitCode: 0, aborted: true })), null)
  assert.equal(roundOutcome(bashExec('npm test'), success({ kind: 'foreground', exitCode: 1, sandbox: { denied: true } })), null)
  assert.equal(roundOutcome(bashExec('npm test'), success({ kind: 'background', jobId: 'job-1' })), null)
  assert.equal(roundOutcome(bashExec('npm test'), { isError: true, error: {}, content: [] }), null)
})

test('non-verification and non-bash calls are ignored', () => {
  assert.equal(roundOutcome(bashExec('ls -la'), success({ kind: 'foreground', exitCode: 1 })), null)
  assert.equal(roundOutcome({ name: 'read', arguments: { file_path: 'x' } }, success({ kind: 'foreground', exitCode: 1 })), null)
  assert.equal(roundOutcome({ name: 'bash' }, success({ kind: 'foreground', exitCode: 1 })), null)
  assert.equal(roundOutcome(null, success({ kind: 'foreground', exitCode: 1 })), null)
})

// --- v0.4: GitHub CI status via the github MCP server ----------------------

const statusExec = { name: 'mcp__github__get_pull_request_status', arguments: { owner: 'o', repo: 'r', pull_number: 1 } }
const ciResult = (value) => ({ isError: false, value })

test('github CI status states classify as rounds', () => {
  assert.equal(roundOutcome(statusExec, ciResult({ state: 'success', statuses: [] })), 'pass')
  assert.equal(roundOutcome(statusExec, ciResult({ state: 'failure', statuses: [] })), 'fail')
  assert.equal(roundOutcome(statusExec, ciResult({ state: 'error' })), 'fail')
  assert.equal(roundOutcome(statusExec, ciResult({ state: 'pending', statuses: [] })), null)
  assert.equal(roundOutcome(statusExec, ciResult({ state: 'in_progress' })), null)
  assert.equal(roundOutcome(statusExec, ciResult({})), null)
})

test('ci payload parses from direct state, structuredContent, or text block', () => {
  assert.equal(roundOutcome(statusExec, ciResult({ structuredContent: { state: 'success' } })), 'pass')
  assert.equal(roundOutcome(statusExec, ciResult({ content: [{ type: 'text', text: '{"state":"failure"}' }] })), 'fail')
  assert.equal(roundOutcome(statusExec, ciResult({ content: [{ type: 'text', text: 'not json' }] })), null)
})

test('CI detection ignores errors, other MCP tools, and the off switch', () => {
  assert.equal(roundOutcome(statusExec, { isError: true, value: { state: 'failure' } }), null)
  assert.equal(roundOutcome({ name: 'mcp__github__get_pull_request', arguments: {} }, ciResult({ state: 'success' })), null)
  assert.equal(roundOutcome(statusExec, ciResult({ state: 'failure' }), { ciDetection: false }), null)
  assert.equal(roundOutcome(statusExec, ciResult({ state: 'success' }), { ciDetection: true }), 'pass')
})
