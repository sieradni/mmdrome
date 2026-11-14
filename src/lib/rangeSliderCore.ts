/**
 * Dual-handle range slider core (2026-11-14) — the ONE handle-resolution model
 * behind `RangeFilterSlider` (the rating range, and every numerical clause in
 * the library and auto-queue filter builders).
 *
 * `RangeFilterSlider` owns pixels, pointer capture and rendering; this module
 * owns the rules a press and a drag follow: which handle a press grabs, how a
 * press on OVERLAPPING handles resolves, and how a move clamps against the twin
 * handle. Pure, so the edge cases are pinned by `tests/rangeSliderCore.test.ts`
 * instead of only by a browser.
 */

/** `0` = the minimum handle, `1` = the maximum handle. */
export type RangeHandle = 0 | 1

/**
 * `'pending'` = the press landed ON two overlapping handles and there is no
 * side to pick from yet: the direction of the first movement decides.
 */
export type RangeHandlePick = RangeHandle | 'pending'

/**
 * Which handle a press at `v` grabs.
 *
 * Separated handles → the nearest one (an exact midline tie takes the maximum,
 * so a press can never strand the low edge).
 *
 * Overlapping handles (`lo === hi`, e.g. both parked at the right edge) have no
 * "nearest" side, and a FIXED tie-break is wrong at one of the two ends: the
 * pre-2026-11-14 always-maximum rule left a collapsed pair pinned at the domain
 * maximum — a drag left grabbed the maximum, every move clamped back to `lo`
 * (`Math.max(v, lo)`), and the minimum handle could not be pulled down at all.
 * A press OFF a collapsed pair therefore picks by SIDE (left → minimum,
 * right → maximum), and a press exactly ON it defers to `resolvePendingHandle`.
 */
export function pickDragHandle(v: number, lo: number, hi: number): RangeHandlePick {
  if (hi > lo) return Math.abs(v - lo) < Math.abs(v - hi) ? 0 : 1
  if (v < lo) return 0
  if (v > hi) return 1
  return 'pending'
}

/**
 * Resolve a deferred press from its first movement, `anchor` being the value
 * the two handles are parked on. `null` = still parked (no movement yet), so
 * the gesture stays pending rather than burning itself on a guess.
 */
export function resolvePendingHandle(v: number, anchor: number): RangeHandle | null {
  if (v === anchor) return null
  return v < anchor ? 0 : 1
}

/**
 * The band after `which` moves to `v`. Handles can never cross: each one clamps
 * at the other.
 */
export function applyHandleMove(
  which: RangeHandle,
  v: number,
  lo: number,
  hi: number,
): [number, number] {
  return which === 0 ? [Math.min(v, hi), hi] : [lo, Math.max(v, lo)]
}
