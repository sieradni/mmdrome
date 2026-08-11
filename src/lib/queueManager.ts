import { get } from 'svelte/store'
import { saveQueue } from './db'
import { libraryFilters, trackMatchesGenre } from './libraryFilters'
import { inscribeRecent, RECENT_LIMIT } from './recentWindow'
import {
  queue,
  library,
  shuffleEnabled,
  autoQueueFilters,
  metadataCache,
  queueWrapNotice,
} from '../stores/appState'
import type { Track, AutoQueueFilters } from '../stores/appState'
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

  promoteActiveTrack(): void {
    queue.update((q) => {
      const combined = [...q.userQueue, ...q.autoQueue]
      const activeId = combined[q.activeIndex]
      if (!activeId) return q

      const autoIdx = q.autoQueue.indexOf(activeId)
      if (autoIdx < 0) return q

      const newUserQueue = [...q.userQueue, activeId]
      const newAutoQueue = q.autoQueue.slice(autoIdx + 1)
      const newActiveIndex = newUserQueue.length - 1

      const updated = { ...q, userQueue: newUserQueue, autoQueue: newAutoQueue, activeIndex: newActiveIndex }
      saveQueue(updated)
      return updated
    })
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
   * short pool admits it back).
   */
  removeFromAutoQueue(trackId: string): void {
    queue.update((q) => {
      const autoQueue = q.autoQueue.filter((id) => id !== trackId)
      const updated = { ...q, autoQueue, recentTrackIds: inscribeRecent(q.recentTrackIds, trackId, RECENT_LIMIT) }
      saveQueue(updated)
      return updated
    })
  }

  /**
   * Removes a user-queue row; the removed track cools down too, so it can't
   * instantly re-enter through auto-fill (removal intent is "not now").
   * Active-track removal keeps the current position semantics (decrement).
   */
  removeFromUserQueue(index: number): void {
    queue.update((q) => {
      const removedId = q.userQueue[index]
      const userQueue = q.userQueue.filter((_, i) => i !== index)
      const activeIndex = q.activeIndex >= index ? Math.max(0, q.activeIndex - 1) : q.activeIndex
      const updated = {
        ...q,
        userQueue,
        activeIndex,
        recentTrackIds: removedId ? inscribeRecent(q.recentTrackIds, removedId, RECENT_LIMIT) : q.recentTrackIds,
      }
      saveQueue(updated)
      return updated
    })
  }

  advanceQueue(): Track | null {
    const q = get(queue)
    const combined = this.getCombinedQueue()
    const currentId = combined[q.activeIndex]
    const nextIndex = q.activeIndex + 1
    if (nextIndex >= 0 && nextIndex < combined.length) {
      this.advanceTo(nextIndex, currentId ?? undefined)
      this.replenishAutoQueue()
      return this.findTrack(combined[nextIndex]) ?? null
    }

    // Queue end reached: the heard track leaves the active slot, so it enters
    // the window even if nothing follows (the caller may wrap or stop).
    if (currentId) this.markRecent(currentId)

    this.replenishAutoQueue()
    const updatedCombined = this.getCombinedQueue()
    if (nextIndex >= 0 && nextIndex < updatedCombined.length) {
      this.advanceTo(nextIndex)
      return this.findTrack(updatedCombined[nextIndex]) ?? null
    }

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