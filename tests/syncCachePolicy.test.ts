// Pins the pure D14 cache policy (TODO 3.11): a cached song library is served
// only for its own baseKey, must be non-empty, is bypassed by forceRefresh on
// the fresh path, and on the fresh path must match the server's scan timestamp
// when the server exposes one. Offline/failed-load fallbacks accept any cached
// snapshot for this server.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cachedLibraryUsable } from '../src/lib/syncCachePolicy'
import type { SongLibraryCache } from '../src/lib/db'

function cache(over: Partial<SongLibraryCache> = {}): SongLibraryCache {
  return { id: 'main', tracks: [{ id: 's1' } as never], lastScan: '2026-01-01', baseKey: 'https://srv|user', ...over }
}

test('no cache → not usable', () => {
  assert.equal(cachedLibraryUsable(undefined, 'https://srv|user'), false)
})

test('empty cache → not usable', () => {
  assert.equal(cachedLibraryUsable(cache({ tracks: [] }), 'https://srv|user'), false)
})

test('cache for another server → not usable (baseKey isolation)', () => {
  assert.equal(cachedLibraryUsable(cache(), 'https://other|user'), false)
})

test('forceRefresh bypasses a matching fresh cache', () => {
  assert.equal(cachedLibraryUsable(cache(), 'https://srv|user', { forceRefresh: true, requireFreshScan: true }), false)
})

test('fresh path requires the scan timestamp to match when the server exposes one', () => {
  const opts = { lastScan: '2026-02-02', requireFreshScan: true }
  assert.equal(cachedLibraryUsable(cache(), 'https://srv|user', opts), false, 'stale cache rejected')
  assert.equal(cachedLibraryUsable(cache({ lastScan: '2026-02-02' }), 'https://srv|user', opts), true, 'matching scan accepted')
})

test('fresh path accepts any cache when the server exposes no timestamp', () => {
  assert.equal(cachedLibraryUsable(cache({ lastScan: 'stale' }), 'https://srv|user', { requireFreshScan: true }), true, 'no lastScan → no freshness check')
})

test('offline/fallback path ignores freshness and forceRefresh', () => {
  assert.equal(cachedLibraryUsable(cache({ lastScan: 'old' }), 'https://srv|user', { forceRefresh: true }), true, 'offline serves any snapshot despite forceRefresh')
  assert.equal(cachedLibraryUsable(cache(), 'https://srv|user'), true, 'plain usable')
})
