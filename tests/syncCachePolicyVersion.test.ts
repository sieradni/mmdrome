// Pins the serverVersion gate on the D14 library-cache policy (Navidrome 0.64
// migration): ALL internal item ids were re-encoded server-side while scan
// timestamps survived, so a cache captured by a previous server version must
// NEVER be served — a scan-timestamp match alone would hand back a full
// library of dead ids (streams/covers/scrobbles all 404). Legacy rows (no
// version recorded) mismatch any known live version → exactly one full
// re-sync, which IS the migration. The offline/fallback path (live version
// unknown) keeps serving any snapshot for the baseKey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cachedLibraryUsable } from '../src/lib/syncCachePolicy'
import type { SongLibraryCache } from '../src/lib/db'

function cache(over: Partial<SongLibraryCache> = {}): SongLibraryCache {
  return {
    id: 'main',
    tracks: [{ id: 's1' } as never],
    lastScan: '2026-01-01',
    baseKey: 'https://srv|user',
    ...over,
  }
}

test('a cache from a different server version is rejected on the fresh path', () => {
  const opts = { lastScan: '2026-01-01', serverVersion: '0.64.1', requireFreshScan: true }
  assert.equal(cachedLibraryUsable(cache({ serverVersion: '0.55.2' }), 'https://srv|user', opts), false, 'old version rejected despite matching lastScan')
})

test('a matching server version is accepted when the scan timestamp also matches', () => {
  const opts = { lastScan: '2026-01-01', serverVersion: '0.64.1', requireFreshScan: true }
  assert.equal(cachedLibraryUsable(cache({ serverVersion: '0.64.1' }), 'https://srv|user', opts), true)
})

test('a LEGACY cache row (no recorded version) mismatches any known live version', () => {
  const opts = { lastScan: '2026-01-01', serverVersion: '0.64.1', requireFreshScan: true }
  assert.equal(cachedLibraryUsable(cache(), 'https://srv|user', opts), false, 'absent version forces exactly one full re-sync — the migration')
})

test('the version gate applies even without requireFreshScan (server reachable)', () => {
  // The gate is orthogonal to the scan-timestamp freshness rule: any path
  // where the live version is KNOWN (the server answered ping) must honor it.
  assert.equal(cachedLibraryUsable(cache({ serverVersion: '0.55.2' }), 'https://srv|user', { serverVersion: '0.64.1' }), false)
})

test('the version gate does NOT apply to the offline fallback (live version unknown)', () => {
  // An unreachable server has nothing fresher; any snapshot for this baseKey
  // is the best available — unchanged offline semantics.
  assert.equal(cachedLibraryUsable(cache({ serverVersion: '0.55.2' }), 'https://srv|user'), true)
})

test('a version bump ALONE invalidates (lastScan can survive a server migration)', () => {
  const opts = { lastScan: '2026-09-21', serverVersion: '0.64.1', requireFreshScan: true }
  assert.equal(cachedLibraryUsable(cache({ lastScan: '2026-09-21', serverVersion: '0.63.2' }), 'https://srv|user', opts), false, 'the trap this gate exists to close')
})
