import test from 'node:test'
import assert from 'node:assert/strict'
import { LockRegistry } from '../src/locks.js'

test('acquire on a free lock resolves immediately and release frees it', async () => {
  const locks = new LockRegistry()
  const release = await locks.acquire('writer:repo', 'builder')
  assert.equal(locks.isHeld('writer:repo'), true)
  assert.equal(locks.holderOf('writer:repo'), 'builder')
  await release()
  assert.equal(locks.isHeld('writer:repo'), false)
  assert.equal(locks.holderOf('writer:repo'), null)
})

test('a second acquire queues FIFO and is granted on release', async () => {
  const locks = new LockRegistry()
  const first = await locks.acquire('writer:repo', 'builder-a')
  const granted = []
  const second = locks.acquire('writer:repo', 'builder-b').then(async (release) => {
    granted.push('b')
    await release()
  })
  const third = locks.acquire('writer:repo', 'builder-c').then(async (release) => {
    granted.push('c')
    await release()
  })
  assert.equal(locks.waiting('writer:repo'), 2)
  await first()
  await second
  await third
  assert.deepEqual(granted, ['b', 'c'], 'waiters are granted in FIFO order')
  assert.equal(locks.isHeld('writer:repo'), false)
})

test('release is idempotent and never frees a successor owner', async () => {
  const locks = new LockRegistry()
  const releaseA = await locks.acquire('browser:repo', 'verifier')
  const pending = locks.acquire('browser:repo', 'other')
  await releaseA()
  await releaseA() // double release: must be a no-op now that ownership transferred
  assert.equal(locks.holderOf('browser:repo'), 'other')
  const releaseB = await pending
  await releaseB()
  assert.equal(locks.isHeld('browser:repo'), false)
})

test('a queued waiter cancels through its AbortSignal', async () => {
  const locks = new LockRegistry()
  const release = await locks.acquire('writer:repo', 'builder')
  const controller = new AbortController()
  const waiting = locks.acquire('writer:repo', 'late', controller.signal)
  assert.equal(locks.waiting('writer:repo'), 1)
  controller.abort()
  await assert.rejects(waiting, /aborted/)
  assert.equal(locks.waiting('writer:repo'), 0)
  await release()
  assert.equal(locks.isHeld('writer:repo'), false)
})

test('acquire rejects immediately when the signal is already aborted', async () => {
  const locks = new LockRegistry()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(locks.acquire('reader:repo', 'x', controller.signal), /aborted/)
})

test('reader locks are exclusive in v0.5: a second reader queues', async () => {
  const locks = new LockRegistry()
  const release = await locks.acquire('reader:repo', 'planner')
  const pending = locks.acquire('reader:repo', 'scout')
  assert.equal(locks.waiting('reader:repo'), 1, 'readers serialize (parallel readers are deferred)')
  await release()
  const release2 = await pending
  assert.equal(locks.holderOf('reader:repo'), 'scout')
  await release2()
})

test('snapshot reports every held lock with its holder', async () => {
  const locks = new LockRegistry()
  const release = await locks.acquire('reader:repo', 'planner')
  assert.deepEqual(locks.snapshot(), { 'reader:repo': 'planner' })
  await release()
  assert.deepEqual(locks.snapshot(), {})
})
