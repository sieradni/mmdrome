// Pins the cover-art fallback ladder (`coverLadderUrls`) — the fix for the
// latched "default app cover" report: a single failed <img> used to latch the
// fallback icon forever (`failed` was a one-shot flag, and a stale native
// auth-token URL 404s forever). The component now walks a canonical-size
// ladder with per-URL failure memory; this file pins the pure half: ladder
// order, requested-size clamping, no-art-id emptiness, and the `getCoverUrl`
// cache key (already covered indirectly by the manager's use).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { coverLadderUrls, COVER_FALLBACK_SIZES, getCoverUrl, noteCoverLoaded, hasCoverBeenLoaded, LOADED_URL_MEMORY_CAP } from '../src/lib/coverArtCache'
import type { Track } from '../src/stores/appState'
import type { NavidromeConfig } from '../src/lib/navidromeApi'

const cfg: NavidromeConfig = {
  baseUrl: 'https://srv.example',
  username: 'u',
  password: 'p',
}

function track(id: string): Track {
  return { trackId: `navidrome-${id}`, title: id, artist: 'A', album: 'AL', albumId: `al-${id}`, duration: 200, fileType: 'mp3' }
}

beforeEach(() => {
  // getCoverUrl caches by config|trackId|size; the module cache persists
  // across tests in this file, which is fine — the pins below are
  // order-independent for a fixed (track, config, size).
})

test('the ladder lists every canonical size at or below the request, descending', () => {
  const ladder = coverLadderUrls(track('t1'), cfg, 512)
  assert.deepEqual(ladder, [
    getCoverUrl(track('t1'), cfg, 512),
    getCoverUrl(track('t1'), cfg, 256),
    getCoverUrl(track('t1'), cfg, 128),
    getCoverUrl(track('t1'), cfg, 96),
  ])
})

test('a smaller request truncates the ladder (no upsizing)', () => {
  const ladder = coverLadderUrls(track('t2'), cfg, 128)
  assert.equal(ladder.length, 2, '512 and 256 are excluded — the request bounds the ladder from above')
  assert.equal(ladder[0], getCoverUrl(track('t2'), cfg, 128))
  assert.equal(ladder[ladder.length - 1], getCoverUrl(track('t2'), cfg, 96))
})

test('every ladder URL is distinct (canonical sizes only, no duplicate attempts)', () => {
  const ladder = coverLadderUrls(track('t3'), cfg, 512)
  assert.equal(new Set(ladder).size, ladder.length)
  assert.ok(ladder.every((u) => u.includes('getCoverArt.view')), 'all attempts are cover-art URLs')
})

test('COVER_FALLBACK_SIZES is descending and canonical', () => {
  assert.deepEqual([...COVER_FALLBACK_SIZES], [512, 256, 128, 96])
})

// --- The immutable cover path (hash-suffixed id preference + key) -----------

const hashTrack = (hash = '0123456789abcdef'): Track => ({ ...track('t-key'), coverArtId: `mf-t-key_${hash}` })

test('the ladder prefers the hash-suffixed coverArt id over the plain id', () => {
  const url = getCoverUrl(hashTrack(), cfg, 128)
  assert.ok(url.includes('id=mf-t-key_0123456789abcdef'), 'the request id IS the hash-suffixed capture')
})

test('a re-sync that changes the art hash produces a DIFFERENT URL (stale-key fix)', () => {
  const before = getCoverUrl(hashTrack('0123456789abcdef'), cfg, 128)
  const after = getCoverUrl(hashTrack('fedcba9876543210'), cfg, 128)
  assert.notEqual(before, after, 'the hash suffix is part of the URL — a re-tagged cover cannot serve the stale pre-change URL')
})

// --- Session loaded-URL memory (the windowed cached-lane claim) -------------

test('a noted cover URL reports as loaded for the rest of the session', () => {
  const u = getCoverUrl(track('mem-1'), cfg, 128)
  assert.equal(hasCoverBeenLoaded(u), false, 'unknown URLs are never claimed cached')
  noteCoverLoaded(u)
  assert.equal(hasCoverBeenLoaded(u), true, 'a noted URL is a cached revisit')
})

test('null/empty URLs never claim cached', () => {
  assert.equal(hasCoverBeenLoaded(null), false)
  assert.equal(hasCoverBeenLoaded(''), false)
})

test('a FAILED url is never recorded — error retries re-arm as fresh', () => {
  // The contract is onload-only: LazyThumb calls noteCoverLoaded ONLY from
  // the main img's onload, so this pin is the shape of the API (no
  // noteCoverFailed exists) plus the unknown-URL answer above.
  const u = getCoverUrl(track('mem-2'), cfg, 128)
  assert.equal(hasCoverBeenLoaded(u), false)
})

test('a hit REFRESHES recency (a claimed URL is a wanted URL)', () => {
  const a = getCoverUrl(track('mem-3'), cfg, 128)
  const b = getCoverUrl(track('mem-4'), cfg, 128)
  noteCoverLoaded(a)
  noteCoverLoaded(b)
  // cap−1 more distinct inserts: `a` (oldest) is evicted, `b` survives.
  for (let i = 0; i < LOADED_URL_MEMORY_CAP - 1; i++) noteCoverLoaded(`https://srv.example/getCoverArt.view?id=fill-${i}&size=128`)
  assert.equal(hasCoverBeenLoaded(a), false, 'an untouched entry ages out')
  // Re-claiming `a` inserts it at the back of the LRU — the eviction that
  // overflow takes the OLDEST entry (`b`), never the just-claimed one.
  noteCoverLoaded(a)
  assert.equal(hasCoverBeenLoaded(b), false, 'the unrefreshed neighbor was evicted by the re-claim')
  assert.equal(hasCoverBeenLoaded(a), true, 'the refreshed entry survived')
})

test('the memory evicts LRU beyond the cap', () => {
  const evicted = `https://srv.example/getCoverArt.view?id=lru-old&size=128`
  noteCoverLoaded(evicted)
  for (let i = 0; i < LOADED_URL_MEMORY_CAP; i++) noteCoverLoaded(`https://srv.example/getCoverArt.view?id=lru-${i}&size=128`)
  assert.equal(hasCoverBeenLoaded(evicted), false, 'the oldest entry was evicted once the cap overflowed')
})
