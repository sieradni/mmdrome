/**
 * Grid window math (F2) — the row-based virtual window over GRID surfaces
 * (the Albums/Artists covers grids), built on the same philosophy as
 * `virtualWindow.ts`: position-derived, teleport-trivial, spacer-honest. A
 * CELL exists in the DOM iff its index is inside the window; the window is
 * computed over GRID ROWS (cells never straddle cuts) so a cut never slices
 * a cell, and the spacers are sized in rows (a row spacer preserves the
 * CSS grid's own column layout — no synthetic grid needed).
 *
 * Why rows-of-cells instead of a raw cell cut: the CSS grid lays out cells
 * into rows itself, so the model must agree with it or cells will visibly
 * shift when the window moves. Deriving the cut in row space (row =
 * floor(scrollTop / rowH), cells = rows × cols) makes the model and the DOM
 * agree by construction.
 *
/**
 * MEASUREMENT CONTRACT (2026-09-28, the grid-oscillator probes): rowPx MUST
 * be measured from a FULLY-VISIBLE cell — top AND bottom inside the viewport —
 * never from `cells[0]`, which is an OVERSCAN row above the viewport where
 * content-visibility laid out at the 240px contain-intrinsic-size estimate
 * while in-viewport rows lay out real (~297px): a bimodal measure feeding the
 * spacers. Also set `overflow-anchor: none` on the grid scroller — without it
 * Chrome's scroll anchoring compensates spacer-driven scrollHeight changes and
 * fires phantom scroll events (more derives). DOM-free; the adapter reads
 * rects, applies the window, and sizes two row-spacer divs.
 */

import { computeWindow } from './virtualWindow'

/** Grid rows rendered beyond each viewport edge (rows, not cells). Widened
 *  4 → 6 (2026-09-29, the "more buffer off-screen" request): a grid row is
 *  ~130–260 px, so 6 rows ≈ 800–1600 px of mounted lead per side — roughly a
 *  viewport of cover buffer for a slow scroll, and the paced band lane has
 *  real depth to fill. The FIXED-K rule is untouched (K = viewport rows +
 *  2×overscan, start-clamped only), so the position-invariant scrollHeight
 *  property that killed the grid oscillator still holds exactly. */
export const GRID_OVERSCAN_ROWS = 6

/** Grid-row height bounds (px). A grid ROW is an aspect-square cell (viewport
 *  dependent, ~130–260 px) + caption lines + row gap — much taller than a
 *  list row, so the list's 24–160 clamp would corrupt the geometry. The
 *  bounds are generous; their job is bounding a corrupt measurement, not
 *  modeling the real cell. */
export const GRID_MIN_ROW_PX = 80
export const GRID_MAX_ROW_PX = 600

/** Clamp a grid-row measurement to the sane band (0/NaN → the midpoint). */
export function clampGridRowPx(rowPx: number): number {
  if (!Number.isFinite(rowPx) || rowPx <= 0) return (GRID_MIN_ROW_PX + GRID_MAX_ROW_PX) / 2
  return Math.min(GRID_MAX_ROW_PX, Math.max(GRID_MIN_ROW_PX, rowPx))
}

/** The responsive column ladder the CSS grid uses (grid-cols-2 … lg:grid-cols-5).
 *  The adapter measures the grid's own `computedStyle.gridTemplateColumns`
 *  (always materialized — count the space-separated track tokens) instead of
 *  re-implementing breakpoint math, so the model can never disagree with the
 *  layout. This ladder exists only for tests + doc clarity. */
export const GRID_COLUMN_LADDER = [1, 2, 3, 4, 5]

export interface GridWindowState {
  /** First rendered CELL index (a multiple of cols). */
  startCell: number
  /** One-past-last rendered CELL index (a multiple of cols, clamped). */
  endCell: number
  /** First rendered GRID ROW (startCell / cols). */
  startRow: number
  /** One-past-last rendered GRID ROW. */
  endRow: number
}

export interface GridGeometry {
  /** Total CELL count. */
  totalCells: number
  /** Columns in the CURRENT breakpoint (1–5). */
  cols: number
  /** One grid ROW's height in px: cell height + row gap. */
  rowPx: number
  /** The grid's top padding (pt-4), excluded from spacer heights. */
  gridPadTop: number
}

/** Rows spanning `scrollTop + viewportH − gridPadTop` (0 when the pads exceed
 *  the offset) — the viewport-rows term of the FIXED window count. The caller
 *  MUST pass the CLAMPED rowPx — a raw degenerate estimate here would produce
 *  an enormous window (the 2026-09-28 test catch). */
function endRowOf(opts: { scrollTop: number; viewportH: number; rowPx: number; gridPadTop: number }): number {
  const bottom = opts.scrollTop + opts.viewportH - opts.gridPadTop
  if (bottom <= 0) return 0
  return Math.ceil(bottom / opts.rowPx)
}

/**
 * Derive the rendered window for one scroll frame. Row-exact cuts: the first
 * row is `floor((scrollTop − pad) / rowPx)` (negative → 0); the cell indices
 * are the row indices × cols. Fractional rowPx never drops a row (floor/ceil).
 *
 * The rendered window is a FIXED ROW COUNT (2026-09-28, the grid-oscillator
 * probes): K = viewport rows + 2×GRID_OVERSCAN_ROWS, with only the START
 * clamped to the list. The old variable-size window (start = first − overscan,
 * end = viewport bottom + overscan, each clamped INDEPENDENTLY) shrank near
 * the list ends — and with model rowPx ≠ real row height, the rendered rows
 * contribute their TRUE height while the spacers contribute the MODEL's, so
 * scrollHeight varied with HOW MANY real rows the window happened to render:
 * the scrollbar moved under the user's hand, Chrome's scroll anchoring
 * compensated scrollTop with a phantom scroll event, and the next derive
 * measured the other rowPx mode — the 30↔55-cell flip (4,180 arm-IO fires,
 * zero imgs surviving, v6–v13). A fixed K makes the rendered-row MIX
 * position-invariant, so a rowPx error produces a CONSTANT scrollHeight
 * offset, never a per-frame oscillation. endRowOf remains as the documented
 * viewport-rows helper used for K.
 */
export function computeGridWindow(opts: {
  totalCells: number
  cols: number
  scrollTop: number
  viewportH: number
  rowPx: number
  gridPadTop: number
}): GridWindowState {
  const { totalCells, cols } = opts
  const rowPx = clampGridRowPx(opts.rowPx)
  const totalRows = Math.ceil(totalCells / cols)
  if (totalRows <= 0) return { startCell: 0, endCell: 0, startRow: 0, endRow: 0 }
  const first = Math.floor((opts.scrollTop - opts.gridPadTop) / rowPx)
  const windowRows = endRowOf({ ...opts, rowPx, scrollTop: 0, gridPadTop: 0 }) + GRID_OVERSCAN_ROWS * 2
  // A scrollTop PAST the list end (a filtered list shrinking under a deep
  // scroll) clamps the start so the FULL K-row window renders the list tail.
  const startRow = Math.min(Math.max(0, first - GRID_OVERSCAN_ROWS), Math.max(0, totalRows - windowRows))
  const endRow = Math.min(totalRows, startRow + windowRows)
  return {
    startCell: startRow * cols,
    endCell: Math.min(totalCells, endRow * cols),
    startRow,
    endRow,
  }
}

/** Spacer px hiding the rows BEFORE the window (0 at the top). The start
 *  slides back under the tail clamp, so start-gap + K·rowPx + end-gap spans
 *  the full grid height at EVERY scroll position (see computeGridWindow). */
export function startGapPx(win: GridWindowState, g: GridGeometry): number {
  return Math.max(0, Math.round(win.startRow * g.rowPx))
}

/** Spacer px hiding the rows AFTER the window (0 at the end). */
export function endGapPx(win: GridWindowState, g: GridGeometry): number {
  const totalRows = Math.ceil(g.totalCells / g.cols)
  return Math.max(0, Math.round((totalRows - win.endRow) * g.rowPx))
}

/**
 * ScrollTop that centers CELL `targetCell`'s ROW in the viewport — the whole
 * jump implementation for grids (the adapter sets scrollTop; the scroll
 * handler derives the window). The +rowPx/2 centers the row's middle.
 */
export function scrollTopForCell(targetCell: number, viewportH: number, g: GridGeometry): number {
  const row = Math.floor(Math.max(0, targetCell) / Math.max(1, g.cols))
  const rowPx = clampGridRowPx(g.rowPx)
  return Math.max(0, row * rowPx + rowPx / 2 + g.gridPadTop - viewportH / 2)
}

/**
 * The detail-view (album/artist track list) window: the SAME exact-cut model
 * as SongsView — a fixed-height list — so the pure `computeWindow` applies
 * verbatim. This function exists to name the shared shape (and to keep a
 * single import site in the adapters); it adds nothing.
 */
export { computeWindow }

/** The grid's row gap in px — Tailwind `gap-4` on both grids. The rowPx
 *  measurement adds this to a cell's own height (a ROW is cell + gap). */
export const GRID_ROW_GAP_PX = 16

/**
 * Sync the model's column count from the MATERIALIZED layout (count the
 * `gridTemplateColumns` track tokens). Returns null when the layout is not
 * resolvable (unmounted/`display:none`) — the caller keeps its current count.
 * NEVER re-implement the breakpoint ladder here: the CSS grid is the truth.
 */
export function syncGridCols(grid: HTMLElement): number | null {
  const template = getComputedStyle(grid).gridTemplateColumns
  if (!template) return null
  const cols = template.split(' ').filter(Boolean).length
  return cols > 0 ? cols : null
}

/**
 * Measure ONE grid row gap-to-gap, but ONLY from a FULLY-VISIBLE cell (top
 * AND bottom inside the scroller's viewport). A cell straddling the viewport
 * edge or sitting in the overscan can be a content-visibility estimate or an
 * un-laid-out transient — a BIMODAL measure that fed the spacers and
 * oscillated the whole geometry (the 2026-09-28 grid oscillator: 30↔55-cell
 * windows, 4,180 arm-IO fires, zero imgs surviving). With `windowed` grid
 * thumbs the offscreen cells are unmounted anyway. Returns the CURRENT
 * rowPx unchanged when no fully-visible cell exists (window above the fold,
 * empty grid) — never guesses.
 */
export function measureGridRowPx(
  scroller: HTMLElement,
  grid: HTMLElement,
  cellSelector: string,
  currentRowPx: number,
): number {
  const vh = scroller.clientHeight
  const elTop = scroller.getBoundingClientRect().top
  for (const cell of grid.querySelectorAll<HTMLElement>(cellSelector)) {
    const r = cell.getBoundingClientRect()
    if (r.top >= elTop && r.bottom <= elTop + vh) {
      const measured = Math.round(r.height + GRID_ROW_GAP_PX)
      if (measured >= GRID_MIN_ROW_PX && measured <= GRID_MAX_ROW_PX) return measured
      break
    }
  }
  return currentRowPx
}
