import test from 'node:test'
import assert from 'node:assert/strict'
import { messageText, scorePrompt, toolClass } from '../src/score.js'

/** The markdown code-fence marker, built without a literal backtick in source. */
const FENCE = String.fromCharCode(96).repeat(3)

test('messageText joins text blocks and ignores non-text blocks', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'x' }] }), 'hello')
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(messageText({ content: 'plain string' }), 'plain string')
  assert.equal(messageText({ text: 'field fallback' }), 'field fallback')
  assert.equal(messageText({ content: [{ type: 'image', data: 'x' }] }), '')
  assert.equal(messageText({ content: [{ type: 'tool_use', name: 'x' }] }), '')
  assert.equal(messageText(null), '')
  assert.equal(messageText('not an object'), '')
})

test('trivial prompts stay at or below the default release threshold', () => {
  for (const text of ['', 'hi', 'thanks!', 'ok', 'list the files', 'please continue', 'great work']) {
    const { score } = scorePrompt(text)
    assert.ok(score <= 1, JSON.stringify(text) + ' scored ' + score)
  }
})

test('a hard design prompt clears the default boost threshold', () => {
  const text = [
    'Design the migration architecture for our service: analyze the trade-offs of each option,',
    'we must move without downtime, the schema must stay compatible, and the security model must not weaken.',
    FENCE + 'js',
    'export const value = 1',
    FENCE,
    '1. dual-write',
    '2. backfill',
    '3. cut over',
    'Why could this fail? What breaks under load? Explain the rollback.',
  ].join('\n')
  const { score, hits } = scorePrompt(text)
  assert.ok(score >= 4, 'score ' + score + ' hits ' + JSON.stringify(hits))
  assert.ok(hits.includes('design'))
  assert.ok(hits.includes('code'))
  assert.ok(hits.includes('analysis'))
  assert.ok(hits.includes('security'))
})

test('the constraint signal is capped at 2', () => {
  const many = scorePrompt('must must must must must must must must')
  assert.equal(many.score, 2)
  assert.ok(many.hits.includes('constraint x2'))
  const few = scorePrompt('we must be careful')
  assert.equal(few.score, 1)
  assert.ok(few.hits.includes('constraint x1'))
})

test('two or more question marks fire the multi-question signal', () => {
  const { score, hits } = scorePrompt('Why? How? Who?')
  assert.ok(hits.includes('multi-question'))
  assert.ok(hits.includes('why'))
  assert.ok(score >= 2)
  assert.equal(scorePrompt('Is this fine?').hits.includes('multi-question'), false)
})

test('three or more bullet lines fire the multi-step signal', () => {
  const { hits } = scorePrompt('- one\n- two\n- three')
  assert.ok(hits.includes('multi-step'))
  assert.equal(scorePrompt('- one\n- two').hits.includes('multi-step'), false)
})

test('length ladder: short prompts get no length points, long ones get the most', () => {
  assert.equal(scorePrompt('tiny').hits.includes('length:short'), false)
  const short = scorePrompt('word '.repeat(30))
  assert.ok(short.hits.includes('length:short'))
  const medium = scorePrompt('word '.repeat(70))
  assert.ok(medium.hits.includes('length:medium'))
  const long = scorePrompt('word '.repeat(160))
  assert.ok(long.hits.includes('length:long'))
  assert.ok(long.score - medium.score >= 1)
})

test('toolClass splits pure reads from work', () => {
  assert.equal(toolClass('read'), 'discovery')
  assert.equal(toolClass('grep'), 'discovery')
  assert.equal(toolClass('glob'), 'discovery')
  assert.equal(toolClass('mthink_status'), 'discovery')
  assert.equal(toolClass('mcp__github__get_issue'), 'discovery')
  assert.equal(toolClass('mcp__context7__resolve-library-id'), 'discovery')
  assert.equal(toolClass('bash'), 'work')
  assert.equal(toolClass('write'), 'work')
  assert.equal(toolClass('edit'), 'work')
  assert.equal(toolClass('mimo_think'), 'work')
  assert.equal(toolClass('mcp__github__create_pull_request'), 'work')
  assert.equal(toolClass(undefined), 'work')
})
