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

  function calcReplenishTracks(s: QueueManagerState, library: Track[]): Track[] {
    const all = combined(s)
    const used = new Set(all.map((t) => t.trackId))
    const recent = new Set(s.historyQueue.map((t) => t.trackId))

    let eligible = library.filter((t) => !used.has(t.trackId) && !recent.has(t.trackId))
    eligible = shuffleEnabled ? shuffle(eligible) : sortConfig ? sortTracks(eligible, sortConfig) : eligible

    const needed = Math.max(0, MAX_AUTO_QUEUE - s.autoQueue.length)
    return [...s.autoQueue, ...eligible.slice(0, needed)]
  }

  function replenish(library: Track[]) {
    update((s) => ({ ...s, autoQueue: calcReplenishTracks(s, library) }))
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

    completeCurrentTrack(library: Track[]) {
      let nextTrack: Track | null = null
      update((s) => {
        if (s.activeIndex < 0) return s
        const c = combined(s)
        const current = c[s.activeIndex]
        if (!current) return { ...s, activeIndex: -1 }

        const history = [current, ...s.historyQueue].slice(0, MAX_HISTORY)
        const next = s.activeIndex + 1
        if (next >= c.length) return { ...s, historyQueue: history, activeIndex: -1 }

        nextTrack = c[next]
        const updated = { ...s, historyQueue: history, activeIndex: next }
        return { ...updated, autoQueue: calcReplenishTracks(updated, library) }
      })
      return nextTrack
    },

    playTrackInCombinedQueue(index: number) {
      let track: Track | null = null
      update((s) => {
        const c = combined(s)
        if (index < 0 || index >= c.length) return s

        track = c[index]

        if (index > s.activeIndex) {
          const nu = s.userQueue.length
          const toConvert: Track[] = []
          for (let i = s.activeIndex + 1; i < index; i++) {
            if (i >= nu) {
              toConvert.push(s.autoQueue[i - nu])
            }
          }
          if (toConvert.length > 0) {
            const convertIds = new Set(toConvert.map((t) => t.trackId))
            return {
              ...s,
              userQueue: [...s.userQueue, ...toConvert],
              autoQueue: s.autoQueue.filter((t) => !convertIds.has(t.trackId)),
              activeIndex: index,
            }
          }
        }

        return { ...s, activeIndex: index }
      })
      return track
    },

    autoQueueConversionRule(dropCombinedIndex: number) {
      update((s) => {
        const autoIdx = dropCombinedIndex - s.userQueue.length
        if (autoIdx < 1 || autoIdx >= s.autoQueue.length) return s

        const toConvert = s.autoQueue.slice(0, autoIdx)
        const convertIds = new Set(toConvert.map((t) => t.trackId))
        return {
          ...s,
          userQueue: [...s.userQueue, ...toConvert],
          autoQueue: s.autoQueue.filter((t) => !convertIds.has(t.trackId)),
        }
      })
    },
  }
}
