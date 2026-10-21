import { get } from 'svelte/store'
import { persistQueue } from './queuePersistence'
import { planAutoQueueFill, selectAutoQueueFill, type AutoQueuePlanState } from './autoQueuePlan'
import { inscribeRecent, RECENT_LIMIT } from './recentWindow'
import { syncFillProvenance } from './queueProvenance'
import * as queueMutation from './queueMutation'
import {
  queue,
  library,
  shuffleEnabled,
  autoQueueFilters,
  autoQueueSort,
  metadataCache,
  queueWrapNotice,
  autoQueueEmptyNotice,
  currentTrack,
} from '../stores/appState'
import type { Track, QueueState } from '../stores/appState'

const MAX_AUTO_QUEUE = 50

class QueueManager {
  getCombinedQueue(): string[] {
    const q = get(queue)
    return [...q.userQueue, ...q.autoQueue]
  }

  /** Snapshot of every store the fill plan reads — the thin-glue seam. The
   *  combined queue is derived from the SAME snapshot `q`, so `activeId` can
   *  never disagree with the userQueue/autoQueue the plan is built against. */
  private _planState(): AutoQueuePlanState {
    const q = get(queue)
    const combined = [...q.userQueue, ...q.autoQueue]
    return {
      library: get(library),
      userQueue: q.userQueue,
      autoQueue: q.autoQueue,
      recentTrackIds: q.recentTrackIds,
      activeId: combined[q.activeIndex],
      shuffle: get(shuffleEnabled),
      // The auto queue follows its OWN sort (2026-09-29 decoupling) — the
      // shared library sort is a view concern and never re-ranks the fill.
      sort: get(autoQueueSort),
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
   * (section rewrites, OCCURRENCE re-anchor, `null` no-op, dev invariant
   * assert) lives in the pure `queueMutation` module; this method only binds it
   * to the store and persists.
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
      persistQueue('mutateQueue', updated)
      return updated
    })
  }

  /** Appends a NEW occurrence of a track to the end of the user queue (D2:
   *  duplicates are legal — pressing + twice queues the song twice). */
  addToUserQueue(trackId: string): void {
    this._mutateQueue((q) => queueMutation.addToUserQueue(q, trackId))
  }

  /**
   * "Play next" (press-driven insert, D2/step 2): adds a NEW user occurrence
   * right after the active row. It never relocates an existing copy — a copy
   * above the anchor is history, and moving it would rewrite the log.
   */
  playNext(trackId: string): void {
    this._mutateQueue((q) => queueMutation.playNext(q, trackId))
  }

  /**
   * A PRESS on a song outside the queue (D1): start THAT song. Drops the id's
   * auto occurrence(s), appends a new user occurrence at the tail, anchors it
   * and cools the previous audible row. No-op when the press IS the audible
   * row (the manager resumes/restarts it instead).
   *
   * Anchor-CHANGING write by design (the anchor moves to the appended row), so
   * it bypasses `_mutateQueue`'s preserve-the-audible-occurrence contract and
   * persists through the same choke point every other write uses.
   */
  selectTrack(trackId: string): void {
    queue.update((q) => {
      const updated = queueMutation.pressTrack(q, trackId)
      if (updated === null) return q
      persistQueue('selectTrack', updated)
      return updated
    })
  }

  /** Moves the auto OCCURRENCE at `autoIndex` to the end of the user queue
   *  (promoting the in-window active occurrence is a plain promote). */
  promoteToUser(autoIndex: number): void {
    this._mutateQueue((q) => queueMutation.promoteToUser(q, autoIndex))
  }

  /**
   * Moves the auto OCCURRENCE at `autoIndex` to the slot right after the
   * active row. When that occurrence IS the active row, this degrades to a
   * plain promote — the playing track can only leave auto by being promoted.
   */
  promoteToUserNext(autoIndex: number): void {
    const q = get(queue)
    if (q.activeIndex === q.userQueue.length + autoIndex) {
      this.promoteActiveTrack()
      return
    }
    this._mutateQueue((q) => queueMutation.promoteToUserNext(q, autoIndex))
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

  /** Row-scoped reorder: moves the user OCCURRENCE at `index` right after the
   *  active row. Duplicates make the id-taking form ambiguous; the view always
   *  knows the row it rendered. */
  moveRowToNext(index: number): void {
    this._mutateQueue((q) => queueMutation.moveUserRowToNext(q, index))
  }

  /** Row-scoped reorder: moves the user OCCURRENCE at `index` to the end. */
  moveRowToEnd(index: number): void {
    this._mutateQueue((q) => queueMutation.moveUserRowToEnd(q, index))
  }

  /**
   * Promotes the active track out of the auto queue — the post-load success
   * path. Appends a NEW user occurrence at the boundary (D5) and slices the
   * auto tail after the promoted row; an older user copy of the same id stays
   * where it is as history. No-op (null, no write) when the active occurrence
   * isn't in auto.
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
      persistQueue('markRecent', updated)
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
      persistQueue('advanceTo', updated)
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
      persistQueue('resetRecentWindow', updated)
      return updated
    })
  }

  /**
   * "Not now": removes the auto OCCURRENCE at `autoIndex` and cools it down so the next fill
   * doesn't immediately re-suggest it (replenish excludes the window; only a
   * short pool admits it back). When the target IS the in-window active row,
   * this degrades to a plain promote — the playing track can only leave the
   * auto side by being promoted up. The recency mark folds into the same write
   * (single saveQueue per mutation).
   */
  removeFromAutoQueue(autoIndex: number): void {
    const q = get(queue)
    if (autoIndex < 0 || autoIndex >= q.autoQueue.length) return
    if (q.activeIndex === q.userQueue.length + autoIndex) {
      this.promoteActiveTrack()
      return
    }
    this._mutateQueue((q) => queueMutation.removeFromAutoQueue(q, autoIndex))
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
      persistQueue('removeFromUserQueue', updated)
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

  /** Removes user-queue rows above the active row (the played pile). */
  clearUserAboveActive(): void {
    this._mutateQueue((q) => queueMutation.clearUserAboveActive(q))
  }

  /** Removes user-queue rows below the active row (everything queued after). */
  clearUserBelowActive(): void {
    this._mutateQueue((q) => queueMutation.clearUserBelowActive(q))
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
   * Drag-and-drop resolution (2026-09-12; occurrence identity 2026-10-21): the
   * dragged row is an OCCURRENCE (`queueEntryId`) and the plan is computed from the drag-time sections (what the user
   * saw) then reconciled against the CURRENT store — never a verbatim write
   * of the drag-start snapshot. The old path (`reorderAll` from the preview
   * arrays) let any mutation landing mid-drag (natural advance, promotion,
   * fill re-rank) be silently overwritten by the stale order, and the stale
   * preloaded row played next. Anchor-preserving via `_mutateQueue`.
   */
  applyDragDrop(draggedEntryId: string, targetCombinedIndex: number, dragStartUser: string[], dragStartAuto: string[]): void {
    this._mutateQueue((q) => queueMutation.applyDragDrop(q, draggedEntryId, targetCombinedIndex, dragStartUser, dragStartAuto))
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
    persistQueue('playAll', updated)
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
    const fill = selectAutoQueueFill(plan, needed)
    if (fill.length === 0 && plan.kept.length === state.autoQueue.length) {
      autoQueueEmptyNotice.set(true)
      return
    }
    autoQueueEmptyNotice.set(fill.length === 0)
    const fillIds = fill.map((t) => t.trackId)
    queue.update((q) => {
      const updated = { ...q, autoQueue: [...plan.kept, ...fillIds] }
      // Fill provenance (2026-09-27): mirror the plan's tier membership for
      // the HUD Copy dump. Inside the store update so the map always matches
      // the WRITTEN queue, never a racy pre-update snapshot. The plan's tier
      // arrays cover every candidate; only the SLICED fillIds land here, and
      // syncFillProvenance keeps kept-prefix rows on their older tier.
      syncFillProvenance(updated.autoQueue, plan.tiers)
      persistQueue('replenishAutoQueue', updated)
      return updated
    })
  }

  /** Rebuilds the whole auto queue (keepAuto: false — shuffle/sort flips).
   *  The fill ALWAYS continues from the anchor (the last user-queue entry —
   *  the point playback is headed from) in the new order, so an explicit
   *  sort change keeps the current position and fills the upcoming songs
   *  exactly as a fresh library view would order them. */
  rebuildAutoQueue(): void {
    const state = this._planState()
    const plan = planAutoQueueFill(state, MAX_AUTO_QUEUE, { keepAuto: false })
    queueWrapNotice.set(plan.wrapNotice)
    autoQueueEmptyNotice.set(plan.pool.length === 0)
    const fillIds = selectAutoQueueFill(plan, MAX_AUTO_QUEUE).map((t) => t.trackId)

    queue.update((q) => {
      const updated = { ...q, autoQueue: fillIds }
      syncFillProvenance(updated.autoQueue, plan.tiers)
      persistQueue('rebuildAutoQueue', updated)
      return updated
    })
  }

}

export const queueManager = new QueueManager()