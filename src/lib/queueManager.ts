import { get } from 'svelte/store'
import { saveQueue } from './db'
import { libraryFilters } from './libraryFilters'
import { planAutoQueueFill, type AutoQueuePlanState } from './autoQueuePlan'
import { inscribeRecent, RECENT_LIMIT } from './recentWindow'
import * as queueMutation from './queueMutation'
import {
  queue,
  library,
  shuffleEnabled,
  autoQueueFilters,
  metadataCache,
  queueWrapNotice,
  autoQueueEmptyNotice,
  currentTrack,
} from '../stores/appState'
import type { Track, QueueState } from '../stores/appState'

const MAX_AUTO_QUEUE = 50

/** Fisher–Yates in place. The fill plan returns `shuffle` as data; the
 *  manager permutes the FULL pool here, BEFORE slicing — slicing a
 *  pre-permuted pool is a uniform sample, slicing first is not (parity). */
function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

class QueueManager {
  getCombinedQueue(): string[] {
    const q = get(queue)
    return [...q.userQueue, ...q.autoQueue]
  }

  /** Snapshot of every store the fill plan reads — the thin-glue seam. */
  private _planState(): AutoQueuePlanState {
    const q = get(queue)
    return {
      library: get(library),
      userQueue: q.userQueue,
      autoQueue: q.autoQueue,
      recentTrackIds: q.recentTrackIds,
      activeId: this.getCombinedQueue()[q.activeIndex],
      shuffle: get(shuffleEnabled),
      sort: get(libraryFilters),
      filters: get(autoQueueFilters),
      meta: get(metadataCache),
    }
  }

  findTrack(trackId: string): Track | undefined {
    return get(library).find((t) => t.trackId === trackId)
  }

  /**
   * Single-write choke point for ANCHOR-PRESERVING queue edits — user-initiated
   * mutations that must not move the playing-track anchor. The mutation algebra
   * (section rewrites, id re-anchor, `null` no-op, dev invariant assert) lives
   * in the pure `queueMutation` module; this method only binds it to the store
   * and persists.
   *
   * Scope boundary: anchor-CHANGING writes are a separate single-writer family
   * and must NOT route here — `advanceTo` (and the native re-adopt in
   * playbackManager) move the active id, so re-anchoring would target the
   * retired track; `removeFromUserQueue` anchors to position, not id (the id is
   * gone — `indexOf` fails by construction).
   */
  private _mutateQueue(mutate: (q: QueueState) => queueMutation.QueueMutation | null): void {
    queue.update((q) => {
      const updated = queueMutation.applyQueueMutation(q, mutate)
      if (updated === null) return q
      saveQueue(updated)
      return updated
    })
  }

  /** Appends a track to the end of the user queue (no-op when it already has a user slot — uniqueness). */
  addToUserQueue(trackId: string): void {
    this._mutateQueue((q) => queueMutation.addToUserQueue(q, trackId))
  }

  /**
   * Inserts a track right after the active row (clamped to the user tail when
   * the active row sits in the auto queue); moves an already-queued copy
   * instead of duplicating it.
   */
  playNext(trackId: string): void {
    this._mutateQueue((q) => queueMutation.playNext(q, trackId))
  }

  /** Moves an auto row to the end of the user queue (promoting the in-window active row is a plain promote). */
  promoteToUser(trackId: string): void {
    this._mutateQueue((q) => queueMutation.promoteToUser(q, trackId))
  }

  /**
   * Moves an auto row to the slot right after the active row. When the target
   * IS the in-window active row, this degrades to a plain promote — the playing
   * track can only leave the auto side by being promoted up.
   */
  promoteToUserNext(trackId: string): void {
    const q = get(queue)
    const combined = [...q.userQueue, ...q.autoQueue]
    if (q.activeIndex >= 0 && q.activeIndex < combined.length && combined[q.activeIndex] === trackId) {
      this.promoteActiveTrack()
      return
    }
    this._mutateQueue((q) => queueMutation.promoteToUserNext(q, trackId))
  }

  /**
   * Reorders a user row to just after the active row (clamped to the user tail
   * when the active row sits in the auto queue). No-ops — `null`, no write —
   * when the row is missing or already in place.
   */
  moveToNext(trackId: string): void {
    this._mutateQueue((q) => queueMutation.moveToNext(q, trackId))
  }

  /** Moves a user row to the very end of the user queue. */
  moveToEnd(trackId: string): void {
    this._mutateQueue((q) => queueMutation.moveToEnd(q, trackId))
  }

  /**
   * Promotes the active track out of the auto queue — the post-load success
   * path. The auto tail is sliced from the active id's first occurrence and
   * the id gains a user slot only when it has none (a tier-3 cross-section
   * duplicate collapses instead of appending a repeat). No-op (null, no write)
   * when the active row isn't in auto (already promoted, or the id lives only
   * in the user queue).
   */
  promoteActiveTrack(): void {
    this._mutateQueue((q) => queueMutation.promoteActiveTrack(q))
  }

  /**
   * Marks a track as recently heard/skipped — the single write path for the
   * anti-repeat window. Callers that can fold the mark into the same update as
   * an index change should prefer `advanceTo` over this (one saveQueue, one
   * native queue-sync per transition).
   */
  markRecent(trackId: string): void {
    queue.update((q) => {
      const updated = { ...q, recentTrackIds: inscribeRecent(q.recentTrackIds, trackId, RECENT_LIMIT) }
      saveQueue(updated)
      return updated
    })
  }

  /**
   * Sets the active index and optionally marks the leaving track in the same
   * queue update. `markRecentId` should be the track that held the active slot
   * before the jump (ended, skipped, or jumped away from) — or undefined when
   * the active track stays (loop-one restart, plain index fixes).
   */
  advanceTo(index: number, markRecentId?: string): void {
    queue.update((q) => {
      const updated = {
        ...q,
        activeIndex: index,
        recentTrackIds: markRecentId ? inscribeRecent(q.recentTrackIds, markRecentId, RECENT_LIMIT) : q.recentTrackIds,
      }
      saveQueue(updated)
      return updated
    })
  }

  /**
   * Drops the anti-repeat window entirely. Used by explicit bulk replay flows
   * (Play All) — the user's overt "play this now" supersedes recency memory.
   */
  resetRecentWindow(): void {
    queue.update((q) => {
      if (q.recentTrackIds.length === 0) return q
      const updated = { ...q, recentTrackIds: [] }
      saveQueue(updated)
      return updated
    })
  }

  /**
   * "Not now": removes an auto-queued track and cools it down so the next fill
   * doesn't immediately re-suggest it (replenish excludes the window; only a
   * short pool admits it back). When the target IS the in-window active row,
   * this degrades to a plain promote — the playing track can only leave the
   * auto side by being promoted up. The recency mark folds into the same write
   * (single saveQueue per mutation).
   */
  removeFromAutoQueue(trackId: string): void {
    const q = get(queue)
    const combined = [...q.userQueue, ...q.autoQueue]
    if (q.activeIndex >= 0 && q.activeIndex < combined.length && combined[q.activeIndex] === trackId) {
      this.promoteActiveTrack()
      return
    }
    this._mutateQueue((q) => queueMutation.removeFromAutoQueue(q, trackId))
  }

  /**
   * Removes a user-queue row; the removed track cools down too, so it can't
   * instantly re-enter through auto-fill (removal intent is "not now").
   * DELIBERATE DEVIATION from the `_mutateQueue` re-anchor rule: removal
   * anchors to POSITION, not the id — the id may be gone (removing the active
   * row), so `indexOf` would fail by construction. Semantics live in the pure
   * `queueMutation.removeFromUserQueue` (2.4 option b: removing the active row
   * keeps the index so the highlight slides to the next playable row).
   * Returns the removed track id (undefined for an out-of-range no-op) so the
   * caller can react when the PLAYING row was removed (2.7: skip now, both
   * platforms).
   */
  removeFromUserQueue(index: number): string | undefined {
    const removedId = get(queue).userQueue[index]
    queue.update((q) => {
      const updated = queueMutation.removeFromUserQueue(q, index)
      if (updated === null) return q
      saveQueue(updated)
      return updated
    })
    return removedId
  }

  /**
   * Empties the queue down to the actively playing track (kept at user[0]).
   * The anti-repeat window is deliberately PRESERVED — a clear is an explicit
   * queue edit, not a "just heard it" event (asymmetric by intent vs. the
   * Play All flows, which reset the window).
   */
  clearQueue(): void {
    this._mutateQueue((q) => queueMutation.clearQueue(q))
  }

  /**
   * Replaces both queue sections wholesale — the drag-reorder path (QueueView
   * `applyDrop`). The active row is re-anchored by its id (first surviving
   * occurrence, matching the drag preview), or −1 when nothing is active.
   */
  reorderAll(userQueue: string[], autoQueue: string[]): void {
    this._mutateQueue(() => ({ userQueue, autoQueue }))
  }

  /**
   * Full replacement for Play All flows: the user queue becomes the given
   * tracks, the auto queue is cleared, and the active index points at the
   * first track (the caller starts playback right after via `playTrackAt(0)`).
   * Deliberately NOT routed through `_mutateQueue`'s id re-anchor — the
   * previous active track is replaced wholesale, so the intended active id is
   * the new first track, not a survivor. Also resets the recency window:
   * explicit bulk replay supersedes anti-repeat memory.
   */
  playAll(trackIds: string[]): void {
    const updated: QueueState = { ...get(queue), userQueue: trackIds, autoQueue: [], activeIndex: 0 }
    queue.set(updated)
    saveQueue(updated)
    this.resetRecentWindow()
  }

  advanceQueue(): Track | null {
    const q = get(queue)
    const combined = this.getCombinedQueue()
    const playingId = get(currentTrack)?.trackId
    const currentId = q.activeIndex >= 0 && q.activeIndex < combined.length ? combined[q.activeIndex] : undefined
    const nextIndex = queueMutation.advanceTargetIndex(q, combined, playingId)
    // The track leaving the active slot: normally `currentId` (the ended
    // track); after an active-row removal it's the removed PLAYING track
    // (already inscribed by the removal — re-inscribing is idempotent). Never
    // the next row: pre-marking it would cool it down before it plays.
    const leavingId = (playingId ?? currentId) ?? undefined
    if (nextIndex >= 0 && nextIndex < combined.length) {
      this.advanceTo(nextIndex, leavingId)
      this.replenishAutoQueue()
      return this.findTrack(combined[nextIndex]) ?? null
    }

    // Queue end reached: try to refill past the end. The heard track leaves the
    // active slot either way, so its mark folds into the advance write when a
    // refill exists; when nothing follows, mark it standalone (the caller may
    // wrap or stop) — it must enter the window even if playback halts here.
    this.replenishAutoQueue()
    const updatedCombined = this.getCombinedQueue()
    if (nextIndex >= 0 && nextIndex < updatedCombined.length) {
      this.advanceTo(nextIndex, leavingId)
      return this.findTrack(updatedCombined[nextIndex]) ?? null
    }

    if (currentId) this.markRecent(currentId)
    return null
  }

  /**
   * Replenishes the auto queue (keepAuto): the plan keeps the still-matching
   * queued prefix, fills up to MAX from its tiers, and reports the wrap hint.
   * The two no-op guards (queue already full; nothing addable and nothing
   * dropped) skip the Dexie write — the wrap hint is false for an empty pool,
   * so the old explicit resets in those guards are subsumed by plan.wrapNotice.
   */
  replenishAutoQueue(): void {
    const state = this._planState()
    const plan = planAutoQueueFill(state, MAX_AUTO_QUEUE, { keepAuto: true })
    queueWrapNotice.set(plan.wrapNotice)
    const needed = Math.max(0, MAX_AUTO_QUEUE - plan.kept.length)
    if (needed === 0) {
      autoQueueEmptyNotice.set(false)
      return
    }
    const fill = (plan.shuffle ? shuffleInPlace(plan.pool) : plan.pool).slice(0, needed)
    if (fill.length === 0 && plan.kept.length === state.autoQueue.length) {
      autoQueueEmptyNotice.set(true)
      return
    }
    autoQueueEmptyNotice.set(fill.length === 0)
    const fillIds = fill.map((t) => t.trackId)
    queue.update((q) => {
      const updated = { ...q, autoQueue: [...plan.kept, ...fillIds] }
      saveQueue(updated)
      return updated
    })
  }

  /** Rebuilds the whole auto queue (keepAuto: false — shuffle/sort flips). */
  rebuildAutoQueue(): void {
    const state = this._planState()
    const plan = planAutoQueueFill(state, MAX_AUTO_QUEUE, { keepAuto: false })
    queueWrapNotice.set(plan.wrapNotice)
    autoQueueEmptyNotice.set(plan.pool.length === 0)
    const ordered = plan.shuffle ? shuffleInPlace(plan.pool) : plan.pool
    const fillIds = ordered.slice(0, MAX_AUTO_QUEUE).map((t) => t.trackId)

    queue.update((q) => {
      const updated = { ...q, autoQueue: fillIds }
      saveQueue(updated)
      return updated
    })
  }

}

export const queueManager = new QueueManager()