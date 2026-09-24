// Pins the pure cover-stats core (P6, 2026-09-23): LazyThumb feeds every
// cover outcome through this ring so "thumbnails don't load" reports become
// dump-visible numbers (failures, ladder step-downs, mean latency).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordCoverEvent,
  summarizeCoverStats,
  freshCoverStats,
  COVER_STATS_RING_SIZE,
} from '../src/lib/coverStats'

test('a first-try main success counts loaded, no step-down, and adds latency', () => {
  let s = freshCoverStats()
  s = recordCoverEvent(s, { role: 'main', size: 128, ladderStep: 0, loadMs: 120, outcome: 'ok' }, 1000)
  const sum = summarizeCoverStats(s)
  assert.equal(sum.loaded, 1)
  assert.equal(sum.failed, 0)
  assert.equal(sum.stepDowns, 0)
  assert.equal(sum.meanLoadMs, 120)
  assert.equal(sum.recent[0].outcome, 'ok')
  assert.equal(sum.recent[0].seq, 1)
})

test('a success after a ladder step-down counts both loaded and stepDowns', () => {
  let s = freshCoverStats()
  s = recordCoverEvent(s, { role: 'main', size: 128, ladderStep: 1, loadMs: 400, outcome: 'ok' }, 1000)
  const sum = summarizeCoverStats(s)
  assert.equal(sum.loaded, 1)
  assert.equal(sum.stepDowns, 1)
})

test('an exhausted ladder counts failed, never loaded or latency', () => {
  let s = freshCoverStats()
  s = recordCoverEvent(s, { role: 'main', size: 128, ladderStep: 4, loadMs: null, outcome: 'failed' }, 1000)
  const sum = summarizeCoverStats(s)
  assert.equal(sum.failed, 1)
  assert.equal(sum.loaded, 0)
  assert.equal(sum.meanLoadMs, null, 'no successful loads yet')
})

test('micro failures count separately and never touch main counters', () => {
  let s = freshCoverStats()
  s = recordCoverEvent(s, { role: 'micro', size: 0, ladderStep: 0, loadMs: null, outcome: 'micro-failed' }, 1000)
  s = recordCoverEvent(s, { role: 'main', size: 128, ladderStep: 0, loadMs: 50, outcome: 'ok' }, 1010)
  const sum = summarizeCoverStats(s)
  assert.equal(sum.microFailed, 1)
  assert.equal(sum.loaded, 1)
  assert.equal(sum.failed, 0)
  assert.equal(sum.meanLoadMs, 50, 'micro outcome excluded from main latency')
})

test('mean latency is the average over successful main loads only', () => {
  let s = freshCoverStats()
  s = recordCoverEvent(s, { role: 'main', size: 128, ladderStep: 0, loadMs: 100, outcome: 'ok' }, 1000)
  s = recordCoverEvent(s, { role: 'main', size: 256, ladderStep: 0, loadMs: 300, outcome: 'ok' }, 1100)
  s = recordCoverEvent(s, { role: 'main', size: 128, ladderStep: 0, loadMs: null, outcome: 'failed' }, 1200)
  assert.equal(summarizeCoverStats(s).meanLoadMs, 200)
})

test('the ring evicts the OLDEST record and keeps seq/t monotonic', () => {
  let s = freshCoverStats()
  for (let i = 0; i < COVER_STATS_RING_SIZE + 10; i++) {
    s = recordCoverEvent(s, { role: 'main', size: 128, ladderStep: 0, loadMs: 10, outcome: 'ok' }, 1000 + i)
  }
  const sum = summarizeCoverStats(s)
  assert.equal(sum.recent.length, COVER_STATS_RING_SIZE)
  // newest first
  assert.equal(sum.recent[0].seq, COVER_STATS_RING_SIZE + 10)
  assert.equal(sum.recent[COVER_STATS_RING_SIZE - 1].seq, 11, 'the first 10 records were evicted')
  for (let i = 1; i < sum.recent.length; i++) {
    assert.ok(sum.recent[i - 1].seq > sum.recent[i].seq, 'ring is newest-first')
  }
})

test('the fallback role is recorded but changes no counter', () => {
  let s = freshCoverStats()
  s = recordCoverEvent(s, { role: 'fallback', size: 0, ladderStep: 0, loadMs: null, outcome: 'ok' }, 1000)
  const sum = summarizeCoverStats(s)
  assert.equal(sum.loaded, 0)
  assert.equal(sum.failed, 0)
  assert.equal(sum.recent.length, 1)
})
