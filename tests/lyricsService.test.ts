// Pins the lyrics service (2026-09-14): Navidrome-only gating, negative-cache
// TTL semantics, in-flight dedupe, store publication + generation supersede,
// and cache eviction. Dexie tables are prototype-stubbed per the eqStore test
// pattern (no fake-indexeddb dependency).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/lib/db'
import { setCachedConfig, type NavidromeConfig } from '../src/lib/navidromeApi'
import {
  lyricsState,
  loadLyricsForTrack,
  getLyricsForTrack,
  __setLyricsDepsForTests,
  NEGATIVE_TTL_MS,
  LYRICS_CACHE_CAP,
  type LyricsState,
} from '../src/lib/lyricsService'
import type { RawStructuredLyrics } from '../src/lib/lyricsCore'

const config: NavidromeConfig = { baseUrl: 'https://srv.example/', username: 'u', password: 'p' }

// ── Dexie prototype stubs (in-memory map) ─────────────────────────────────
const rows = new Map<string, { trackId: string; doc: unknown; fetchedAt: number }>()
const lyricsProto = Object.getPrototypeOf(db.lyricsCache) as Record<string, unknown>
const realGet = lyricsProto.get
const realPut = lyricsProto.put
const realToArray = lyricsProto.toArray
const realBulkDelete = lyricsProto.bulkDelete

function installDb(): void {
  rows.clear()
  lyricsProto.get = (async (key: string) => rows.get(key)) as never
  lyricsProto.put = (async (row: { trackId: string; doc: unknown; fetchedAt: number }) => {
    rows.set(row.trackId, row)
  }) as never
  lyricsProto.toArray = (async () => [...rows.values()]) as never
  lyricsProto.bulkDelete = (async (keys: string[]) => {
    for (const k of keys) rows.delete(k)
  }) as never
}

function restoreDb(): void {
  lyricsProto.get = realGet
  lyricsProto.put = realPut
  lyricsProto.toArray = realToArray
  lyricsProto.bulkDelete = realBulkDelete
  rows.clear()
  __setLyricsDepsForTests()
}

/** Adds a tick so the async load chain (fire-and-forget .then) settles. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function state(): LyricsState {
  let s!: LyricsState
  const un = lyricsState.subscribe((v) => { s = v })
  if (un) un()
  return s
}

test('loadLyricsForTrack: non-Navidrome track publishes empty, no fetch', async (t) => {
  installDb()
  t.after(restoreDb)
  setCachedConfig(config)
  let calls = 0
  __setLyricsDepsForTests({ fetcher: async () => { calls++; return null } })

  loadLyricsForTrack('webdav-abc', { duration: 180 })
  await settle()
  assert.equal(calls, 0)
  const s = state()
  assert.equal(s.trackId, 'webdav-abc')
  assert.equal(s.doc, null)
  assert.equal(s.unavailable, false, 'local tracks are not an error — just nothing to say')
  assert.equal(s.loading, false)
})

test('loadLyricsForTrack: no Navidrome config → empty state', async (t) => {
  installDb()
  t.after(restoreDb)
  setCachedConfig(null)
  loadLyricsForTrack('navidrome-song-1', { duration: 100 })
  await settle()
  assert.equal(state().doc, null)
  assert.equal(state().loading, false)
})

test('synced lyrics flow: fetch → parse → publish → cache', async (t) => {
  installDb()
  t.after(restoreDb)
  setCachedConfig(config)
  const raw: RawStructuredLyrics[] = [
    {
      synced: true,
      line: [
        { start: 0, value: 'First' },
        { start: 4000, value: 'Second' },
      ],
    },
  ]
  let fetchCount = 0
  __setLyricsDepsForTests({
    fetcher: async () => { fetchCount++; return raw },
    now: () => 1_000_000,
  })

  const doc = await getLyricsForTrack('navidrome-song-1', 10_000)
  assert.ok(doc, 'doc resolved')
  assert.equal(doc?.synced, true)
  assert.equal(fetchCount, 1)

  // Cached: second call does NOT refetch.
  await getLyricsForTrack('navidrome-song-1', 10_000)
  assert.equal(fetchCount, 1)

  loadLyricsForTrack('navidrome-song-1', { duration: 10 })
  await settle()
  const s = state()
  assert.equal(s.trackId, 'navidrome-song-1')
  assert.equal(s.doc?.synced, true)
  assert.equal(s.unavailable, false)
})

test('negative cache: unavailable track cached, TTL re-probe', async (t) => {
  installDb()
  t.after(restoreDb)
  setCachedConfig(config)
  let now = 1_000_000
  let calls = 0
  __setLyricsDepsForTests({
    fetcher: async () => { calls++; return null },
    now: () => now,
  })

  assert.equal(await getLyricsForTrack('navidrome-song-2', null), null)
  assert.equal(calls, 1)
  assert.equal(await getLyricsForTrack('navidrome-song-2', null), null)
  assert.equal(calls, 1, 'TTL-fresh negative row suppresses the refetch')

  now += NEGATIVE_TTL_MS + 1
  assert.equal(await getLyricsForTrack('navidrome-song-2', null), null)
  assert.equal(calls, 2, 'TTL lapsed → re-probe (new server lyrics surface)')
})

test('fetch failure is NOT negative-cached', async (t) => {
  installDb()
  t.after(restoreDb)
  setCachedConfig(config)
  let calls = 0
  __setLyricsDepsForTests({
    fetcher: async () => { calls++; throw new Error('network down') },
  })

  assert.equal(await getLyricsForTrack('navidrome-song-3', null), null)
  assert.equal(await getLyricsForTrack('navidrome-song-3', null), null)
  assert.equal(calls, 2, 'a failed lookup retries next play — no poison row')
  assert.equal(rows.has('navidrome-song-3'), false)
})

test('in-flight dedupe: parallel calls share one fetch', async (t) => {
  installDb()
  t.after(restoreDb)
  setCachedConfig(config)
  let calls = 0
  __setLyricsDepsForTests({
    fetcher: async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return [{ synced: false, line: [{ value: 'A' }] }]
    },
  })

  const [a, b] = await Promise.all([
    getLyricsForTrack('navidrome-song-4', null),
    getLyricsForTrack('navidrome-song-4', null),
  ])
  assert.equal(calls, 1)
  assert.equal(a?.lines.length, 1)
  assert.equal(b?.lines.length, 1)
})

test('loadLyricsForTrack: newer load supersedes a slower older one (generation)', async (t) => {
  installDb()
  t.after(restoreDb)
  setCachedConfig(config)
  const gates: Array<() => void> = []
  __setLyricsDepsForTests({
    fetcher: (_cfg, songId) => new Promise<RawStructuredLyrics[]>((resolve) => {
      gates.push(() => resolve(songId === 'navidrome-a'
        ? [{ synced: true, line: [{ start: 0, value: 'A lyrics' }] }]
        : [{ synced: true, line: [{ start: 0, value: 'B lyrics' }] }]))
    }),
  })

  loadLyricsForTrack('navidrome-a', {})
  await settle()
  loadLyricsForTrack('navidrome-b', {})
  await settle()
  // Release the OLDER fetch first — its response must not clobber B.
  gates[0]()
  await settle()
  assert.equal(state().trackId, 'navidrome-b')
  assert.equal(state().doc, null, 'A still in flight; B has not resolved')
  gates[1]()
  await settle()
  const s = state()
  assert.equal(s.trackId, 'navidrome-b')
  assert.equal(s.doc?.lines[0]?.text, 'B lyrics', 'B wins the store')
  // And A's late response must not have written the store even after B:
  assert.notEqual(s.doc?.lines[0]?.text, 'A lyrics')
})

test('unsynced container stuffed with LRC text parses as synced', async (t) => {
  installDb()
  t.after(restoreDb)
  setCachedConfig(config)
  __setLyricsDepsForTests({
    fetcher: async () => [{ synced: false, line: [{ value: '[00:01.00]Parsed' }] }],
  })
  const doc = await getLyricsForTrack('navidrome-song-5', 5000)
  assert.equal(doc?.synced, true)
  assert.equal(doc?.lines[0]?.startMs, 1000)
})

test('cache eviction: cap enforced, negatives evicted first, newest kept', async (t) => {
  installDb()
  t.after(restoreDb)
  setCachedConfig(config)
  let now = 0
  __setLyricsDepsForTests({
    fetcher: async (_c, id) => (id.endsWith('none') ? null : [{ synced: false, line: [{ value: 'Text ' + id }] }]),
    now: () => now++,
  })

  // Fill past the cap: half negatives (id ends 'none'), half positives.
  for (let i = 0; i < LYRICS_CACHE_CAP + 5; i++) {
    await getLyricsForTrack(`navidrome-t${i % 2 === 0 ? 'none' : 'pos'}-${i}`, null)
  }
  assert.ok(rows.size <= LYRICS_CACHE_CAP, `capped: ${rows.size}`)
  // The most recent writes must survive (i = 503 → pos, 504 → none).
  assert.ok(rows.has(`navidrome-tpos-${LYRICS_CACHE_CAP + 3}`) || rows.has(`navidrome-tnone-${LYRICS_CACHE_CAP + 4}`))
})

test('positive rows survive the negative TTL (never re-fetched while valid)', async (t) => {
  installDb()
  t.after(restoreDb)
  setCachedConfig(config)
  let calls = 0
  __setLyricsDepsForTests({
    fetcher: async () => { calls++; return [{ synced: false, line: [{ value: 'Persist' }] }] },
    now: () => 5_000_000,
  })
  await getLyricsForTrack('navidrome-song-6', null)
  // A week later — positive rows stay valid (cap eviction is their only exit).
  __setLyricsDepsForTests({ now: () => 5_000_000 + NEGATIVE_TTL_MS * 3 })
  await getLyricsForTrack('navidrome-song-6', null)
  assert.equal(calls, 1)
})
