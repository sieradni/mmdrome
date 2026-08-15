import type { NavidromeSong, NavidromeConnectResult } from './navidromeApi'
import type { Track } from '../stores/appState'
import { shouldSeedFeedback } from './syncCachePolicy'

/**
 * The pure half of `loadLibraryFromNavidrome` (TODO 3.13): given a connect
 * result and the surrounding context, decide exactly which effects the glue
 * must apply. Extracted so the orchestration decisions — the bail rule, the
 * cached-connect seed skip, and the WebDAV scan gating — are unit-tested
 * without Dexie/fetch, instead of living untested inside the async glue.
 */
export interface NavidromeLoadPlan {
  /** Replace the in-memory library with `tracks` (setLibrary + metadata init). */
  applyLibrary: boolean
  /** Library tracks to install; empty when `applyLibrary` is false. */
  tracks: Track[]
  /** Seed rating/loved feedback from the connect result. */
  seedFeedback: boolean
  /** Server scan timestamp to persist (only meaningful when applying). */
  lastScan?: string
  /** WebDAV credentials are configured AND the library is being applied. */
  configureWebdav: boolean
  /** Fire the automatic incremental WebDAV scan (gated on device online). */
  scanWebdav: boolean
}

export interface NavidromeLoadContext {
  /** Maps a raw song to a library Track (injected so the planner stays pure). */
  mapSong: (song: NavidromeSong) => Track
  /** WebDAV credentials are all present (url + user + token). */
  webdavConfigured: boolean
  /** Device is online; the scan is skipped when offline. */
  online: boolean
}

export function planNavidromeLoad(result: NavidromeConnectResult, ctx: NavidromeLoadContext): NavidromeLoadPlan {
  // A disconnected/failed load with no usable songs must NOT replace the
  // in-memory library: setLibrary reconciles the queue against an empty set
  // and wipes it. A genuinely empty server (connected, clean, zero songs)
  // still applies — that's the truth. A cached fallback carries songs and
  // applies even when the connection failed.
  const applyLibrary = result.songs.length > 0 || (result.connection.connected && !result.loadResult.error)
  const configureWebdav = applyLibrary && ctx.webdavConfigured
  return {
    applyLibrary,
    tracks: applyLibrary ? result.songs.map(ctx.mapSong) : [],
    // Seeding is pointless with no songs; a cached connect is skipped by
    // shouldSeedFeedback regardless of rating source (its server values are
    // stale and the persisted Dexie cache is authoritative).
    seedFeedback: applyLibrary && result.songs.length > 0 && shouldSeedFeedback(result.loadResult),
    lastScan: applyLibrary ? result.lastScan : undefined,
    configureWebdav,
    scanWebdav: configureWebdav && ctx.online,
  }
}
