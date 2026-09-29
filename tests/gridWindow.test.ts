// Pins the grid window math (`src/lib/gridWindow.ts`) — the row-based
// virtual window over the Albums/Artists covers grids (2026-09-28). The
// invariants:
// - cuts are ROW-exact (cells never straddle a cut) so the model agrees with
//   the CSS grid's own layout;
// - the rendered cell count is bounded regardless of library size;
// - spacers sum to ~full grid height (restore = plain scrollTop write);
// - scrollTopForCell centers the target's row (the whole jump implementation).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GRID_OVERSCAN_ROWS,
  GRID_MIN_ROW_PX,
  clampGridRowPx,
  computeGridWindow,
  startGapPx,
  endGapPx,
  scrollTopForCell,
} from '../src/lib/gridWindow'

// A 2-col grid, 100 px rows (90 px cell + 10 gap), 12 px top pad.
const G = { totalCells: 440, cols: 2, rowPx: 100, gridPadTop: 12 }

test('computeGridWindow: row-exact cut, FIXED window size', () => {
  // scrollTop 5000 → first row floor((5000-12)/100)=49; the window renders a
  // FIXED K rows (viewport rows + 2×overscan) with only the START clamped —
  // the rendered-row mix must be position-invariant or spacer-model drift
  // makes scrollHeight oscillate (the 2026-09-28 grid-oscillator root cause).
  const w = computeGridWindow({ ...G, scrollTop: 5000, viewportH: 700 })
  const K = Math.ceil(700 / 100) + GRID_OVERSCAN_ROWS * 2
  assert.equal(w.startRow, 49 - GRID_OVERSCAN_ROWS)
  assert.equal(w.startCell % G.cols, 0, 'start is row-aligned')
  assert.equal(w.endRow, w.startRow + K)
  assert.equal(w.endCell % G.cols, 0, 'end is row-aligned')
  // Mid-list, a DIFFERENT scrollTop renders the SAME row count.
  const w2 = computeGridWindow({ ...G, scrollTop: 12_345, viewportH: 700 })
  assert.equal(w2.endRow - w2.startRow, w.endRow - w.startRow)
})

test('computeGridWindow: clamps at both ends', () => {
  const top = computeGridWindow({ ...G, scrollTop: 0, viewportH: 700 })
  assert.equal(top.startRow, 0)
  const bottom = computeGridWindow({ ...G, scrollTop: 500_000, viewportH: 700 })
  assert.equal(bottom.endCell, G.totalCells)
  assert.ok(bottom.startRow < bottom.endRow)
  // Tail clamp: the FULL K-row window still renders (start slides back).
  const K = Math.ceil(700 / 100) + GRID_OVERSCAN_ROWS * 2
  assert.equal(bottom.endRow - bottom.startRow, K)
})

test('computeGridWindow: cells never straddle a cut with odd totals', () => {
  // 445 cells / 2 cols = 223 rows (last row holds 1 cell). The window end is
  // row-aligned and clamped to 445 cells — the cut can leave a PARTIAL last
  // row rendered, never a sliced one.
  const w = computeGridWindow({ ...G, totalCells: 445, scrollTop: 500_000, viewportH: 700 })
  assert.equal(w.endCell, 445)
  assert.ok(w.endRow >= 222)
})

test('spacers: the full grid height is window-independent (mid-list)', () => {
  const w = computeGridWindow({ ...G, scrollTop: 8000, viewportH: 700 })
  const totalRows = Math.ceil(G.totalCells / G.cols)
  const h = startGapPx(w, G) + (w.endRow - w.startRow) * G.rowPx + endGapPx(w, G)
  assert.ok(Math.abs(h - totalRows * G.rowPx) <= 2, 'start gap + rows + end gap ≈ full height')
  // The tail clamp slides the START back, so the window still renders exactly
  // K rows and the spacer sum RECONCILES at every position (restore is a
  // plain scrollTop write everywhere, not just mid-list).
  const tail = computeGridWindow({ ...G, scrollTop: 500_000, viewportH: 700 })
  const tailH = startGapPx(tail, G) + (tail.endRow - tail.startRow) * G.rowPx + endGapPx(tail, G)
  assert.ok(Math.abs(tailH - totalRows * G.rowPx) <= 2, 'tail window still spans full height')
})

test('scrollTopForCell: centers the target row', () => {
  // Cell 100 / 2 cols = row 50; center = 50*100 + 50 + 12 - 350 = 4712.
  assert.equal(scrollTopForCell(100, 700, G), 4712)
  assert.equal(scrollTopForCell(0, 700, G), 0)
})

test('a degenerate rowPx is clamped by the GRID clamp (no giant windows)', () => {
  const w = computeGridWindow({ ...G, rowPx: 0.5, scrollTop: 1000, viewportH: 700 })
  // rowPx 0.5 clamps to GRID_MIN_ROW_PX (80) → the window spans ~9 rows +
  // overscan, not the 2800+ rows a raw 0.5 px row would produce (the endRowOf
  // raw-rowPx bug the 2026-09-28 test caught).
  assert.equal(clampGridRowPx(0.5), GRID_MIN_ROW_PX)
  assert.ok(w.endRow - w.startRow <= Math.ceil(700 / 80) + GRID_OVERSCAN_ROWS * 2 + 1)
})
