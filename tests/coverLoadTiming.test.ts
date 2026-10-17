import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCoverLoadTiming } from '../src/lib/coverLoadTiming'

test('reused covers measure the new request, ignoring stale and duplicate loads', () => {
  let now = 10
  const timing = createCoverLoadTiming(() => now)
  timing.begin('first')
  now = 20
  assert.equal(timing.finish('first'), 10)
  now = 26_400_000 // the field dump had seven-hour-old arm timestamps
  timing.begin('second')
  assert.equal(timing.finish('first'), null)
  now += 15
  assert.equal(timing.finish('second'), 15)
  assert.equal(timing.finish('second'), null)
  timing.begin(null)
  assert.equal(timing.finish('second'), null)
})

test('a failure step-down starts its own latency measurement', () => {
  let now = 10
  const timing = createCoverLoadTiming(() => now)
  timing.begin('large')
  now = 300
  timing.begin('small')
  now = 310
  assert.equal(timing.finish('small'), 10)
})
