/**
 * Pure reload-reconcile decision for the native engine (TODO 1.0 Step 4,
 * item 1.5 JS side).
 *
 * After a webview reload the native engine keeps playing while the JS side
 * shows nothing (the stores reset), and the first `play()` would kill the
 * engine via `setQueue`. `_initNative` calls `getState()` and maps the engine
 * state through this function to a verdict:
 *  - `idle` — the engine has no audible track; nothing to resync.
 *  - `resync` — the engine plays a library-known track; the manager adopts
 *    it (currentTrack/playbackState/activeIndex + position). `index` is the
 *    COMBINED QUEUE's indexOf (reconcile by trackId, NEVER by
 *    `state.index` — E7: the engine's index refers to the last-sent
 *    snapshot, which queue mutations may have reindexed). `index: -1` means
 *    the track left the combined queue — the manager re-adopts it exactly
 *    like `_onNativeTrackChanged`'s idx<0 branch.
 *  - `stop` — the engine plays a track unknown to the library; warn + stop
 *    (the honest signal — the UI cannot represent what it cannot identify).
 *
 * No deferral is needed: App.svelte awaits `loadLibraryFromNavidrome()`
 * BEFORE `playbackManager.init()` (verified 2026-08-13), so the library and
 * the Dexie-restored queue are populated before `_initNative` runs. The
 * `isKnown` predicate is supplied by the manager (it owns the library).
 */

/** The engine-state surface this decision reads (structurally satisfied by `NativeEngineState`). */
export interface NativeReconcileState {
  trackId: string
  playing: boolean
  position: number
}

export type NativeReconcileResult =
  | { kind: 'idle' }
  | { kind: 'resync'; trackId: string; index: number; position: number }
  | { kind: 'stop' }

export function reconcileReload(
  state: NativeReconcileState,
  combined: string[],
  isKnown: (trackId: string) => boolean,
): NativeReconcileResult {
  if (!state.playing || !state.trackId) return { kind: 'idle' }
  if (!isKnown(state.trackId)) return { kind: 'stop' }
  return {
    kind: 'resync',
    trackId: state.trackId,
    index: combined.indexOf(state.trackId),
    position: state.position,
  }
}