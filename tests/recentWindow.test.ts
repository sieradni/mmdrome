import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampRecentLimit,
  effectiveRecent,
  inscribeRecent,
  sanitizeRecent,
  RECENT_LIMIT,
  RECENT_LIMIT_MAX,
} from '../src/lib/recentWindow'

test('inscribeRecent appends a new track as the newest entry', () => {
  assert.deepEqual(inscribeRecent(['a', 'b'], 'c'), ['a', 'b', 'c'])
})

test('inscribeRecent moves an existing track to the newest slot (dedupe)', () => {
  assert.deepEqual(inscribeRecent(['a', 'b', 'c'], 'a'), ['b', 'c', 'a'])
})

test('inscribeRecent returns the same array when the track is already newest (fast path)', () => {
  const arr = ['a', 'b', 'c']
  assert.equal(inscribeRecent(arr, 'c'), arr)
})

test('inscribeRecent caps at the STORAGE limit dropping the OLDEST entries', () => {
  // The storage cap is RECENT_LIMIT_MAX (2026-11-01): the user's horizon is
  // applied at read time (`effectiveRecent`), so lowering it never destroys
  // history.
  const full = Array.from({ length: RECENT_LIMIT_MAX }, (_, i) => `t${i}`)
  const capped = inscribeRecent(full, 'newest')
  assert.equal(capped.length, RECENT_LIMIT_MAX)
  assert.equal(capped[0], 't1', 'the oldest entry is dropped')
  assert.equal(capped[RECENT_LIMIT_MAX - 1], 'newest')
  assert.deepEqual(inscribeRecent(['a', 'b'], 'c'), ['a', 'b', 'c'], 'no cap below the limit')
})

test('inscribeRecent re-playing a cooled-down track refreshes recency without wasting cap', () => {
  const arr = Array.from({ length: 100 }, (_, i) => `t${i}`)
  const next = inscribeRecent(arr, 't0')
  assert.equal(next.length, 100)
  assert.equal(next[99], 't0')
  assert.equal(next[98], 't99')
})

test('inscribeRecent with a custom limit respects it', () => {
  assert.deepEqual(inscribeRecent(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd'])
  assert.deepEqual(inscribeRecent(['a', 'b', 'c'], 'a', 3), ['b', 'c', 'a'])
})

test('sanitizeRecent dedupes keeping the newest occurrence', () => {
  assert.deepEqual(sanitizeRecent(['a', 'b', 'a', 'c', 'b']), ['a', 'c', 'b'])
})

test('sanitizeRecent caps keeping the newest entries', () => {
  const arr = Array.from({ length: 120 }, (_, i) => `t${i}`)
  const next = sanitizeRecent(arr, 100)
  assert.equal(next.length, 100)
  assert.equal(next[0], 't20')
  assert.equal(next[99], 't119')
})

test('sanitizeRecent tolerates undefined/empty input (legacy rows)', () => {
  assert.deepEqual(sanitizeRecent(undefined), [])
  assert.deepEqual(sanitizeRecent([]), [])
  assert.deepEqual(sanitizeRecent(['x']), ['x'])
})

test('effectiveRecent applies the horizon at READ time, so the stored window is never trimmed', () => {
  const stored = Array.from({ length: 300 }, (_, i) => `t${i}`)
  const snapshot = [...stored]

  assert.deepEqual(effectiveRecent(stored, 5), ['t295', 't296', 't297', 't298', 't299'], 'the newest N count as recent')
  assert.deepEqual(stored, snapshot, 'the stored window is untouched — raising the horizon recovers history')
  assert.deepEqual(effectiveRecent(stored, 1000), stored, 'a horizon above the window excludes everything')
  assert.deepEqual(effectiveRecent(stored, 0), [], '0 disables the cool-down entirely')
  assert.deepEqual(effectiveRecent(stored, RECENT_LIMIT), stored.slice(300 - RECENT_LIMIT))
})

test('clampRecentLimit keeps the horizon inside the storable band', () => {
  assert.equal(clampRecentLimit(250), 250)
  assert.equal(clampRecentLimit(-40), 0)
  assert.equal(clampRecentLimit(RECENT_LIMIT_MAX + 1), RECENT_LIMIT_MAX)
  assert.equal(clampRecentLimit(12.6), 13)
  assert.equal(clampRecentLimit(undefined), RECENT_LIMIT, 'a missing setting means the default horizon')
  assert.equal(clampRecentLimit(Number.NaN), RECENT_LIMIT)
})

test('10k transitions: bounded, duplicate-free, recency-ordered', () => {
  let w: string[] = []
  const lastTouch = new Map<string, number>()
  for (let i = 0; i < 10000; i++) {
    const id = `t${(i * 37) % 200}`
    w = inscribeRecent(w, id)
    lastTouch.set(id, i)
    assert.ok(w.length <= RECENT_LIMIT_MAX, `window exceeded the storage cap at transition ${i}`)
    assert.equal(new Set(w).size, w.length, `duplicate in window at transition ${i}`)
    assert.equal(w[w.length - 1], id, `newest entry is the just-inscribed id at transition ${i}`)
  }
  assert.equal(w.length, 200, 'bounded by the distinct ids this run uses (below the storage cap)')
  for (let i = 1; i < w.length; i++) {
    assert.ok(
      lastTouch.get(w[i - 1])! < lastTouch.get(w[i])!,
      `window not in recency order at index ${i}`,
    )
  }
})
