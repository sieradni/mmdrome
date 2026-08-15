// Pins the pure orchestration decisions behind loadLibraryFromNavidrome
// (TODO 3.13): the bail rule, the cached-connect seed skip (3.2), and the
// WebDAV scan gating. The async glue in syncEngine is a thin interpreter of
// this plan, so these cases pin the behavior the glue used to encode inline.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planNavidromeLoad } from '../src/lib/navidromeLoadPlan'
import type { NavidromeLoadContext } from '../src/lib/navidromeLoadPlan'
import type { NavidromeConnectResult, NavidromeSong } from '../src/lib/navidromeApi'
import type { Track } from '../src/stores/appState'

const song = (id: string): NavidromeSong => ({ id, title: `T${id}`, artist: 'A', album: 'B', duration: 100 })
const mapSong = (s: NavidromeSong): Track => ({
  trackId: `navidrome-${s.id}`,
  title: s.title,
  artist: s.artist,
  album: s.album,
  duration: s.duration,
  fileType: 'mp3',
})

function result(over: Partial<NavidromeConnectResult> = {}): NavidromeConnectResult {
  return {
    connection: { connected: true },
    songs: [song('1'), song('2')],
    loadResult: { loaded: 2, failed: 0 },
    ...over,
  }
}

const ctx = (over: Partial<NavidromeLoadContext> = {}): NavidromeLoadContext => ({
  mapSong,
  webdavConfigured: false,
  online: true,
  ...over,
})

test('a fresh connect applies the library, maps songs, seeds, and carries lastScan', () => {
  const plan = planNavidromeLoad(result({ lastScan: '2026-01-01' }), ctx())
  assert.equal(plan.applyLibrary, true)
  assert.equal(plan.tracks.length, 2)
  assert.equal(plan.tracks[0].trackId, 'navidrome-1')
  assert.equal(plan.seedFeedback, true, 'fresh (non-cached) connect seeds')
  assert.equal(plan.lastScan, '2026-01-01')
  assert.equal(plan.configureWebdav, false)
  assert.equal(plan.scanWebdav, false)
})

test('a cached connect applies the library but does NOT seed (3.2)', () => {
  const plan = planNavidromeLoad(
    result({ loadResult: { loaded: 2, failed: 0, cached: true } }),
    ctx(),
  )
  assert.equal(plan.applyLibrary, true)
  assert.equal(plan.seedFeedback, false, 'stale server values must not re-seed')
})

test('a disconnected load with no usable songs bails (never wipes the library)', () => {
  const plan = planNavidromeLoad(
    result({ connection: { connected: false, error: 'offline' }, songs: [], loadResult: { loaded: 0, failed: 0, error: 'offline' } }),
    ctx(),
  )
  assert.equal(plan.applyLibrary, false)
  assert.deepEqual(plan.tracks, [])
  assert.equal(plan.seedFeedback, false)
  assert.equal(plan.configureWebdav, false)
  assert.equal(plan.scanWebdav, false)
})

test('a failed load with no usable songs bails even when connected', () => {
  const plan = planNavidromeLoad(
    result({ connection: { connected: true }, songs: [], loadResult: { loaded: 0, failed: 0, error: 'mid-pagination' } }),
    ctx(),
  )
  assert.equal(plan.applyLibrary, false)
})

test('a genuinely empty server (connected, clean, zero songs) still applies — the truth', () => {
  const plan = planNavidromeLoad(
    result({ songs: [], loadResult: { loaded: 0, failed: 0 } }),
    ctx(),
  )
  assert.equal(plan.applyLibrary, true)
  assert.deepEqual(plan.tracks, [])
  assert.equal(plan.seedFeedback, false, 'no songs to seed')
})

test('a cached fallback with songs applies even though the connection failed', () => {
  const plan = planNavidromeLoad(
    result({
      connection: { connected: false, error: 'offline' },
      loadResult: { loaded: 2, failed: 0, cached: true, error: 'offline' },
    }),
    ctx(),
  )
  assert.equal(plan.applyLibrary, true)
  assert.equal(plan.seedFeedback, false, 'cached fallback never re-seeds')
})

test('WebDAV scan fires only when configured AND online', () => {
  const configured = ctx({ webdavConfigured: true, online: true })
  const plan = planNavidromeLoad(result(), configured)
  assert.equal(plan.configureWebdav, true)
  assert.equal(plan.scanWebdav, true)
})

test('WebDAV credentials re-point but the scan is skipped when offline', () => {
  const plan = planNavidromeLoad(result(), ctx({ webdavConfigured: true, online: false }))
  assert.equal(plan.configureWebdav, true)
  assert.equal(plan.scanWebdav, false)
})

test('WebDAV is untouched on a bail (disconnected/empty)', () => {
  const plan = planNavidromeLoad(
    result({ connection: { connected: false }, songs: [], loadResult: { loaded: 0, failed: 0, error: 'x' } }),
    ctx({ webdavConfigured: true, online: true }),
  )
  assert.equal(plan.applyLibrary, false)
  assert.equal(plan.configureWebdav, false)
  assert.equal(plan.scanWebdav, false)
})
