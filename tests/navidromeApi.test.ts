import { test } from 'node:test'
import assert from 'node:assert/strict'
import { submitNowPlaying, submitScrobble, paginateSearch3, cachedConfigMatches, getLyricsBySongId, navidromeSongToTrack, requestableCoverArtId, type NavidromeConfig } from '../src/lib/navidromeApi'

// The Subsonic/OpenSubsonic API has no `nowPlaying` endpoint: a "now playing"
// notification is `scrobble?submission=false`, and a completed listen is
// `scrobble?submission=true&time=<ms>`. These tests pin the exact URL shape the
// two helpers emit — the 2026-08-14 `nowPlaying.view` 404 was a fabricated
// endpoint name, and the same path carried a seconds-vs-milliseconds `time`
// bug (Navidrome parses `time` with `time.UnixMilli`).

const config: NavidromeConfig = { baseUrl: 'https://srv.example/', username: 'u', password: 'p' }

/** Replaces fetch with a stub that records each requested URL and answers a
 *  minimal successful `subsonic-response` (the helpers only inspect status/ok
 *  and the JSON envelope). Returns the recorded URLs plus a `restore` that
 *  reinstates the real fetch — hook it with `t.after` so a failing assertion
 *  still leaves the global untouched. */
function stubFetch(): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input))
    return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { urls, restore: () => { globalThis.fetch = original } }
}

test('submitNowPlaying posts to scrobble with submission=false and no stray params', async (t) => {
  const { urls, restore } = stubFetch()
  t.after(restore)
  await submitNowPlaying(config, 'song-1')
  assert.equal(urls.length, 1)

  const url = new URL(urls[0])
  assert.equal(url.pathname, '/rest/scrobble')
  assert.equal(url.searchParams.get('id'), 'song-1')
  assert.equal(url.searchParams.get('submission'), 'false')
  assert.equal(url.searchParams.has('time'), false)
  assert.equal(url.searchParams.has('artist'), false)
  assert.equal(url.searchParams.has('title'), false)
  assert.equal(url.searchParams.has('album'), false)
  assert.equal(url.searchParams.has('duration'), false)
})

test('submitScrobble posts to scrobble with submission=true and a millisecond time', async (t) => {
  const { urls, restore } = stubFetch()
  t.after(restore)
  await submitScrobble(config, 'song-2', 1784102400123)
  assert.equal(urls.length, 1)

  const url = new URL(urls[0])
  assert.equal(url.pathname, '/rest/scrobble')
  assert.equal(url.searchParams.get('id'), 'song-2')
  assert.equal(url.searchParams.get('submission'), 'true')
  assert.equal(url.searchParams.get('time'), '1784102400123')
})

test('paginateSearch3 stops on a repeated first id (dedupe, 3.3)', async () => {
  // A misbehaving server that ignores songOffset repeats the same full page
  // forever; the first-id dedupe stops it after ONE repeat instead of
  // accumulating duplicate pages up to the cap.
  const page = Array.from({ length: 500 }, (_, i) => ({
    id: `s-${i}`, title: `T${i}`, artist: 'A', album: 'B', duration: 100,
  }))
  let calls = 0
  const songs = await paginateSearch3(async () => {
    calls++
    return page
  })
  assert.equal(calls, 2, 'the repeat page is detected on the second fetch')
  assert.equal(songs.length, 500, 'only the first page is accumulated')
})

test('paginateSearch3 terminates at the page cap for a stream of fresh pages (3.3)', async () => {
  // A server that always returns a FULL page of distinct ids would never hit a
  // short tail or a repeat; the cap bounds the work.
  let calls = 0
  const songs = await paginateSearch3(async () => {
    const base = calls * 500
    calls++
    return Array.from({ length: 500 }, (_, i) => ({
      id: `s-${base + i}`, title: `T${base + i}`, artist: 'A', album: 'B', duration: 100,
    }))
  })
  assert.equal(calls, 200, 'the cap is 200 pages')
  assert.equal(songs.length, 100_000, '200 × 500 = 100k songs')
})

test('paginateSearch3 stops early when a page is short (partial tail)', async () => {
  const page = Array.from({ length: 120 }, (_, i) => ({
    id: `t-${i}`, title: `T${i}`, artist: 'A', album: 'B', duration: 100,
  }))
  const songs = await paginateSearch3(async () => page)
  assert.equal(songs.length, 120, 'a page shorter than PAGE_SIZE ends the loop')
})

// TODO 3.4 — the cached config is keyed by server identity (baseUrl + username);
// a cleared/swapped url or user must invalidate it or stale stream/cover URLs
// keep pointing at the old server until restart.
const cacheCfg = (over: Partial<NavidromeConfig> = {}): NavidromeConfig =>
  ({ baseUrl: 'https://srv.example/', username: 'u', password: 'p', ...over })

test('cachedConfigMatches: no cache is trivially matching (nothing to drop)', () => {
  assert.equal(cachedConfigMatches(null, 'https://other/', 'u2'), true)
})

test('cachedConfigMatches: same server identity matches', () => {
  assert.equal(cachedConfigMatches(cacheCfg(), 'https://srv.example/', 'u'), true)
})

test('cachedConfigMatches: a changed baseUrl is stale', () => {
  assert.equal(cachedConfigMatches(cacheCfg(), 'https://other.example/', 'u'), false)
})

test('cachedConfigMatches: a changed username is stale', () => {
  assert.equal(cachedConfigMatches(cacheCfg(), 'https://srv.example/', 'other'), false)
})

test('cachedConfigMatches: whitespace differences are normalized away', () => {
  assert.equal(cachedConfigMatches(cacheCfg(), '  https://srv.example/  ', '  u  '), true)
})

test('cachedConfigMatches: a password change alone keeps the identity matching', () => {
  assert.equal(cachedConfigMatches(cacheCfg({ password: 'new' }), 'https://srv.example/', 'u'), true)
})

test('paginateSearch3 isCancelled: stops BEFORE the next page and returns the partial set', async () => {
  // The load-cancel token: an in-flight page is awaited (fetch started before
  // the cancel) but no NEW request begins. The partial page-set is returned
  // — the CALLER (loadLibraryFromNavidrome) must apply nothing on a cancel.
  let calls = 0
  const songs = await paginateSearch3(async (offset) => {
    calls++
    return Array.from({ length: 10 }, (_, i) => ({
      id: `s-${offset + i}`, title: `T${offset + i}`, artist: 'A', album: 'B', duration: 100,
    }))
  }, { pageSize: 10, isCancelled: () => calls >= 3 })
  assert.equal(calls, 3, 'pages 1-3 fetched; the token flips and no page 4 starts')
  assert.equal(songs.length, 30, 'the partial set is returned, not discarded')
})

test('paginateSearch3 isCancelled: checked before the FIRST page too', async () => {
  let calls = 0
  const songs = await paginateSearch3(async () => {
    calls++
    return []
  }, { isCancelled: () => true })
  assert.equal(calls, 0, 'an already-cancelled token fetches nothing')
  assert.equal(songs.length, 0)
})

test('getLyricsBySongId: URL shape — getLyricsBySongId with the song id', async (t) => {
  const { urls, restore } = stubFetch()
  t.after(restore)
  await getLyricsBySongId(config, 'song-9')
  const url = new URL(urls[0])
  assert.equal(url.pathname, '/rest/getLyricsBySongId')
  assert.equal(url.searchParams.get('id'), 'song-9')
})

test('getLyricsBySongId: parses structuredLyrics from the envelope', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = (async () => new Response(JSON.stringify({
    'subsonic-response': {
      status: 'ok',
      version: '1.16.1',
      lyricsList: { structuredLyrics: [{ synced: true, line: [{ start: 0, value: 'Hi' }] }] },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const result = await getLyricsBySongId(config, 'song-1')
  assert.ok(Array.isArray(result))
  assert.equal((result as Array<{ synced?: boolean }>)[0].synced, true)
})

test('getLyricsBySongId: server WITHOUT the extension → null, never throws', async (t) => {
  // An old Subsonic answers the unknown endpoint with a subsonic-error envelope
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = (async () => new Response(JSON.stringify({
    'subsonic-response': { status: 'failed', error: { code: 20, message: 'Not found (unknown endpoint)' } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  assert.equal(await getLyricsBySongId(config, 'song-1'), null)
})

test('getLyricsBySongId: empty lyricsList → null', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = (async () => new Response(JSON.stringify({
    'subsonic-response': { status: 'ok', version: '1.16.1', lyricsList: {} },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  assert.equal(await getLyricsBySongId(config, 'song-1'), null)
})

// --- The immutable cover path (hash-suffixed coverArt id) -------------------
// Navidrome's imghttp contract: a getCoverArt request whose id carries the
// art's pixel-hash suffix (`mf-<id>_<16hex>`) is answered
// `Cache-Control: public, max-age=31536000, immutable` — no revalidation round
// trip on re-entry. A request with the plain id revalidates (`no-cache`). We
// capture the server's own `coverArt` attribute verbatim at sync and prefer it
// at request time; a missing/malformed value degrades to the plain id.

test('navidromeSongToTrack captures the hash-suffixed coverArt id verbatim', () => {
  const t = navidromeSongToTrack({
    id: 'abc123', title: 'S', artist: 'A', album: 'AL', duration: 180,
    coverArt: 'mf-abc123_9f8e7d6c5b4a3210',
  })
  assert.equal(t.coverArtId, 'mf-abc123_9f8e7d6c5b4a3210')
})

test('navidromeSongToTrack leaves coverArtId undefined when the server omits it', () => {
  const t = navidromeSongToTrack({ id: 'abc123', title: 'S', artist: 'A', album: 'AL', duration: 180 })
  assert.equal(t.coverArtId, undefined)
})

test('requestableCoverArtId prefers the captured hash-suffixed id', () => {
  const track = { trackId: 'navidrome-abc123', coverArtId: 'mf-abc123_9f8e7d6c5b4a3210' }
  assert.equal(requestableCoverArtId(track), 'mf-abc123_9f8e7d6c5b4a3210')
})

test('requestableCoverArtId falls back to the plain id without a capture (legacy servers)', () => {
  assert.equal(requestableCoverArtId({ trackId: 'navidrome-abc123' }), 'abc123')
  assert.equal(requestableCoverArtId({ trackId: 'navidrome-abc123', coverArtId: '  ' }), 'abc123')
})

test('requestableCoverArtId rejects non-artwork-id shapes (path/scheme injection)', () => {
  // The captured field rides a URL — anything that could alter the request
  // path must never be requested; the plain id is the safe fallback.
  assert.equal(requestableCoverArtId({ trackId: 'navidrome-abc123', coverArtId: 'http://evil/x' }), 'abc123')
  assert.equal(requestableCoverArtId({ trackId: 'navidrome-abc123', coverArtId: '../mf-x' }), 'abc123')
  assert.equal(requestableCoverArtId({ trackId: 'navidrome-abc123', coverArtId: 'mf-x_y?q=1' }), 'abc123')
})

test('requestableCoverArtId accepts every known artwork kind and legacy timestamp suffix', () => {
  // The 16-hex image hash (current servers) and the legacy `_<hexTimestamp>`
  // form both parse server-side (artwork_id.go) — both must ride through.
  assert.equal(requestableCoverArtId({ trackId: 'navidrome-x', coverArtId: 'al-42_0123456789abcdef' }), 'al-42_0123456789abcdef')
  assert.equal(requestableCoverArtId({ trackId: 'navidrome-x', coverArtId: 'ar-9' }), 'ar-9')
  assert.equal(requestableCoverArtId({ trackId: 'navidrome-x', coverArtId: 'mf-abc_1a2b3c4d5e6f7089' }), 'mf-abc_1a2b3c4d5e6f7089')
})
