import { get } from 'svelte/store'
import { settings, currentTrack, queue } from '../stores/appState'

const CACHE_NAME = 'mmdrome-preload-cache'
const MAX_CACHE_ENTRIES = 50

export type TrackUrlResolver = (trackId: string) => string

let audioEl: HTMLAudioElement | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let urlForTrack: TrackUrlResolver | null = null
let unsubCurrentTrack: (() => void) | null = null
let unsubSettings: (() => void) | null = null
let blobUrls: Map<string, string> = new Map()
let preloading = false

export function setup(el: HTMLAudioElement, resolver: TrackUrlResolver): void {
  teardown()
  audioEl = el
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
  audioEl = null
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
  if (!audioEl || !audioEl.duration || audioEl.paused || preloading || !urlForTrack) return
  const remaining = audioEl.duration - audioEl.currentTime
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
      await Promise.all(toDelete.map(req => cache.delete(req)))
    }
  } catch {}
}

async function preloadNext(n: number): Promise<void> {
  preloading = true
  try {
    const q = get(queue)
    const ids = [...q.userQueue, ...q.autoQueue]
    const idx = q.activeIndex
    if (idx < 0 || idx >= ids.length) return
    const nextIds = ids.slice(idx + 1, idx + 1 + n)
    if (nextIds.length === 0) return
    const cache = await caches.open(CACHE_NAME)
    let didPut = false
    await Promise.all(nextIds.map(async id => {
      const url = urlForTrack!(id)
      if (!url) return
      const exists = await cache.match(url)
      if (exists) return
      const res = await fetch(url)
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
