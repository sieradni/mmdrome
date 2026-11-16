/**
 * The USER QUEUE's shuffle model (2026-11-14).
 *
 * Two orders are produced here, and they are deliberately different:
 *
 *  - a SHUFFLE PRESS reorders the rows still to come — everything AFTER the
 *    audible user row. The audible row and the played rows above it are the
 *    listening log (QUEUE-DESIGN step 1), so they never move: the song playing
 *    keeps playing, and "Up next" is what changes. With the audible row in the
 *    AUTO section (or nothing active at all) every user row is still to come,
 *    so the whole section is shuffled and the anchor is untouched.
 *  - a repeat-all WRAP reorders the WHOLE section for the new pass, and makes
 *    sure the pass does not OPEN with the song that just finished (an
 *    immediate re-hear at the loop boundary is the one repeat a shuffle can
 *    always avoid).
 *
 * This is NOT the auto queue's shuffle: that one is the `random` tier of the
 * fill's own sort (`sortCore`), because suggestions are re-derived from the
 * library every fill. A user-queue shuffle permutes the ROWS the user built,
 * so it must be a real reorder of the stored section, not a sort rule.
 *
 * Pure by design (no stores, no Dexie, injected RNG): the edge cases — empty
 * section, a single row, duplicates, the audible row last, an auto anchor —
 * are unit-testable, and `queueManager` owns the single store write.
 */

/** Injected randomness (tests pass a deterministic sequence). */
export type ShuffleRng = () => number

function unit(random: ShuffleRng): number {
  const v = random()
  // Defensive: an injected RNG that returns a boundary value (or NaN) must
  // still index inside the array — a bad RNG is a call-site bug, never a
  // reason to drop a row (the permutation must keep every row).
  if (!Number.isFinite(v)) return 0
  return v <= 0 ? 0 : v >= 1 ? 0.9999999999 : v
}

/** Fisher–Yates over a COPY. Every input row appears exactly once. */
export function shuffleIds(ids: readonly string[], random: ShuffleRng = Math.random): string[] {
  const out = [...ids]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(unit(random) * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * A permutation that is guaranteed to DIFFER from the input when the section
 * can differ at all (≥2 rows, not every row the same song). `shuffleIds` alone
 * answers the input order once in a while — for a two-row queue that is half
 * the presses — and a shuffle button that visibly does nothing reads as broken.
 * The fallback swaps the first two rows, which is the smallest honest reorder.
 */
export function shuffleChanged(ids: readonly string[], random: ShuffleRng = Math.random): string[] {
  const out = shuffleIds(ids, random)
  if (out.length < 2 || !sameOrder(out, ids)) return out
  const tmp = out[0]
  out[0] = out[1]
  out[1] = tmp
  return out
}

/**
 * The first index a SHUFFLE PRESS may move: everything at or after it is still
 * to come. The audible user row and the played rows above it stay exactly
 * where they are.
 *
 * `0` when the anchor is not a user row (nothing active, or the audible row is
 * a suggestion): in both cases no user row has been played in this pass, so the
 * whole section is up next.
 */
export function shuffleFromIndex(userQueue: readonly string[], activeIndex: number): number {
  if (activeIndex < 0 || activeIndex >= userQueue.length) return 0
  return activeIndex + 1
}

/**
 * The user section a SHUFFLE PRESS produces, or `null` when the press has
 * nothing to reorder (fewer than two movable rows) — the caller must not write
 * the store then, so an inert press cannot churn a Dexie row or a native sync.
 *
 * The anchor index is unchanged by construction: the prefix (including the
 * audible row) is copied verbatim.
 */
export function planUserQueueShuffle(
  userQueue: readonly string[],
  activeIndex: number,
  random: ShuffleRng = Math.random,
): string[] | null {
  const from = shuffleFromIndex(userQueue, activeIndex)
  const movable = userQueue.slice(from)
  if (movable.length < 2) return null
  const shuffled = shuffleChanged(movable, random)
  if (sameOrder(shuffled, movable)) return null
  return [...userQueue.slice(0, from), ...shuffled]
}

/**
 * The user section a repeat-all WRAP produces (the pass that just ended has
 * re-entered at the top), or `null` when there is nothing to reorder.
 *
 * `justPlayedId` is the song that finished. When the shuffle lands it first it
 * is swapped with the first DIFFERENT song in the new order — the choice is
 * already random because the order was, so no second draw is needed. A section
 * holding only that one id cannot avoid it (correct: there is nothing else).
 */
export function planWrapShuffle(
  userQueue: readonly string[],
  justPlayedId?: string | null,
  random: ShuffleRng = Math.random,
): string[] | null {
  if (userQueue.length < 2) return null
  const shuffled = shuffleChanged(userQueue, random)
  if (justPlayedId !== undefined && justPlayedId !== null && shuffled[0] === justPlayedId) {
    const alt = shuffled.findIndex((id, i) => i > 0 && id !== justPlayedId)
    if (alt > 0) {
      const tmp = shuffled[0]
      shuffled[0] = shuffled[alt]
      shuffled[alt] = tmp
    }
  }
  return sameOrder(shuffled, userQueue) ? null : shuffled
}

/**
 * True when an engine-reported transition is a repeat-all WRAP: the LAST row
 * handed the pass back to the first row of a non-trivial queue.
 *
 * Used for the native engine, which owns the clock and wraps its own snapshot
 * (`nextIndex(after:) → 0` under loop-all), so the pass boundary is only
 * observable on the `trackChanged` event. A user-initiated jump to the first
 * row (a queue tap, Previous) does NOT satisfy it: those write the anchor
 * through their own paths and never present as last-row → first-row.
 */
export function isQueueWrap(prevIndex: number, nextIndex: number, total: number): boolean {
  return total > 1 && nextIndex === 0 && prevIndex === total - 1
}
