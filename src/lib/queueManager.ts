import { get } from 'svelte/store'
import { saveQueue } from './db'
import { libraryFilters, trackMatchesGenre } from './libraryFilters'
import {
  queue,
  library,
  shuffleEnabled,
  autoQueueFilters,
  metadataCache,
  setActiveQueueIndex,
  pushHistory,
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

  advanceQueue(): Track | null {
    const q = get(queue)
    const combined = this.getCombinedQueue()
    const currentId = combined[q.activeIndex]
    if (currentId) {
      pushHistory(currentId)
    }

    const hist = get(queue).historyQueue
    if (hist.length > 100) {
      queue.update((q) => {
        const updated = { ...q, historyQueue: q.historyQueue.slice(0, 100) }
        saveQueue(updated)
        return updated
      })
    }

    const nextIndex = q.activeIndex + 1
    if (nextIndex >= 0 && nextIndex < combined.length) {
      setActiveQueueIndex(nextIndex)
      this.replenishAutoQueue()
      return this.findTrack(combined[nextIndex]) ?? null
    }

    this.replenishAutoQueue()
    const q2 = get(queue)
    const updatedCombined = this.getCombinedQueue()
    if (nextIndex >= 0 && nextIndex < updatedCombined.length) {
      setActiveQueueIndex(nextIndex)
      return this.findTrack(updatedCombined[nextIndex]) ?? null
    }

    return null
  }

  replenishAutoQueue(): void {
    const q = get(queue)
    const lib = get(library)
    const libById = new Map(lib.map((t) => [t.trackId, t]))
    const shuffle = get(shuffleEnabled)
    const filters = get(autoQueueFilters)
    const meta = get(metadataCache)

    const keptAuto = q.autoQueue.filter((id) => {
      const t = libById.get(id)
      return t && this._matchesAutoQueueFilters(t, filters, meta)
    })

    const used = new Set([...q.userQueue, ...keptAuto])
    const recent = new Set(q.historyQueue)

    let eligible = lib.filter((t) => {
      if (used.has(t.trackId) || recent.has(t.trackId)) return false
      return this._matchesAutoQueueFilters(t, filters, meta)
    })

    const needed = Math.max(0, MAX_AUTO_QUEUE - keptAuto.length)

    if (eligible.length < needed) {
      const historyMatches = lib.filter((t) => {
        if (used.has(t.trackId)) return false
        if (!this._matchesAutoQueueFilters(t, filters, meta)) return false
        return recent.has(t.trackId)
      })

      const historyOrder = q.historyQueue
      historyMatches.sort((a, b) => {
        const idxA = historyOrder.indexOf(a.trackId)
        const idxB = historyOrder.indexOf(b.trackId)
        return idxA - idxB
      })

      eligible = [...eligible, ...historyMatches]
    }

    if ((needed === 0 || eligible.length === 0) && keptAuto.length === q.autoQueue.length) return

    if (eligible.length > 0) {
      if (shuffle) {
        queueWrapNotice.set(false)
        for (let i = eligible.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [eligible[i], eligible[j]] = [eligible[j], eligible[i]]
        }
      } else {
        const orderRank = this._buildOrderRank(meta)
        eligible.sort((a, b) => (orderRank.get(a.trackId) ?? 0) - (orderRank.get(b.trackId) ?? 0))
        eligible = this._rotateAfterAnchor(eligible, orderRank, q.userQueue[q.userQueue.length - 1])
      }
    }

    const fill = eligible.slice(0, needed)

    const fillIds = fill.map((t) => t.trackId)
    queue.update((q) => {
      const updated = { ...q, autoQueue: [...keptAuto, ...fillIds] }
      saveQueue(updated)
      return updated
    })
  }

  rebuildAutoQueue(): void {
    const q = get(queue)
    const lib = get(library)
    const shuffle = get(shuffleEnabled)
    const filters = get(autoQueueFilters)
    const meta = get(metadataCache)

    const userQueueSet = new Set(q.userQueue)
    let candidates = lib.filter((t) => {
      if (userQueueSet.has(t.trackId)) return false
      return this._matchesAutoQueueFilters(t, filters, meta)
    })

    if (candidates.length > 0) {
      if (shuffle) {
        queueWrapNotice.set(false)
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]]
        }
      } else {
        const orderRank = this._buildOrderRank(meta)
        candidates.sort((a, b) => (orderRank.get(a.trackId) ?? 0) - (orderRank.get(b.trackId) ?? 0))
        candidates = this._rotateAfterAnchor(candidates, orderRank, q.userQueue[q.userQueue.length - 1])
      }
    }

    const fill = candidates.slice(0, MAX_AUTO_QUEUE)

    const fillIds = fill.map((t) => t.trackId)
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
    queueWrapNotice.set(pool.length > 0)
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