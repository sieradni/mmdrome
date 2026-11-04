import { get } from 'svelte/store'
import {
  autoQueueScope,
  currentTrack,
  library,
  metadataCache,
  playbackState,
  queue,
  type Track,
} from '../stores/appState'
import { selection, clearSelection } from '../stores/selectionStore'
import { findEntryIndex } from './queueOccurrence'
import { queueManager } from './queueManager'
import { playbackManager } from './playbackManager'
import { commitFeedback } from './feedbackService'

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

/**
 * Multi-select commands (2026-11-04). The ONE execution layer for the
 * selection bar AND the batch context menu, exactly like the single-row
 * commands above: a selection edits the LIVE queue, so every entry id is
 * re-resolved at execution time (a fill/advance landing while the menu is open
 * must not address a different row).
 *
 * Two invariants hold for every batch action:
 *  - the AUDIBLE row is never deleted (removal skips it; "set as user queue"
 *    prepends it when it is not selected) — playback must not be stranded;
 *  - actions operate on occurrences, in the selection's own order, so a
 *    repeated song is queued as many times as the user selected it.
 */

/** The active selection's track ids, in the surface's own order. */
export function selectedTrackIds(): string[] {
  const state = get(selection)
  if (state.keys.length === 0) return []
  if (state.surface === 'library') return [...state.keys]
  const q = get(queue)
  const combined = [...q.userQueue, ...q.autoQueue]
  return state.keys
    .map((entryId) => findEntryIndex(q.userQueue, q.autoQueue, entryId))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
    .map((index) => combined[index])
}

/** Resolved section-local indices of the queue selection. */
function selectedQueueIndices(): { user: number[]; auto: number[]; activeSelected: boolean } {
  const state = get(selection)
  const q = get(queue)
  const user: number[] = []
  const auto: number[] = []
  let activeSelected = false
  if (state.surface !== 'queue') return { user, auto, activeSelected }
  for (const entryId of state.keys) {
    const index = findEntryIndex(q.userQueue, q.autoQueue, entryId)
    if (index < 0) continue
    if (index === q.activeIndex) activeSelected = true
    if (index < q.userQueue.length) user.push(index)
    else auto.push(index - q.userQueue.length)
  }
  return { user: user.sort((a, b) => a - b), auto: auto.sort((a, b) => a - b), activeSelected }
}

/** Library selection → insert right after the audible row. */
export function applySelectionPlayNext(): void {
  const state = get(selection)
  if (state.surface !== 'library' || state.keys.length === 0) return
  queueManager.playNextMany(state.keys)
  clearSelection()
}

/**
 * "Add to queue": appended occurrences for a library selection; for a queue
 * selection, the AUTO rows it holds become user rows (user rows already are).
 */
export function applySelectionAddToQueue(): void {
  const state = get(selection)
  if (state.keys.length === 0) return
  if (state.surface === 'library') {
    queueManager.addManyToUserQueue(state.keys)
    clearSelection()
    return
  }
  const { auto } = selectedQueueIndices()
  if (auto.length > 0) queueManager.promoteManyToUser(auto)
  clearSelection()
}

/** "Set as user queue": the selection REPLACES the user queue, in order. */
export function applySelectionSetUserQueue(): void {
  const ids = selectedTrackIds()
  if (ids.length === 0) return
  queueManager.replaceUserQueue(ids)
  clearSelection()
}

/**
 * Removes the selected queue rows in one write. The audible row is skipped by
 * design: a selection that includes the playing song must not delete it (the
 * queue would point past its own audio) — deselect or reject it first.
 */
export function applySelectionRemove(): void {
  const { user, auto, activeSelected } = selectedQueueIndices()
  if (user.length === 0 && auto.length === 0) return
  const q = get(queue)
  const removableUser = user.filter((index) => index !== q.activeIndex)
  const removableAuto = auto.filter((index) => q.userQueue.length + index !== q.activeIndex)
  if (removableUser.length === 0 && removableAuto.length === 0) {
    if (activeSelected) clearSelection()
    return
  }
  queueManager.removeRows(removableUser, removableAuto)
  clearSelection()
}

/**
 * The "Loved" batch toggle: love every selected song unless they are ALL
 * already loved, in which case the batch un-loves them. One rule for the whole
 * set — a mixed selection resolves to "love all", which is what the label's
 * absent check mark promises.
 */
export function applySelectionLove(): void {
  applySelectionFeedback(undefined, 'toggle')
}

export function applySelectionRating(rating: number): void {
  applySelectionFeedback(rating)
}

function applySelectionFeedback(rating: number | undefined, mode: 'set' | 'toggle' = 'set'): void {
  // Dedupe by ID: a queue selection holds occurrences, so the same song can be
  // in the set several times — one write per SONG, not per row.
  const ids = [...new Set(selectedTrackIds())]
  if (ids.length === 0) return
  const cache = get(metadataCache)
  const byId = new Map<string, Track>(get(library).map((track) => [track.trackId, track] as const))
  const allLoved = ids.every((id) => cache.get(id)?.loved ?? false)
  for (const id of ids) {
    const track = byId.get(id)
    if (!track) continue
    const meta = cache.get(id)
    const nextLoved = mode === 'toggle' ? !allLoved : (meta?.loved ?? false)
    commitFeedback(track, rating ?? meta?.rating ?? 0, nextLoved)
  }
}

/** "Convert up to here" on one auto row: the suggestion prefix becomes user rows. */
export function convertAutoUpToEntry(entryId: string): void {
  const q = get(queue)
  const index = findEntryIndex(q.userQueue, q.autoQueue, entryId)
  if (index < q.userQueue.length) return
  queueManager.convertAutoUpTo(index - q.userQueue.length)
}
