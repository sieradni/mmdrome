import { get } from 'svelte/store'
import { saveQueue } from './db'
import { libraryFilters, trackMatchesGenre } from './libraryFilters'
import { inscribeRecent, RECENT_LIMIT } from './recentWindow'
import * as queueMutation from './queueMutation'
import {
  queue,
  library,
  shuffleEnabled,
  autoQueueFilters,
  metadataCache,
  queueWrapNotice,
  currentTrack,
} from '../stores/appState'
import type { Track, AutoQueueFilters, QueueState } from '../stores/appState'
import type { LocalMetadataStore } from './db'

const MAX_AUTO_QUEUE = 50

class QueueManager {
  getCombinedQueue(): string[] {
    const q = get(queue)
    return [...q.userQueue, ...q.autoQueue]
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
   */
  removeFromUserQueue(index: number): void {
    queue.update((q) => {
      const updated = queueMutation.removeFromUserQueue(q, index)
      if (updated === null) return q
      saveQueue(updated)
      return updated
    })
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
   * Builds a mode-treated (shuffled or sort+anchor-rotated) pool of up to
   * `needed` auto-fill candidates using three tiers:
   *  1. fresh — filter-matching library tracks that are neither queued nor cooling down;
   *  2. top-up — cooling-down tracks (recently heard/skipped/removed) that match the
   *     filters, admitted when the fresh pool is short (recency relaxes before anything else);
   *  3. rotation — every filter-matching track not already sitting in the auto queue and
   *     not the actively playing one, admitted when the pool still can't be filled; the
   *     session recycles instead of the queue silently dying.
   * `keepAuto` marks a replenish (present auto tracks must never duplicate, since the
   * kept prefix is re-appended) vs. a rebuild (the whole auto queue is replaced).
   */
  private _buildPool(needed: number, opts: { keepAuto: boolean }): Track[] {
    const q = get(queue)
    const lib = get(library)
    const shuffle = get(shuffleEnabled)
    const filters = get(autoQueueFilters)
    const meta = get(metadataCache)

    const inAuto = new Set(opts.keepAuto ? q.autoQueue : [])
    const inUser = new Set(q.userQueue)
    const recent = new Set(q.recentTrackIds)
    const activeId = this.getCombinedQueue()[q.activeIndex]
    const matches = (t: Track) => this._matchesAutoQueueFilters(t, filters, meta)

    let pool = lib.filter((t) => matches(t) && !inUser.has(t.trackId) && !inAuto.has(t.trackId) && !recent.has(t.trackId))
    if (pool.length < needed) {
      pool = pool.concat(lib.filter((t) => matches(t) && !inUser.has(t.trackId) && !inAuto.has(t.trackId) && recent.has(t.trackId)))
    }
    if (pool.length < needed) {
      const poolIds = new Set(pool.map((t) => t.trackId))
      pool = pool.concat(lib.filter((t) => matches(t) && !inAuto.has(t.trackId) && t.trackId !== activeId && !poolIds.has(t.trackId)))
    }

    if (pool.length > 0) {
      if (shuffle) {
        queueWrapNotice.set(false)
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]]
        }
      } else {
        const orderRank = this._buildOrderRank(meta)
        pool.sort((a, b) => (orderRank.get(a.trackId) ?? 0) - (orderRank.get(b.trackId) ?? 0))
        pool = this._rotateAfterAnchor(pool, orderRank, q.userQueue[q.userQueue.length - 1])
      }
    } else {
      // Nothing eligible: the wrap hint is meaningless for an empty fill — clear
      // any `true` left by an earlier top-of-sort rotation (rebuild paths reach
      // here with no _rotateAfterAnchor/shuffle-branch to reset it).
      queueWrapNotice.set(false)
    }
    return pool
  }

  replenishAutoQueue(): void {
    const q = get(queue)
    const lib = get(library)
    const libById = new Map(lib.map((t) => [t.trackId, t]))
    const filters = get(autoQueueFilters)
    const meta = get(metadataCache)

    const keptAuto = q.autoQueue.filter((id) => {
      const t = libById.get(id)
      return t && this._matchesAutoQueueFilters(t, filters, meta)
    })

    const needed = Math.max(0, MAX_AUTO_QUEUE - keptAuto.length)
    if (needed === 0) {
      queueWrapNotice.set(false)
      return
    }

    const fill = this._buildPool(needed, { keepAuto: true }).slice(0, needed)
    if (fill.length === 0 && keptAuto.length === q.autoQueue.length) {
      queueWrapNotice.set(false)
      return
    }

    const fillIds = fill.map((t) => t.trackId)
    queue.update((q) => {
      const updated = { ...q, autoQueue: [...keptAuto, ...fillIds] }
      saveQueue(updated)
      return updated
    })
  }

  rebuildAutoQueue(): void {
    const pool = this._buildPool(MAX_AUTO_QUEUE, { keepAuto: false })
    const fillIds = pool.slice(0, MAX_AUTO_QUEUE).map((t) => t.trackId)

    queue.update((q) => {
      const updated = { ...q, autoQueue: fillIds }
      saveQueue(updated)
      return updated
    })
  }

  /**
   * Builds a rank map for every library track using the shared library-filter
   * sort ordering (the same order shown in the Songs view). When no sort is
   * active, ranks equal the library index (library-order fallback, matching the
   * pre-existing behavior). Tie values are broken by library index so the order
   * is always total and the anchor rotation below is deterministic.
   */
  private _buildOrderRank(meta: Map<string, LocalMetadataStore>): Map<string, number> {
    const lib = get(library)
    const f = get(libraryFilters)
    const base = lib.map((t, i) => [t, i] as const)
    if (f.sortBy) {
      base.sort((a, b) => {
        let cmp = 0
        switch (f.sortBy) {
          case 'rating':
            cmp = (meta.get(a[0].trackId)?.rating ?? 0) - (meta.get(b[0].trackId)?.rating ?? 0)
            break
          case 'loved':
            cmp = Number(meta.get(a[0].trackId)?.loved ?? false) - Number(meta.get(b[0].trackId)?.loved ?? false)
            break
          case 'year':
            cmp = (a[0].year ?? 0) - (b[0].year ?? 0)
            break
          case 'length':
            cmp = a[0].duration - b[0].duration
            break
        }
        if (cmp !== 0) return cmp * (f.sortAsc ? 1 : -1)
        return a[1] - b[1]
      })
    }
    return new Map(base.map(([t, i]) => [t.trackId, i]))
  }

  /**
   * Rotates a library-position-sorted pool so the first track positioned AFTER the
   * anchor (the last user-queue track) leads, with earlier tracks wrapping to the
   * tail. If the anchor is missing from the library, the pool is left unchanged.
   * When the anchor sits at the very end of the sorted order (nothing follows it),
   * the pool regenerates from the top — the queueWrapNotice store is set so the UI
   * can surface that wrap-around as intentional.
   */
  private _rotateAfterAnchor<T extends { trackId: string }>(pool: T[], libPos: Map<string, number>, anchorId?: string): T[] {
    if (!anchorId) {
      queueWrapNotice.set(false)
      return pool
    }
    const anchorPos = libPos.get(anchorId)
    if (anchorPos === undefined) {
      queueWrapNotice.set(false)
      return pool
    }
    const splitAt = pool.findIndex((t) => (libPos.get(t.trackId) ?? 0) > anchorPos)
    if (splitAt > 0) {
      queueWrapNotice.set(false)
      return [...pool.slice(splitAt), ...pool.slice(0, splitAt)]
    }
    // splitAt === 0: the first candidate already follows the anchor — the pool
    // is in natural order, nothing wrapped. splitAt < 0: no candidate ranks
    // after the anchor — the queue regenerates from the top of the sort order.
    queueWrapNotice.set(splitAt < 0 && pool.length > 0)
    return pool
  }

  private _matchesAutoQueueFilters(track: Track, filters: AutoQueueFilters, meta: Map<string, LocalMetadataStore>): boolean {
    const m = meta.get(track.trackId)
    const r = m?.rating ?? 0
    if (r < filters.minRating || r > filters.maxRating) return false
    if (filters.lovedOnly && !m?.loved) return false

    const fromYear = filters.fromYear !== null && filters.fromYear !== undefined && filters.fromYear !== '' ? Number(filters.fromYear) : null
    const toYear = filters.toYear !== null && filters.toYear !== undefined && filters.toYear !== '' ? Number(filters.toYear) : null
    const minLength = filters.minLength !== null && filters.minLength !== undefined && filters.minLength !== '' ? Number(filters.minLength) : null
    const maxLength = filters.maxLength !== null && filters.maxLength !== undefined && filters.maxLength !== '' ? Number(filters.maxLength) : null

    if (fromYear !== null && (track.year ?? 0) < fromYear) return false
    if (toYear !== null && (track.year ?? 9999) > toYear) return false
    if (minLength !== null && track.duration < minLength) return false
    if (maxLength !== null && track.duration > maxLength) return false

    if (filters.albumScope && track.album !== filters.albumScope) return false
    if (filters.artistScope && track.artist !== filters.artistScope) return false

    if (filters.genre && !trackMatchesGenre(track, filters.genre)) return false

    if (filters.searchQuery) {
      const sq = filters.searchQuery.trim().toLowerCase()
      if (sq) {
        const matches =
          track.title.toLowerCase().includes(sq) ||
          track.artist.toLowerCase().includes(sq) ||
          track.album.toLowerCase().includes(sq) ||
          (track.composer ?? '').toLowerCase().includes(sq)
        if (!matches) return false
      }
    }

    return true
  }
}

export const queueManager = new QueueManager()