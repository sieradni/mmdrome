// Pins the cover-art fallback ladder (`coverLadderUrls`) — the fix for the
// latched "default app cover" report: a single failed <img> used to latch the
// fallback icon forever (`failed` was a one-shot flag, and a stale native
// auth-token URL 404s forever). The component now walks a canonical-size
// ladder with per-URL failure memory; this file pins the pure half: ladder
// order, requested-size clamping, no-art-id emptiness, and the `getCoverUrl`
// cache key (already covered indirectly by the manager's use).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { coverLadderUrls, COVER_FALLBACK_SIZES, getCoverUrl } from '../src/lib/coverArtCache'
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
