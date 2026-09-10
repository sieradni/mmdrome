import { writable } from 'svelte/store'
import {
  applyPreloadEvent,
  type BufferedRange,
  type PreloadEntry,
  type PreloadEvent,
} from '$lib/loadStatus'

/**
 * Ephemeral playback load state (never persisted):
 * - `bufferedRanges`: normalized buffered TIME ranges of the current track's
 *   active element — the seek bar's gray layer. Written by `bufferMonitor`,
 *   read by every SeekBar. Empty on native (no HTMLAudio element there).
 * - `preloadEntries`: background-preload status per upcoming trackId —
 *   the queue-row tint + Now Playing segments. Written by the preloader.
 */
export const bufferedRanges = writable<BufferedRange[]>([])

export const preloadEntries = writable<Record<string, PreloadEntry>>({})

export function emitPreloadEvent(event: PreloadEvent): void {
  preloadEntries.update((map) => applyPreloadEvent(map, event))
}

/** Test isolation — the preloader also calls this from `__resetForTests`. */
export function resetLoadStatusForTests(): void {
  bufferedRanges.set([])
  preloadEntries.set({})
}
