import { test } from 'node:test'
import assert from 'node:assert/strict'
import { submitNowPlaying, submitScrobble, paginateSearch3, type NavidromeConfig } from '../src/lib/navidromeApi'

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
