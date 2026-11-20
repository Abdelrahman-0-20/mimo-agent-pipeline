import test from 'node:test'
import assert from 'node:assert/strict'
import { restrictWithFallback } from '../src/scoping.js'

test('a clean restrict returns the disposer untouched', () => {
  const calls = []
  let disposerCount = 0
  const restrict = (filter) => {
    calls.push(filter)
    return () => { disposerCount += 1 }
  }
  const { disposer, dropped } = restrictWithFallback(restrict, ['a', 'b'])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { deny: ['a', 'b'] })
  assert.deepEqual(dropped, [])
  disposer()
  assert.equal(disposerCount, 1)
})

test('an unknown name is dropped and the restriction is retried once', () => {
  const calls = []
  const restrict = (filter) => {
    calls.push(filter)
    if (filter.deny.includes('ghost')) {
      throw new Error('tools.restrict() names unknown global tool "ghost"; known global tools: a, b')
    }
    return () => 'disposed'
  }
  const { disposer, dropped } = restrictWithFallback(restrict, ['a', 'ghost', 'b'])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].deny, ['a', 'b'])
  assert.deepEqual(dropped, ['ghost'])
  assert.equal(disposer(), 'disposed')
})

test('multiple unknown names are all parsed out', () => {
  const calls = []
  const restrict = (filter) => {
    calls.push(filter)
    if (filter.deny.includes('x') || filter.deny.includes('y')) {
      throw new Error('tools.restrict() names unknown global tools "x", "y"; known global tools: a')
    }
    return () => null
  }
  restrictWithFallback(restrict, ['a', 'x', 'y'])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].deny, ['a'])
})

test('unrelated restriction errors are rethrown untouched', () => {
  const restrict = () => { throw new Error('tools.restrict() requires a scoped context (agent.ctx)') }
  assert.throws(() => restrictWithFallback(restrict, ['a']), /scoped context/)

  const reserved = () => { throw new Error('tools.restrict() cannot name reserved PTC mode presentation transport "run_code"') }
  assert.throws(() => restrictWithFallback(reserved, ['run_code']), /reserved PTC/)
})

test('an error without the unknown-name marker is rethrown', () => {
  const restrict = () => { throw new Error('something odd about "ghost" happened') }
  assert.throws(() => restrictWithFallback(restrict, ['a']), /something odd/)
})
