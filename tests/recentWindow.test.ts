import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inscribeRecent, sanitizeRecent, RECENT_LIMIT } from '../src/lib/recentWindow'

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

test('inscribeRecent caps at the limit dropping the OLDEST entries', () => {
  const arr = Array.from({ length: 100 }, (_, i) => `t${i}`)
  const next = inscribeRecent(arr, 'new')
  assert.equal(next.length, 100)
  assert.equal(next[0], 't1')
  assert.equal(next[99], 'new')
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

test('10k transitions: bounded, duplicate-free, recency-ordered', () => {
  let w: string[] = []
  const lastTouch = new Map<string, number>()
  for (let i = 0; i < 10000; i++) {
    const id = `t${(i * 37) % 200}`
    w = inscribeRecent(w, id)
    lastTouch.set(id, i)
    assert.ok(w.length <= RECENT_LIMIT, `window exceeded limit at transition ${i}`)
    assert.equal(new Set(w).size, w.length, `duplicate in window at transition ${i}`)
    assert.equal(w[w.length - 1], id, `newest entry is the just-inscribed id at transition ${i}`)
  }
  assert.equal(w.length, RECENT_LIMIT)
  for (let i = 1; i < w.length; i++) {
    assert.ok(
      lastTouch.get(w[i - 1])! < lastTouch.get(w[i])!,
      `window not in recency order at index ${i}`,
    )
  }
})
