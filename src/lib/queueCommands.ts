import { get } from 'svelte/store'
import { autoQueueScope, currentTrack, playbackState, queue } from '../stores/appState'
import { findEntryIndex } from './queueOccurrence'
import { queueManager } from './queueManager'
import { playbackManager } from './playbackManager'

/**
 * Shared queue/playback commands for row-scoped actions (2026-11-04).
 *
 * These used to live inline in `QueueView` and the library row. The context
 * menu needs exactly the same behavior, and two copies of "remove the row and
 * skip if it was the playing one" would drift — so the semantics live HERE and
 * both the row buttons and the menu call them. Occurrence identity is the
 * contract: entries are resolved against the LIVE queue at execution time,
 * because a fill/advance/promotion landing while the menu is open reindexes the
 * combined list.
 */

/** Combined index of a queue occurrence, or -1 when that copy is gone. */
export function resolveQueueEntryIndex(entryId: string): number {
  const q = get(queue)
  return findEntryIndex(q.userQueue, q.autoQueue, entryId)
}

/**
 * Presses a queue ROW: the audible row restarts, any other row is a positional
 * play. Existing QueueView semantics, unchanged.
 */
export function playQueueIndex(combinedIndex: number): void {
  const q = get(queue)
  const id = [...q.userQueue, ...q.autoQueue][combinedIndex]
  if (id === undefined) return
  const isAudible =
    combinedIndex === q.activeIndex &&
    get(currentTrack)?.trackId === id &&
    get(playbackState) !== 'stopped'
  if (isAudible) playbackManager.seek(0)
  else void playbackManager.playTrackAt(combinedIndex)
}

/**
 * Removes the user-queue row at `combinedIndex` and asks playback to skip only
 * when the removed row was the PLAYING row. The "was active" fact is captured
 * before the write (afterwards the index means a different row).
 */
export function removeUserQueueIndex(combinedIndex: number): void {
  const q = get(queue)
  if (combinedIndex < 0 || combinedIndex >= q.userQueue.length) return
  const removedWasActive = combinedIndex === q.activeIndex
  const removedId = queueManager.removeFromUserQueue(combinedIndex)
  if (removedId !== undefined) void playbackManager.handleQueueRowRemoved(removedId, removedWasActive)
}

/**
 * A library press: clearing the auto-queue scope keeps an album/artist-scoped
 * suggestion tail from leaking into a plain library play. Matches the Songs
 * row's own press behavior.
 */
export function playLibraryTrack(trackId: string): void {
  autoQueueScope.set({})
  void playbackManager.playTrackById(trackId)
}

/**
 * The AUDIBLE row's play command: playing -> restart from the top, paused ->
 * resume where it stopped. playQueueIndex keeps the row's existing tap
 * semantics (a press always restarts), but a menu item labelled "Resume" must
 * actually resume — reloading the track at 0:00 would make the label a lie.
 */
export function restartOrResumeCurrent(): void {
  const state = get(playbackState)
  if (state === 'playing' || state === 'buffering') playbackManager.seek(0)
  else void playbackManager.togglePlayPause()
}
