/**
 * Playback-position intent latch (2026-10-07, Phase 1 of the seek-intent plan
 * `docs/plans/2026-10-07-seek-intent-and-stream-epochs.md`).
 *
 * A playback position is an INTENT that must outlive the input event that
 * carried it. A scrub can land while the row's source does not exist yet — the
 * first staged schedule has not opened, a download is still in flight, an
 * engage has not settled — and the three load paths used to hard-write 0:00,
 * so the intent died between the scrub and the first byte (the reported
 * "seek into an unloaded region, press play, back to 0:00").
 *
 * The latch is armed ONLY when `PlaybackManager.seek` cannot deliver the
 * position to the engine layer at issue time. That narrow arming is what keeps
 * it safe: a deliverable seek is NOT latched, so a later fresh play of the
 * same row still starts at 0.
 *
 * Rules:
 *   - latest-wins (a newer scrub replaces the parked intent, generation++);
 *   - row-scoped (the intent belongs to the trackId it was issued against);
 *   - single-use: the load path consumes it; a consume against a DIFFERENT
 *     row means the app moved on, so it clears without applying.
 *
 * Pure module — no stores, no DOM, no Dexie. The manager owns one instance.
 */

export interface SeekIntent {
  trackId: string
  position: number
  generation: number
}

export interface SeekIntentState {
  intent: SeekIntent | null
  generation: number
}

export const createSeekIntentState = (): SeekIntentState => ({ intent: null, generation: 0 })

/** Arms (or replaces — latest-wins) the parked intent for `trackId`. */
export function latchSeekIntent(state: SeekIntentState, trackId: string, position: number): SeekIntent {
  const intent: SeekIntent = { trackId, position, generation: ++state.generation }
  state.intent = intent
  return intent
}

/**
 * Spends the parked intent: returns it when it belongs to `trackId`, else
 * null. EITHER WAY the slot is cleared — a consume attempt against another row
 * is the app having moved on (advance, skip, stop), and a surviving intent
 * must never apply to a later fresh load of the old row.
 */
export function consumeSeekIntent(state: SeekIntentState, trackId: string): SeekIntent | null {
  const intent = state.intent
  if (intent === null) return null
  state.intent = null
  return intent.trackId === trackId ? intent : null
}

/** Drops any parked intent (session stop/teardown). */
export function clearSeekIntent(state: SeekIntentState): void {
  state.intent = null
}
