import { get } from 'svelte/store'
import { settings, currentTrack, queue } from '../stores/appState'
import { advanceTargetIndex } from './queueMutation'

const CACHE_NAME = 'mmdrome-preload-cache'
const MAX_CACHE_ENTRIES = 50

export type TrackUrlResolver = (trackId: string) => string

let getAudioEl: (() => HTMLAudioElement) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let urlForTrack: TrackUrlResolver | null = null
let unsubCurrentTrack: (() => void) | null = null
let unsubSettings: (() => void) | null = null
let blobUrls: Map<string, string> = new Map()
let preloading = false

export function setup(getEl: () => HTMLAudioElement, resolver: TrackUrlResolver): void {
  teardown()
  getAudioEl = getEl
  urlForTrack = resolver

  let prevId: string | null = get(currentTrack)?.trackId ?? null
  unsubCurrentTrack = currentTrack.subscribe(track => {
    if (prevId && track && track.trackId !== prevId && urlForTrack) {
      cleanup(urlForTrack(prevId))
    }
    prevId = track?.trackId ?? null
  })

  unsubSettings = settings.subscribe(s => {
    const n = s.preloadTracks ?? 0
    const wasRunning = pollTimer !== null
    const shouldRun = n > 0
    if (shouldRun && !wasRunning) {
      pollTimer = setInterval(poll, 1000)
    } else if (!shouldRun && pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  })
}

export function teardown(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (unsubCurrentTrack) { unsubCurrentTrack(); unsubCurrentTrack = null }
  if (unsubSettings) { unsubSettings(); unsubSettings = null }
  getAudioEl = null
  urlForTrack = null
}

export async function resolveSrc(url: string): Promise<string> {
  try {
    const cache = await caches.open(CACHE_NAME)
    const match = await cache.match(url)
    if (match) {
      const old = blobUrls.get(url)
      if (old) URL.revokeObjectURL(old)
      const blob = await match.blob()
      const blobUrl = URL.createObjectURL(blob)
      blobUrls.set(url, blobUrl)
      return blobUrl
    }
  } catch {}
  return url
}

export async function cleanup(url: string): Promise<void> {
  const old = blobUrls.get(url)
  if (old) { URL.revokeObjectURL(old); blobUrls.delete(url) }
  try {
    const cache = await caches.open(CACHE_NAME)
    await cache.delete(url)
  } catch {}
}

function poll(): void {
   const el = getAudioEl?.()
   if (!el || el.paused || preloading || !urlForTrack) return
   const metaDur = get(currentTrack)?.duration ?? 0
   if (!metaDur) return
   const remaining = metaDur - el.currentTime
  if (remaining > 30) return

  const n = get(settings).preloadTracks ?? 0
  if (n === 0) return

  preloadNext(n)
}

async function enforceCacheLimit(): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME)
    const keys = await cache.keys()
    if (keys.length > MAX_CACHE_ENTRIES) {
      const toDelete = keys.slice(0, keys.length - MAX_CACHE_ENTRIES)
      await Promise.all(toDelete.map(req => {
        const url = req.url
        const old = blobUrls.get(url)
        if (old) { URL.revokeObjectURL(old); blobUrls.delete(url) }
        return cache.delete(req)
      }))
    }
  } catch {}
}

async function preloadNext(n: number): Promise<void> {
  preloading = true
  try {
    const q = get(queue)
    const ids = [...q.userQueue, ...q.autoQueue]
    // Playing-track-aware start (advanceTargetIndex) — the SAME function the
    // crossfade arm uses (playbackManager._setupNextTrack), so the preload
    // never disagrees with it: after an active-row removal the row AT
    // activeIndex IS the next row (the playing track left the queue), and a
    // plain `activeIndex + 1` would warm the cache one PAST the next-to-play
    // row. Normal case: target = activeIndex + 1, identical to the old math.
    const idx = advanceTargetIndex(q, ids, get(currentTrack)?.trackId)
    if (idx < 0 || idx >= ids.length) return
    const nextIds = ids.slice(idx, idx + n)
    if (nextIds.length === 0) return
    const cache = await caches.open(CACHE_NAME)
    let didPut = false
    const resolver = urlForTrack
    if (!resolver) return
    await Promise.all(nextIds.map(async id => {
      const url = resolver(id)
      if (!url) return
      const exists = await cache.match(url)
      if (exists) return
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer))
      if (res.ok) {
        await cache.put(url, res)
        didPut = true
      }
    }))
    if (didPut) await enforceCacheLimit()
  } catch {} finally {
    preloading = false
  }
}
