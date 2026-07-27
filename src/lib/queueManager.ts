import { get } from 'svelte/store'
import { saveQueue } from './db'
import {
  queue,
  library,
  shuffleEnabled,
  autoQueueFilters,
  metadataCache,
  setActiveQueueIndex,
  pushHistory,
} from '../stores/appState'
import type { Track, AutoQueueFilters } from '../stores/appState'
import type { LocalMetadataStore } from './db'

const MAX_AUTO_QUEUE = 50

class QueueManager {
  private _autoQueueCursor = 0

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
        for (let i = eligible.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [eligible[i], eligible[j]] = [eligible[j], eligible[i]]
        }
      } else {
        const startIdx = this._autoQueueCursor % (lib.length || 1)
        const libPos = new Map(lib.map((t, i) => [t.trackId, i]))
        eligible.sort((a, b) => (libPos.get(a.trackId) ?? 0) - (libPos.get(b.trackId) ?? 0))
        const splitAt = eligible.findIndex(t => (libPos.get(t.trackId) ?? 0) >= startIdx)
        if (splitAt > 0) {
          eligible = [...eligible.slice(splitAt), ...eligible.slice(0, splitAt)]
        }
      }
    }

    const fill = eligible.slice(0, needed)
    if (!shuffle && fill.length > 0) {
      const libPos = new Map(lib.map((t, i) => [t.trackId, i]))
      const lastPickedPos = libPos.get(fill[fill.length - 1].trackId) ?? 0
      this._autoQueueCursor = (lastPickedPos + 1) % (lib.length || 1)
    }

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
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]]
        }
      } else {
        const startIdx = this._autoQueueCursor % (lib.length || 1)
        const libPos = new Map(lib.map((t, i) => [t.trackId, i]))
        candidates.sort((a, b) => (libPos.get(a.trackId) ?? 0) - (libPos.get(b.trackId) ?? 0))
        const splitAt = candidates.findIndex(t => (libPos.get(t.trackId) ?? 0) >= startIdx)
        if (splitAt > 0) {
          candidates = [...candidates.slice(splitAt), ...candidates.slice(0, splitAt)]
        }
      }
    }

    const fill = candidates.slice(0, MAX_AUTO_QUEUE)
    if (!shuffle && fill.length > 0) {
      const libPos = new Map(lib.map((t, i) => [t.trackId, i]))
      const lastPickedPos = libPos.get(fill[fill.length - 1].trackId) ?? 0
      this._autoQueueCursor = (lastPickedPos + 1) % (lib.length || 1)
    }

    const fillIds = fill.map((t) => t.trackId)
    queue.update((q) => {
      const updated = { ...q, autoQueue: fillIds }
      saveQueue(updated)
      return updated
    })
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