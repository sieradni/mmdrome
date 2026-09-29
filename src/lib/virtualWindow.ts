/**
 * Pure virtual-window math (F2): the render-window model that REPLACES the
 * Songs list's grow-only chunking (2026-09-28). A row exists in the DOM if
 * and only if its index is inside the window — no IntersectionObservers, no
 * unmount heuristics, no per-row bookkeeping, no grow-only memory. The window
 * is derived from three measurements (scrollTop, viewport height, row height)
 * on each throttled scroll frame; everything else is index arithmetic.
 *
 * There is deliberately NO teleport machinery: the window derives from the
 * CURRENT scrollTop alone, so a jump to either end is just a new ~30-row
 * window — the "whole-gap mount" failure mode belonged to the old
 * accumulate-a-limit design and cannot exist here. A far jump is therefore a
 * plain scrollTop write (see scrollTopForIndex); no pre-warming, no clamped
 * expansion state.
 *
 * The UNKNOWN-ROW-HEIGHT problem, and why estimation is honest here: virtual
 * lists that measure every rendered row (the "clean" design) pay per-row
 * ResizeObservers and height-memo maps — for a fixed-height list that is
 * machinery without a job. Song rows are CSS-fixed at ~56 px; we track ONE
 * mean row height folded from real rendered rows and clamp it to sane
 * bounds, so a corrupt measurement distorts the spacer by a bounded amount
 * and converges within a viewport of scrolling. Cuts are ALWAYS derived from
 * real scrollTop against the same mean, so the visible content is correct
 * even while the estimate is converging.
 *
 * DOM-free so the whole decision surface is unit-pinned; the SongsView
 * adapter only reads rects, applies the returned window, and sizes two
 * spacer divs from startOffsetPx/endOffsetPx.
 */

/** Rows rendered beyond each viewport edge. Absorbs momentum travel and
 *  covers pre-roll duty for the loader's band lane. Widened 8 → 20
 *  (2026-09-29, the "more buffer off-screen" request): ~2 viewports of
 *  mounted lead on a phone, so the paced band lane has real depth to fill
 *  and a slow scroll finds covers already armed. Cost is bounded: ~50 rows
 *  mounted (viewport + 2×20) against a MAX_WINDOW_ROWS of 120, and the
 *  loader lanes — not the window — still own the fetch rate. */
export const OVERSCAN_ROWS = 20

/** Hard cap on rendered rows. Only engages when the viewport is enormous
 *  relative to the row estimate (e.g. the mean collapsed to MIN_ROW_H on a
 *  very tall display) — a guard against a degenerate estimate mounting a
 *  giant window, not a teleport mechanism. */
export const MAX_WINDOW_ROWS = 120

/** Row-height estimate bounds (px). Song rows are ~56 px; the clamp exists
 *  so one corrupt measurement (0, or a modal's 400 px) cannot wreck the
 *  spacer geometry — it distorts by a bounded amount and converges back. */
export const ESTIMATED_ROW_H = 56
export const MIN_ROW_H = 24
export const MAX_ROW_H = 160

/** Scroll-event throttle (ms). Deriving the window is arithmetic (~µs), but
 *  the ADAPTER's work per derived window is a Svelte keyed-diff over
 *  (end−start) rows — bounded by the max window, not the list — and frame
 *  cadence buys nothing over ~12 updates/s for a scroll handler. */
export const SCROLL_UPDATE_MS = 80

export interface WindowState {
  /** First rendered row index (exact cut, 0 when above). */
  start: number
  /** One-past-last rendered row index (exact cut against `total`). */
  end: number
}

/**
 * Derive the rendered window for one scroll frame.
 *
 * Exact cuts: rows above `scrollTop` are start, rows below `scrollTop +
 * viewportH` are end, widened by OVERSCAN_ROWS on both sides and clamped to
 * the list. All divisions use the CURRENT mean row height; `start` floors
 * and `end` ceils so fractional heights never drop a row. The result never
 * exceeds MAX_WINDOW_ROWS — a degenerate estimate clamps to the cap anchored
 * at the viewport top (the rows the user is looking at render first).
 */
export function computeWindow(opts: {
  total: number
  scrollTop: number
  viewportH: number
  rowH: number
}): WindowState {
  const { total, scrollTop, viewportH } = opts
  const rowH = clampRowH(opts.rowH)
  if (total <= 0) return { start: 0, end: 0 }

  const exactStart = Math.floor(scrollTop / rowH)
  const exactEnd = Math.ceil((scrollTop + viewportH) / rowH)

  // A scrollTop PAST the list end (a filtered list shrinking under a deep
  // scroll) would otherwise invert the window (start > end → blank view);
  // clamp the start to the last row and keep ≥1 row rendered.
  const start = Math.min(Math.max(0, exactStart - OVERSCAN_ROWS), Math.max(0, total - 1))
  let end = Math.min(total, Math.max(start + 1, exactEnd + OVERSCAN_ROWS))
  if (end - start > MAX_WINDOW_ROWS) end = start + MAX_WINDOW_ROWS
  return { start, end }
}

/** Clamp a row-height measurement to the sane band. */
export function clampRowH(rowH: number): number {
  if (!Number.isFinite(rowH) || rowH <= 0) return ESTIMATED_ROW_H
  return Math.min(MAX_ROW_H, Math.max(MIN_ROW_H, rowH))
}

/**
 * Fold one measured row into the running mean. The adapter measures REAL
 * rendered rows once per throttled update (first row in the window);
 * pure here so the clamp/mean rule is pinned. A zero/absurd sample is
 * ignored, not folded.
 *
 * FEEDBACK GUARD (2026-09-28): the mean feeds the spacers, the spacers feed
 * scrollHeight, scrollHeight re-clamps scrollTop, the clamp fires a scroll
 * event, the next derive re-measures — a measure that MOVES every cycle is
 * a spacer oscillator (the grid probes measured the window flipping 30↔55
 * cells and 4,180 arm-IO fires with zero covers surviving). The deadband:
 * a sample within ±4px of the current mean is treated as noise and NOT
 * folded; only a real height change (>4px — font-size setting, viewport
 * class) moves the mean, and then by one bounded EMA step.
 */
export function updateRowMetrics(prevMean: number, sample: number): number {
  if (!Number.isFinite(sample) || sample < MIN_ROW_H || sample > MAX_ROW_H) return prevMean
  if (prevMean > 0 && Math.abs(sample - prevMean) <= 4) return prevMean
  return prevMean === 0 ? sample : Math.round((prevMean + (sample - prevMean) * 0.12) * 10) / 10
}

/** Spacer height for the rows BEFORE the window (estimated until the mean
 *  converges; exact whenever rowH is exact — the two agree after one pass). */
export function startOffsetPx(start: number, rowH: number): number {
  return Math.max(0, Math.round(start * clampRowH(rowH)))
}

/** Spacer height for the rows AFTER the window. */
export function endOffsetPx(total: number, end: number, rowH: number): number {
  return Math.max(0, Math.round((total - end) * clampRowH(rowH)))
}

/**
 * ScrollTop that centers row `targetIndex` in the viewport — the whole
 * jump-to-current implementation under this model (set scrollTop; the scroll
 * handler derives the window; no element lookup, no limit growth). Exact for
 * fixed-height rows; close for a converging estimate, and the next
 * computeWindow from the real scrollTop corrects the window.
 */
export function scrollTopForIndex(targetIndex: number, viewportH: number, rowH: number): number {
  return Math.max(0, targetIndex * clampRowH(rowH) - viewportH / 2)
}

/**
 * Restore landing: a saved scrollTop is applied as-is and the window derives
 * from it — scroll height ALWAYS equals the full list under this model
 * (spacers are sized for every row), so there is no restore-before-sentinel
 * ordering problem and no limit-growth cascade. This function exists to pin
 * that contract: the only input restore needs is the saved scrollTop.
 */
export function restoreLanding(savedScrollTop: number): number {
  return Math.max(0, savedScrollTop)
}
