import { test } from 'node:test'
import assert from 'node:assert/strict'
import { popmToLocalRating, ratingToMp3Popm } from '../src/lib/tagWriter'

const GRID = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

test('POPM round-trip: every grid rating writes and re-reads to itself', () => {
  for (const r of GRID) {
    assert.equal(popmToLocalRating(ratingToMp3Popm(r)), r, `round-trip failed for rating ${r}`)
  }
})

test('POPM every write output re-reads onto the 10-step grid', () => {
  for (let r = 0; r <= 100; r++) {
    const v = popmToLocalRating(ratingToMp3Popm(r))
    assert.ok(v % 10 === 0 && v >= 0 && v <= 100, `off-grid re-read for rating ${r}: ${v}`)
  }
})

test('POPM write map is MusicBee-calibrated (spot checks)', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [5, 13],
    [15, 26],
    [25, 54],
    [35, 78],
    [45, 104],
    [55, 128],
    [65, 154],
    [75, 178],
    [85, 204],
    [95, 255],
    [100, 255],
  ]
  for (const [rating, popm] of cases) {
    assert.equal(ratingToMp3Popm(rating), popm, `write map mismatch for rating ${rating}`)
  }
})

test('POPM read map boundaries land on the grid (spot checks)', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [1, 10],
    [19, 10],
    [20, 20],
    [39, 20],
    [40, 30],
    [63, 30],
    [64, 40],
    [90, 40],
    [91, 50],
    [116, 50],
    [117, 60],
    [140, 60],
    [141, 70],
    [166, 70],
    [167, 80],
    [195, 80],
    [196, 90],
    [248, 90],
    [249, 100],
    [255, 100],
  ]
  for (const [popm, rating] of cases) {
    assert.equal(popmToLocalRating(popm), rating, `read map mismatch for popm ${popm}`)
  }
})

test('POPM maps are asymmetric by design — do NOT align them', () => {
  // The write map is MusicBee-calibrated (verified against taglib-wasm reads);
  // the read map is the 10-step grid. They deliberately drift off-grid:
  assert.equal(ratingToMp3Popm(90), 204)
  assert.equal(popmToLocalRating(204), 90)
  assert.equal(popmToLocalRating(ratingToMp3Popm(45)), 50)
  assert.equal(popmToLocalRating(ratingToMp3Popm(55)), 60)
})

test('POPM maps are non-decreasing', () => {
  let prevW = -1
  let prevR = -1
  for (let r = 0; r <= 100; r++) {
    const w = ratingToMp3Popm(r)
    const read = popmToLocalRating(w)
    assert.ok(w >= prevW, `write map decreased at ${r}`)
    assert.ok(read >= prevR, `read map decreased at ${r}`)
    prevW = w
    prevR = read
  }
})
