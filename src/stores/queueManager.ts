import { writable, get } from 'svelte/store'
import type { Track } from './appState'

export type SortField = 'title' | 'artist' | 'album' | 'duration'
export type SortOrder = 'asc' | 'desc'

export interface SortConfig {
  field: SortField
  order: SortOrder
}

export interface QueueManagerState {
  userQueue: Track[]
  autoQueue: Track[]
  historyQueue: Track[]
  activeIndex: number
}

const MAX_AUTO_QUEUE = 50
const MAX_HISTORY = 100

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function sortTracks(tracks: Track[], config: SortConfig): Track[] {
  const sorted = [...tracks].sort((a, b) => {
    const av = a[config.field]
    const bv = b[config.field]
    return typeof av === 'string'
      ? av.localeCompare(bv as string)
      : (av as number) - (bv as number)
  })
  return config.order === 'desc' ? sorted.reverse() : sorted
}

export function createQueueManager() {
  const { subscribe, update } = writable<QueueManagerState>({
    userQueue: [],
    autoQueue: [],
    historyQueue: [],
    activeIndex: -1,
  })

  let shuffleEnabled = false
  let sortConfig: SortConfig | null = null

  const combined = (s: QueueManagerState) => [...s.userQueue, ...s.autoQueue]

  function replenish(library: Track[]) {
    update((s) => {
      const all = combined(s)
      const used = new Set(all.map((t) => t.trackId))
      const recent = new Set(s.historyQueue.map((t) => t.trackId))

      let eligible = library.filter((t) => !used.has(t.trackId) && !recent.has(t.trackId))
      eligible = shuffleEnabled ? shuffle(eligible) : sortConfig ? sortTracks(eligible, sortConfig) : eligible

      const needed = Math.max(0, MAX_AUTO_QUEUE - s.autoQueue.length)
      return { ...s, autoQueue: [...s.autoQueue, ...eligible.slice(0, needed)] }
    })
  }

  return {
    subscribe,

    addToUserQueue(track: Track) {
      update((s) => ({ ...s, userQueue: [...s.userQueue, track] }))
    },

    removeFromUserQueue(index: number) {
      update((s) => {
        if (index < 0 || index >= s.userQueue.length) return s
        const removedId = s.userQueue[index].trackId
        const newUser = s.userQueue.filter((_, i) => i !== index)
        const newAuto = s.autoQueue.filter((t) => t.trackId !== removedId)

        const combinedQueue = combined(s)
        const removedGlobal = combinedQueue.findIndex((t) => t.trackId === removedId)
        let newIndex = s.activeIndex
        if (removedGlobal >= 0 && removedGlobal < s.activeIndex) {
          newIndex--
        } else if (removedGlobal === s.activeIndex) {
          newIndex = -1
        }

        return { ...s, userQueue: newUser, autoQueue: newAuto, activeIndex: newIndex }
      })
    },

    moveToNext() {
      let track: Track | null = null
      update((s) => {
        const c = combined(s)
        const next = s.activeIndex + 1
        if (next < c.length) {
          track = c[next]
          return { ...s, activeIndex: next }
        }
        return s
      })
      return track
    },

    moveToPrevious() {
      let track: Track | null = null
      update((s) => {
        const prev = s.activeIndex - 1
        if (prev >= 0) {
          track = combined(s)[prev]
          return { ...s, activeIndex: prev }
        }
        return s
      })
      return track
    },

    playAtIndex(index: number) {
      let track: Track | null = null
      update((s) => {
        const c = combined(s)
        if (index >= 0 && index < c.length) {
          track = c[index]
          return { ...s, activeIndex: index }
        }
        return s
      })
      return track
    },

    getCurrentTrack() {
      const s = get({ subscribe })
      const c = combined(s)
      return s.activeIndex >= 0 && s.activeIndex < c.length ? c[s.activeIndex] : null
    },

    pushHistory(track: Track) {
      update((s) => ({
        ...s,
        historyQueue: [track, ...s.historyQueue].slice(0, MAX_HISTORY),
      }))
    },

    replenishAutoQueue(library: Track[]) {
      replenish(library)
    },

    setShuffle(enabled: boolean) {
      shuffleEnabled = enabled
    },

    setSortConfig(config: SortConfig | null) {
      sortConfig = config
    },
  }
}
