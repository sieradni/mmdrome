// Pins the WEB preloader's offline-buffer invariants (the "preload N acts as a
// buffer for intermittent connections" contract):
//  1. SERIALIZED priority fill — the queue order is the download order; the
//     next track never waits behind a later one (one fetch per poll tick);
//  2. offline resilience — a network exception is retried by the next tick
//     (the head keeps its place), while a SERVER non-ok is never retried
//     forever (two strikes mark the row dead so it can't head-of-line block);
//  3. cache-first src resolution — a preloaded track plays OFFLINE via blob;
//     a miss falls back to the raw URL (never a hard load failure);
//  4. the LDM gate bails the poll before any fetch;
//  5. the fill-start gate: remaining>30 s defers, UNLESS the element has
//     already buffered the whole current file (the current track then needs
//     no bandwidth, so preloading is free — coverage is measured from the
//     playhead's buffered range, not the furthest buffered end).
// The Cache API is stubbed with an in-memory Map; `caches` is faked on
// globalThis (the preloader guards `typeof caches === 'undefined'`).

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { settings, queue, library, setCurrentTrack, type Track } from '../src/stores/appState'
import {
  setup as setupPreloader,
  teardown as teardownPreloader,
  resolveSrc,
  __pollForTests,
  __resetForTests,
} from '../src/lib/preloader'
import { __setNetworkStatus } from '../src/lib/networkMode'

// --- in-memory Cache API stub ------------------------------------------------

type Entry = { url: string; body: string }

const cacheStore = new Map<string, Entry>()
let failUrls: Set<string> = new Set()
let throwUrls: Set<string> = new Set()
let fetchLog: string[] = []

function installCacheStub(): void {
  // Real Blobs, not plain objects: Node 18+ ships a real `URL.createObjectURL`
  // that THROWS on non-Blob input — a fake would make resolveSrc's blob branch
  // throw inside its try-block and silently fall back to the raw URL.
  const cache = {
    async match(url: string) {
      const e = cacheStore.get(url)
      if (!e) return undefined
      return { bodyUsed: false, async blob() { return new Blob([e.body]) } }
    },
    async put(url: string) {
      cacheStore.set(url, { url, body: 'audio' })
    },
    async delete(url: string) {
      return cacheStore.delete(url)
    },
    async keys() {
      return [...cacheStore.values()].map((e) => ({ url: e.url }))
    },
  }
  ;(globalThis as unknown as { caches: unknown }).caches = { open: async () => cache }
}

const originalFetch = globalThis.fetch
function installFetchStub(): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    fetchLog.push(url)
    if (throwUrls.has(url)) throw new TypeError('network dead')
    if (failUrls.has(url)) {
      return { ok: false, status: 404 } as unknown as Response
    }
    return { ok: true, status: 200, body: null } as unknown as Response
  }) as typeof fetch
}

function resetStubs(): void {
  cacheStore.clear()
  failUrls = new Set()
  throwUrls = new Set()
  fetchLog = []
}

// --- fixtures ----------------------------------------------------------------

function track(id: string, duration = 300): Track {
  return { trackId: `navidrome-${id}`, title: id, artist: 'A', album: 'AL', duration, fileType: 'mp3' }
}

function seedQueue(ids: string[], active: number): void {
  // Arrow-wrapped on purpose: bare `ids.map(track)` would pass the array
  // INDEX as `track`'s second (duration) parameter.
  const tracks = ids.map((i) => track(i))
  library.set(tracks)
  queue.set({ userQueue: ids.map((i) => `navidrome-${i}`), autoQueue: [], recentTrackIds: [], activeIndex: active })
  setCurrentTrack(tracks[active] ?? null)
}

/** The resolver shape the manager registers: `_resolveUrl` output. */
function resolver(): (trackId: string) => string {
  return (trackId) => `https://srv.example/rest/stream.view?id=${trackId.replace(/^navidrome-/, '')}`
}

function urlOf(id: string): string {
  return resolver()(`navidrome-${id}`)
}

/** Playing element stub: within the last 30 s of the track so the poll's
 *  remaining>30s gate passes (t1 is 300 s in seedQueue). */
function fakeEl(): HTMLAudioElement {
  return { paused: false, currentTime: 290 } as unknown as HTMLAudioElement
}

async function tick(): Promise<void> {
  // Surface any unexpected throw from the poll body — the production path
  // swallows errors (catch {}), which would hide stub contract drift here.
  try {
    await __pollForTests()
  } catch (err) {
    console.error('pollOnce threw:', err)
    throw err
  }
}

beforeEach(() => {
  __resetForTests()
  resetStubs()
  installCacheStub()
  installFetchStub()
  seedQueue(['t1', 't2', 't3', 't4'], 0)
  settings.set({ preloadTracks: 3 })
  __setNetworkStatus({ known: false, isCellular: false, osLowData: false })
  setupPreloader(() => fakeEl(), resolver())
})

afterEach(() => {
  teardownPreloader()
  globalThis.fetch = originalFetch
  delete (globalThis as unknown as { caches?: unknown }).caches
  setCurrentTrack(null)
})

// 1. Serialized priority fill -------------------------------------------------

test('fill order follows queue priority: the NEXT track downloads first, one per tick', async () => {
  await tick()
  assert.deepEqual(fetchLog, [urlOf('t2')], 'tick 1 fetches only the next row')

  await tick()
  assert.deepEqual(fetchLog, [urlOf('t2'), urlOf('t3')], 'tick 2 advances to the second row')

  await tick()
  assert.deepEqual(fetchLog, [urlOf('t2'), urlOf('t3'), urlOf('t4')])
})

test('a cached row is skipped and does not consume the tick', async () => {
  await tick() // t2 cached
  await tick() // t3 cached
  // Drop the queue so t4 is next; it and only it fetches on the next tick.
  cacheStore.set(urlOf('t4'), { url: urlOf('t4'), body: 'audio' })
  seedQueue(['t1', 't2', 't3', 't4'], 0)
  await tick()
  assert.deepEqual(fetchLog, [urlOf('t2'), urlOf('t3')], 'already-cached t4 skipped without a fetch')
})

// 2. Offline resilience -------------------------------------------------------

test('a network exception leaves the head in place; the next tick retries it', async () => {
  throwUrls.add(urlOf('t2'))
  await tick()
  assert.deepEqual(fetchLog, [urlOf('t2')])
  assert.equal(cacheStore.size, 0, 'nothing cached from a dead network')

  throwUrls.clear()
  await tick()
  assert.deepEqual(fetchLog, [urlOf('t2'), urlOf('t2')], 'the SAME head row is retried first')
  assert.ok(cacheStore.has(urlOf('t2')), 'the retry caches the track once the network returns')
})

test('two server non-ok responses mark the row dead; the window advances past it', async () => {
  failUrls.add(urlOf('t2'))
  await tick()
  await tick()
  assert.equal(fetchLog.filter((u) => u === urlOf('t2')).length, 2, 'the 404 row gets its two strikes')

  await tick()
  assert.equal(fetchLog[fetchLog.length - 1], urlOf('t3'), 'the dead row is skipped and t3 fills instead')
  assert.ok(cacheStore.has(urlOf('t3')), 'the window is NOT head-of-line blocked by the vanished file')
})

// 3. Cache-first src resolution ----------------------------------------------

test('resolveSrc returns a blob URL for a cache hit and the raw URL for a miss', async () => {
  cacheStore.set(urlOf('t2'), { url: urlOf('t2'), body: 'audio' })
  const hit = await resolveSrc(urlOf('t2'))
  assert.match(hit, /^blob:/, 'a preloaded track resolves to an offline-capable blob URL')

  const miss = await resolveSrc(urlOf('t3'))
  assert.equal(miss, urlOf('t3'), 'a cache miss falls back to the raw URL (stream, never hard-fail)')
})

test('cache keys are exact URLs — a transcode-param drift misses instead of serving stale audio', async () => {
  cacheStore.set(urlOf('t2'), { url: urlOf('t2'), body: 'audio' })
  const drifted = await resolveSrc(`${urlOf('t2')}&format=opus&maxBitRate=128`)
  assert.equal(drifted.includes('format=opus'), true)
  assert.notEqual(drifted, urlOf('t2'), 'the param-changed URL does NOT hit the old entry')
})

// 4. LDM gate -----------------------------------------------------------------

test('the poll bails before fetching when low data mode is engaged', async () => {
  __setNetworkStatus({ known: true, isCellular: false, osLowData: true })
  await tick()
  assert.deepEqual(fetchLog, [], 'LDM suppresses the automatic fill entirely')
  assert.equal(cacheStore.size, 0)
})

test('a paused element stops the fill (preloading is for continuous playback)', async () => {
  setupPreloader(() => ({ paused: true, currentTime: 290 } as unknown as HTMLAudioElement), resolver())
  await tick()
  assert.deepEqual(fetchLog, [])
})

test('the remaining>30s gate defers the fill until the track nears its end', async () => {
  setupPreloader(() => ({ paused: false, currentTime: 10 } as unknown as HTMLAudioElement), resolver())
  // t1 duration 300, currentTime 10 → remaining 290 > 30, no buffered range
  // property on the stub → the coverage check can't pass either → no fill.
  await tick()
  assert.deepEqual(fetchLog, [])
  // Near the end: remaining < 30 → the fill runs.
  setCurrentTrack(track('t1', 35))
  await tick()
  assert.deepEqual(fetchLog, [urlOf('t2')])
})

// 5. Buffer-coverage early start ----------------------------------------------

test('the fill starts early when the element has buffered the whole current track', async () => {
  // remaining = 290 s (far past the 30 s rule) but the element already holds
  // the entire file: streaming needs no more bandwidth, so window preloading
  // is free — this is the "current track fully downloaded first" contract.
  const el = {
    paused: false,
    currentTime: 10,
    buffered: { length: 1, start: () => 0, end: () => 300 },
  } as unknown as HTMLAudioElement
  setupPreloader(() => el, resolver())
  await tick()
  assert.deepEqual(fetchLog, [urlOf('t2')], 'full buffer coverage bypasses the remaining>30s deferral')
})

test('partial buffer coverage does NOT bypass the remaining>30s deferral', async () => {
  // The element holds 2 of 5 minutes: the current track still needs bandwidth.
  const el = {
    paused: false,
    currentTime: 10,
    buffered: { length: 1, start: () => 0, end: () => 120 },
  } as unknown as HTMLAudioElement
  setupPreloader(() => el, resolver())
  await tick()
  assert.deepEqual(fetchLog, [])
})

test('coverage is measured from the playhead range, not the furthest buffered end', async () => {
  // Ranges [0,120] and [280,300]: the tail is buffered but the element must
  // still fetch the 120–280 gap when the playhead reaches it — the current
  // track still needs bandwidth, so the deferral holds.
  const el = {
    paused: false,
    currentTime: 10,
    buffered: {
      length: 2,
      start: (i: number) => (i === 0 ? 0 : 280),
      end: (i: number) => (i === 0 ? 120 : 300),
    },
  } as unknown as HTMLAudioElement
  setupPreloader(() => el, resolver())
  await tick()
  assert.deepEqual(fetchLog, [])
})
