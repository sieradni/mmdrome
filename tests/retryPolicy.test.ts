import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RetryPolicy } from '../src/lib/playbackCore/retryPolicy'

test('retryPolicy: web config — 3 retries at 1s/2s/4s then give-up', () => {
  const p = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 1000 })
  assert.deepEqual(p.onError(), { kind: 'retry', attempt: 1, delayMs: 1000 })
  assert.deepEqual(p.onError(), { kind: 'retry', attempt: 2, delayMs: 2000 })
  assert.deepEqual(p.onError(), { kind: 'retry', attempt: 3, delayMs: 4000 })
  assert.deepEqual(p.onError(), { kind: 'give-up' })
})

test('retryPolicy: native config — 2 retries at 1s/2s then give-up', () => {
  const p = new RetryPolicy({ maxAttempts: 2, baseDelayMs: 1000 })
  assert.deepEqual(p.onError(), { kind: 'retry', attempt: 1, delayMs: 1000 })
  assert.deepEqual(p.onError(), { kind: 'retry', attempt: 2, delayMs: 2000 })
  assert.deepEqual(p.onError(), { kind: 'give-up' })
})

test('retryPolicy: bg config (max 0) gives up on the first error', () => {
  const p = new RetryPolicy({ maxAttempts: 0, baseDelayMs: 1000 })
  assert.deepEqual(p.onError(), { kind: 'give-up' })
  assert.equal(p.attemptCount, 1)
})

test('retryPolicy: give-up is terminal until reset', () => {
  const p = new RetryPolicy({ maxAttempts: 1, baseDelayMs: 1000 })
  p.onError()
  assert.deepEqual(p.onError(), { kind: 'give-up' })
  assert.deepEqual(p.onError(), { kind: 'give-up' })
})

test('retryPolicy: reset clears the counter — the next error starts over', () => {
  const p = new RetryPolicy({ maxAttempts: 2, baseDelayMs: 1000 })
  p.onError()
  p.onError()
  assert.equal(p.attemptCount, 2)
  p.reset()
  assert.equal(p.attemptCount, 0)
  assert.deepEqual(p.onError(), { kind: 'retry', attempt: 1, delayMs: 1000 })
})

test('retryPolicy: reset mid-flight means a stale error can never consume an attempt', () => {
  const p = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 1000 })
  p.onError()
  p.reset() // advance to a new track — the old retry is void
  assert.deepEqual(p.onError(), { kind: 'retry', attempt: 1, delayMs: 1000 })
})

test('retryPolicy: custom backoffBase shapes the delay series', () => {
  const p = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 500, backoffBase: 3 })
  assert.deepEqual(p.onError(), { kind: 'retry', attempt: 1, delayMs: 500 })
  assert.deepEqual(p.onError(), { kind: 'retry', attempt: 2, delayMs: 1500 })
  assert.deepEqual(p.onError(), { kind: 'retry', attempt: 3, delayMs: 4500 })
})

test('retryPolicy: attemptCount reflects errors since reset', () => {
  const p = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 100 })
  assert.equal(p.attemptCount, 0)
  p.onError()
  p.onError()
  assert.equal(p.attemptCount, 2)
})