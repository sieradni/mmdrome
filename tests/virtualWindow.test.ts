// Pins the pure virtual-window math (`src/lib/virtualWindow.ts`) — the
// render-window model that replaced the Songs list's grow-only chunking
// (2026-09-28). The invariants:
// - the window is EXACT index arithmetic over (scrollTop, viewportH, rowH) —
//   the rendered row count is bounded by MAX_WINDOW_ROWS regardless of list
//   length (the grow-only-memory shape this model removes);
// - a teleport needs NO special machinery: the window derives from the
//   current scrollTop alone, so a jump is just a new ~30-row window;
// - the row-height mean is a clamped EMA over real samples — a corrupt
//   measurement distorts the spacer by a bounded amount and converges;
// - spacers always sum to ~total×rowH, so scrollHeight is the full list and
//   restore is a plain scrollTop write (no sentinel ordering).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OVERSCAN_ROWS,
  MAX_WINDOW_ROWS,
  ESTIMATED_ROW_H,
  MIN_ROW_H,
  MAX_ROW_H,
  SCROLL_UPDATE_MS,
  computeWindow,
  clampRowH,
  updateRowMetrics,
  startOffsetPx,
  endOffsetPx,
  scrollTopForIndex,
  restoreLanding,
} from '../src/lib/virtualWindow'

const RH = 56

test('computeWindow: exact cut + overscan', () => {
  // scrollTop lands mid-row 20; viewport 700 px ≈ 12.5 rows.
  const w = computeWindow({ total: 2564, scrollTop: 20 * RH + 20, viewportH: 700, rowH: RH })
  assert.equal(w.start, 20 - OVERSCAN_ROWS)
  assert.equal(w.end, 33 + OVERSCAN_ROWS)
})

test('computeWindow: clamps to the list at both ends', () => {
  const top = computeWindow({ total: 100, scrollTop: 0, viewportH: 700, rowH: RH })
  assert.equal(top.start, 0)
  const bottom = computeWindow({ total: 100, scrollTop: 98 * RH, viewportH: 700, rowH: RH })
  assert.equal(bottom.end, 100)
  assert.equal(bottom.start, 98 - OVERSCAN_ROWS)
})

test('computeWindow: empty list', () => {
  assert.deepEqual(computeWindow({ total: 0, scrollTop: 0, viewportH: 700, rowH: RH }), { start: 0, end: 0 })
})

test('computeWindow: the window is independent of list length (the anti-grow pin)', () => {
  const w1 = computeWindow({ total: 300, scrollTop: 10_000, viewportH: 700, rowH: RH })
  const w2 = computeWindow({ total: 30_000, scrollTop: 10_000, viewportH: 700, rowH: RH })
  assert.equal(w2.end - w2.start, w1.end - w1.start)
  assert.ok(w2.end - w2.start <= MAX_WINDOW_ROWS)
})

test('computeWindow: a teleport is just a new window (no gap mount, no stall)', () => {
  // A jump from the top to row 2000 in one frame: the exact cut derives
  // from the CURRENT scrollTop — the old chunk design mounted the whole gap
  // (or stalled); this model cannot.
  const w = computeWindow({ total: 2564, scrollTop: 2000 * RH, viewportH: 700, rowH: RH })
  assert.equal(w.start, 2000 - OVERSCAN_ROWS)
  assert.equal(w.end, 2000 + 13 + OVERSCAN_ROWS)
  assert.ok(w.end - w.start <= MAX_WINDOW_ROWS)
})

test('computeWindow: a degenerate estimate clamps to the cap (viewport-anchored)', () => {
  // rowH collapsed to MIN_ROW_H on a tall viewport: the exact cut would be
  // ~500 rows; the cap anchors at the viewport top.
  const w = computeWindow({ total: 2564, scrollTop: 1000, viewportH: 28_000, rowH: MIN_ROW_H })
  assert.equal(w.start, Math.floor(1000 / MIN_ROW_H) - OVERSCAN_ROWS)
  assert.equal(w.end - w.start, MAX_WINDOW_ROWS)
})

test('clampRowH: sane band around the 56 px song row', () => {
  assert.equal(clampRowH(0), ESTIMATED_ROW_H)
  assert.equal(clampRowH(-5), ESTIMATED_ROW_H)
  assert.equal(clampRowH(Number.NaN), ESTIMATED_ROW_H)
  assert.equal(clampRowH(10), MIN_ROW_H)
  assert.equal(clampRowH(999), MAX_ROW_H)
  assert.equal(clampRowH(56), 56)
})

test('updateRowMetrics: EMA converges, ignores corrupt samples AND subpixel noise', () => {
  let m = 0
  m = updateRowMetrics(m, 56)
  assert.equal(m, 56)
  m = updateRowMetrics(m, 70)
  assert.ok(m > 56 && m < 70)
  const before = m
  m = updateRowMetrics(m, 0) // ignored
  m = updateRowMetrics(m, 10_000) // ignored
  m = updateRowMetrics(m, 300) // above MAX_ROW_H — ignored
  m = updateRowMetrics(m, Number.NaN) // ignored
  m = updateRowMetrics(m, before + 2) // deadband: subpixel noise, NOT folded
  m = updateRowMetrics(m, before - 3) // deadband
  assert.equal(m, before, '±4px samples are measurement noise (the spacer feedback guard)')
  m = updateRowMetrics(m, before + 10) // a real height change folds
  assert.ok(m > before, 'only a >4px change moves the mean')
})

test('spacers: the full scroll height is independent of the window (restore pin)', () => {
  const total = 2564
  const w = computeWindow({ total, scrollTop: 100 * RH, viewportH: 700, rowH: RH })
  const h = startOffsetPx(w.start, RH) + (w.end - w.start) * RH + endOffsetPx(total, w.end, RH)
  assert.ok(Math.abs(h - total * RH) <= 2, 'start spacer + rows + end spacer ≈ total height')
})

test('spacers: estimated rowH still produces a sane total', () => {
  const total = 1000
  const w = computeWindow({ total, scrollTop: 50 * ESTIMATED_ROW_H, viewportH: 700, rowH: ESTIMATED_ROW_H })
  const h = startOffsetPx(w.start, ESTIMATED_ROW_H) + (w.end - w.start) * ESTIMATED_ROW_H + endOffsetPx(total, w.end, ESTIMATED_ROW_H)
  assert.ok(Math.abs(h - total * ESTIMATED_ROW_H) <= 2)
})

test('scrollTopForIndex: centers the row (the whole jump implementation)', () => {
  assert.equal(scrollTopForIndex(100, 700, RH), 100 * RH - 350)
  assert.equal(scrollTopForIndex(0, 700, RH), 0)
  assert.equal(scrollTopForIndex(5, 700, RH), 0, 'clamped at 0 near the top')
})

test('restoreLanding: the saved scrollTop is the whole contract', () => {
  assert.equal(restoreLanding(4321), 4321)
  assert.equal(restoreLanding(-50), 0)
})

test('SCROLL_UPDATE_MS: the throttle stays in the ~12 updates/s band', () => {
  assert.equal(SCROLL_UPDATE_MS, 80)
})
