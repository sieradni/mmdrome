// Pins the load-status pure core (seek-bar buffered layer + preload fills):
// normalize/merge/clamp rules, CSS fill mapping, seek clamping, and the
// preload reducer (stale progress can never resurrect a settled entry).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeBufferedRanges,
  bufferedRangeFills,
  clampSeekTime,
  applyPreloadEvent,
  preloadFillPercent,
  mapNativePreloadEvent,
  type BufferedSource,
  type PreloadEntry,
} from '../src/lib/loadStatus'

function src(ranges: Array<[number, number]>): BufferedSource {
  return {
    length: ranges.length,
    start: (i: number) => ranges[i][0],
    end: (i: number) => ranges[i][1],
  }
}

// --- normalizeBufferedRanges -------------------------------------------------

test('passes through a single in-bounds range', () => {
  assert.deepEqual(normalizeBufferedRanges(src([[0, 120]]), 300), [{ start: 0, end: 120 }])
})

test('returns [] without a usable duration', () => {
  assert.deepEqual(normalizeBufferedRanges(src([[0, 120]]), 0), [])
  assert.deepEqual(normalizeBufferedRanges(src([[0, 120]]), NaN), [])
  assert.deepEqual(normalizeBufferedRanges(null, 300), [])
})

test('clamps out-of-bounds ranges into [0, duration]', () => {
  assert.deepEqual(normalizeBufferedRanges(src([[-50, 400]]), 300), [{ start: 0, end: 300 }])
})

test('drops empty, inverted, and non-finite ranges', () => {
  const ranges: Array<[number, number]> = [
    [10, 10],
    [50, 20],
    [NaN, 30],
    [40, Infinity],
  ]
  assert.deepEqual(normalizeBufferedRanges(src(ranges), 300), [])
})

test('sorts by start and merges overlaps/touching ranges', () => {
  const out = normalizeBufferedRanges(
    src([
      [200, 260],
      [0, 120],
      [100, 210],
    ]),
    300,
  )
  assert.deepEqual(out, [{ start: 0, end: 260 }])
})

test('keeps genuine gaps (the playhead still needs that bandwidth)', () => {
  const out = normalizeBufferedRanges(
    src([
      [0, 120],
      [280, 300],
    ]),
    300,
  )
  assert.deepEqual(out, [
    { start: 0, end: 120 },
    { start: 280, end: 300 },
  ])
})

test('a throwing TimeRanges index is skipped, not fatal', () => {
  const throwing: BufferedSource = {
    length: 2,
    start: (i: number) => {
      if (i === 0) throw new Error('torn down')
      return 50
    },
    end: () => 60,
  }
  assert.deepEqual(normalizeBufferedRanges(throwing, 300), [{ start: 50, end: 60 }])
})

// --- bufferedRangeFills ------------------------------------------------------

test('maps ranges to left/width percentages', () => {
  assert.deepEqual(bufferedRangeFills([{ start: 0, end: 150 }], 300), [{ left: 0, width: 50 }])
  assert.deepEqual(bufferedRangeFills([{ start: 280, end: 300 }], 300), [
    { left: 280 / 3, width: 20 / 3 },
  ])
})

test('fill mapping returns [] without duration', () => {
  assert.deepEqual(bufferedRangeFills([{ start: 0, end: 5 }], 0), [])
})

// --- clampSeekTime -----------------------------------------------------------

test('clamps seeks into [0, duration]', () => {
  assert.equal(clampSeekTime(-5, 300), 0)
  assert.equal(clampSeekTime(400, 300), 300)
  assert.equal(clampSeekTime(42.5, 300), 42.5)
  assert.equal(clampSeekTime(10, 0), 0)
  assert.equal(clampSeekTime(NaN, 300), 0)
})

// --- applyPreloadEvent -------------------------------------------------------

test('start opens an indeterminate fetching entry', () => {
  const next = applyPreloadEvent({}, { type: 'start', trackId: 'a' })
  assert.deepEqual(next, { a: { state: 'fetching', progress: null } })
})

test('progress advances only a fetching entry and clamps to 0..1', () => {
  let m: Record<string, PreloadEntry> = {}
  m = applyPreloadEvent(m, { type: 'start', trackId: 'a' })
  m = applyPreloadEvent(m, { type: 'progress', trackId: 'a', progress: 0.5 })
  assert.equal(m['a'].progress, 0.5)
  m = applyPreloadEvent(m, { type: 'progress', trackId: 'a', progress: 9 })
  assert.equal(m['a'].progress, 1)
})

test('progress for an unknown row is ignored (never fabricates entries)', () => {
  assert.deepEqual(applyPreloadEvent({}, { type: 'progress', trackId: 'ghost', progress: 0.5 }), {})
})

test('stale progress after done/dead is dropped', () => {
  let m: Record<string, PreloadEntry> = {}
  m = applyPreloadEvent(m, { type: 'start', trackId: 'a' })
  m = applyPreloadEvent(m, { type: 'done', trackId: 'a' })
  m = applyPreloadEvent(m, { type: 'progress', trackId: 'a', progress: 0.1 })
  assert.deepEqual(m['a'], { state: 'cached', progress: 1 })
  m = applyPreloadEvent(m, { type: 'dead', trackId: 'b' })
  m = applyPreloadEvent(m, { type: 'progress', trackId: 'b', progress: 0.9 })
  assert.deepEqual(m['b'], { state: 'dead', progress: null })
})

test('evict removes the entry; reset clears the map', () => {
  let m: Record<string, PreloadEntry> = {
    a: { state: 'cached', progress: 1 },
    b: { state: 'fetching', progress: null },
  }
  m = applyPreloadEvent(m, { type: 'evict', trackId: 'a' })
  assert.deepEqual(Object.keys(m), ['b'])
  m = applyPreloadEvent(m, { type: 'reset' })
  assert.deepEqual(m, {})
})

// --- preloadFillPercent ------------------------------------------------------

test('fill percent: cached 100, known progress scaled, else null', () => {
  assert.equal(preloadFillPercent({ state: 'cached', progress: 1 }), 100)
  assert.equal(preloadFillPercent({ state: 'fetching', progress: 0.25 }), 25)
  assert.equal(preloadFillPercent({ state: 'fetching', progress: null }), null)
  assert.equal(preloadFillPercent({ state: 'dead', progress: null }), null)
  assert.equal(preloadFillPercent(undefined), null)
})

// --- native preload mapping (iOS queue-row tint parity, A14) ------------------

test('native event mapping: done → cached, gone → evict, ratio → progress, none → start', () => {
  assert.deepEqual(mapNativePreloadEvent({ trackId: 'a', state: 'done' }), { type: 'done', trackId: 'a' })
  assert.deepEqual(mapNativePreloadEvent({ trackId: 'b', state: 'gone' }), { type: 'evict', trackId: 'b' })
  assert.deepEqual(mapNativePreloadEvent({ trackId: 'c', state: 'progress', progress: 0.55 }), {
    type: 'progress',
    trackId: 'c',
    progress: 0.55,
  })
  // No Content-Length → honest indeterminate start (never a fake percent).
  assert.deepEqual(mapNativePreloadEvent({ trackId: 'd', state: 'progress' }), { type: 'start', trackId: 'd' })
})

test('native event mapping composes with the reducer (round trip)', () => {
  let m: Record<string, PreloadEntry> = {}
  m = applyPreloadEvent(m, mapNativePreloadEvent({ trackId: 'a', state: 'progress' }))
  assert.deepEqual(m['a'], { state: 'fetching', progress: null })
  m = applyPreloadEvent(m, mapNativePreloadEvent({ trackId: 'a', state: 'progress', progress: 0.5 }))
  assert.deepEqual(m['a'], { state: 'fetching', progress: 0.5 })
  m = applyPreloadEvent(m, mapNativePreloadEvent({ trackId: 'a', state: 'done' }))
  assert.deepEqual(m['a'], { state: 'cached', progress: 1 })
  // A stale 'progress' after done is ignored (reducer guard).
  m = applyPreloadEvent(m, mapNativePreloadEvent({ trackId: 'a', state: 'progress', progress: 0.2 }))
  assert.deepEqual(m['a'], { state: 'cached', progress: 1 })
  m = applyPreloadEvent(m, mapNativePreloadEvent({ trackId: 'a', state: 'gone' }))
  assert.deepEqual(m['a'], undefined)
})
