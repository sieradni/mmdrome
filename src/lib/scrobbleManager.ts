import { get } from 'svelte/store'
import { currentTrack, currentTime, settings } from '../stores/appState'
import { getCachedConfig, submitNowPlaying, submitScrobble } from './navidromeApi'
import type { Track, SettingsMap } from '../stores/appState'
import { effectiveLfmCreds, getCachedLfmSession } from './lastfmAuth'
import { lfmUpdateNowPlaying } from './lastfmApi'
import { lbSubmitListen } from './listenbrainzApi'
import { scrobbleFlushEngine } from './scrobbleFlush'

/**
 * Client-side listening tracker. Feeds Navidrome's Subsonic `scrobble` endpoint
 * (`submission=false` on start, `submission=true` on leave); Navidrome handles
 * forwarding to Last.fm / ListenBrainz server-side and bumps its own play counts.
 *
 * Direct destinations (2026-08-25): when the user connects Last.fm (and/or
 * pastes a ListenBrainz token), the SAME accrued listen event fans out to those
 * services — independent of Navidrome's server-side forwarding. The Last.fm/
 * ListenBrainz legs are DURABLE: they enqueue into `scrobbleFlushEngine`
 * (Dexie-backed) and survive restarts/offline periods; the Navidrome leg keeps
 * its historical drop-on-fail policy (the server bumps play counts itself).
 *
 * Policy (Last.fm-style): a listen counts when the track played ≥ 50% (or ≥ 4 min
 * for long tracks). Subscribes to the shared `currentTrack`/`currentTime` stores so a
 * single module covers both the web (timeupdate) and native (position poll) engines.
 */

const MIN_LISTEN_SECONDS = 240
const SCROBBLE_RATIO = 0.5
/** Position deltas above this are manual seeks, not listening: forward jumps
 *  must not manufacture play time, backward jumps re-listen the audio. Normal
 *  playback ticks are ~0.25s–1s, so this never fires on real playback. */
const MAX_SEEK_DELTA = 5

interface Playhead {
  track: Track
  played: number
  lastPos: number
  startedAt: number
}

export interface PlayheadStep {
  played: number
  lastPos: number
}

/** One completed-listen event, ready for every direct destination. */
export interface ListenEvent {
  artist: string
  title: string
  album?: string
  albumArtist?: string
  /** Seconds. */
  duration?: number
  /** Epoch ms captured at playhead creation — the scrobble/listen start time. */
  startedAtMs: number
}

/**
 * Destination hooks. Each DEFAULT implementation re-checks ITS OWN gates at
 * fire time (toggle, session/token presence, track prefix) so a stale manager
 * flag can never send an event to a disconnected service. Tests inject spies.
 */
export interface ScrobbleDestinations {
  navidromeScrobble(track: Track, startedAtMs: number): void
  navidromeNowPlaying(track: Track): void
  lastfmScrobble(event: ListenEvent): void
  lastfmNowPlaying(track: Track): void
  listenbrainzScrobble(event: ListenEvent): void
  listenbrainzNowPlaying(track: Track): void
}

function hasIdentity(artist?: string, title?: string): boolean {
  return !!artist?.trim() && !!title?.trim()
}

/**
 * Per-destination gates, exported PURE so they are pinned without stores
 * (F2). The manager deliberately carries NO master gate: each leg decides
 * independently from its own toggle — "Scrobble to Navidrome" being off must
 * not silence a connected Last.fm/ListenBrainz (the whole point of A11).
 */
export function shouldNavidromeScrobble(trackId: string, s: Pick<SettingsMap, 'scrobbling'>): boolean {
  if (!s.scrobbling) return false
  return trackId.startsWith('navidrome-')
}

export function shouldLastfmScrobble(
  s: Pick<SettingsMap, 'lastfmScrobbling'>,
  session: unknown,
  artist?: string,
  title?: string,
): boolean {
  return !!s.lastfmScrobbling && !!session && hasIdentity(artist, title)
}

export function shouldListenbrainzScrobble(
  s: Pick<SettingsMap, 'listenbrainzScrobbling' | 'listenbrainzToken'>,
  artist?: string,
  title?: string,
): boolean {
  return !!s.listenbrainzScrobbling && !!s.listenbrainzToken && hasIdentity(artist, title)
}

function defaultDestinations(): ScrobbleDestinations {
  return {
    navidromeScrobble(track, startedAtMs) {
      if (!shouldNavidromeScrobble(track.trackId, get(settings))) return
      const config = getCachedConfig()
      if (!config) return
      void submitScrobble(config, stripPrefix(track.trackId), startedAtMs).catch(() => {
        // A failed scrobble is dropped — the server is authoritative anyway and
        // external listeners (Last.fm) keep their own session; retries add noise.
      })
    },
    navidromeNowPlaying(track) {
      if (!shouldNavidromeScrobble(track.trackId, get(settings))) return
      const config = getCachedConfig()
      if (!config) return
      void submitNowPlaying(config, stripPrefix(track.trackId)).catch(() => {
        // Non-fatal: a failed nowPlaying heartbeat is not worth surfacing.
      })
    },
    lastfmScrobble(event) {
      const s = get(settings)
      if (!shouldLastfmScrobble(s, getCachedLfmSession(), event.artist, event.title)) return
      void scrobbleFlushEngine.enqueue(
        'lfm-scrobble',
        event.artist,
        event.title,
        {
          album: event.album,
          albumArtist: event.albumArtist,
          duration: event.duration,
          timestamp: Math.floor(event.startedAtMs / 1000),
        },
      ).catch((err) => console.warn('[scrobble] enqueue failed:', err))
    },
    lastfmNowPlaying(track) {
      const s = get(settings)
      const session = getCachedLfmSession()
      if (!shouldLastfmScrobble(s, session, track.artist, track.title)) return
      void lfmUpdateNowPlaying(effectiveLfmCreds(), session!.key, {
        artist: track.artist,
        track: track.title,
        album: track.album,
        albumArtist: track.albumArtist,
        duration: track.duration > 0 ? track.duration : undefined,
      }).catch(() => {
        // Fire-and-forget heartbeat.
      })
    },
    listenbrainzScrobble(event) {
      const s = get(settings)
      if (!shouldListenbrainzScrobble(s, event.artist, event.title)) return
      void scrobbleFlushEngine.enqueue(
        'lb-listen',
        event.artist,
        event.title,
        {
          album: event.album,
          duration: event.duration,
          timestamp: Math.floor(event.startedAtMs / 1000),
        },
      ).catch((err) => console.warn('[scrobble] enqueue failed:', err))
    },
    listenbrainzNowPlaying(track) {
      const s = get(settings)
      if (!shouldListenbrainzScrobble(s, track.artist, track.title)) return
      void lbSubmitListen(s.listenbrainzToken!, {
        artist: track.artist,
        track: track.title,
        album: track.album,
        duration: track.duration > 0 ? track.duration : undefined,
      }, { playingNow: true }).catch(() => {
        // Fire-and-forget heartbeat.
      })
    },
  }
}

/**
 * Pure A9 accrual step. Position deltas above `MAX_SEEK_DELTA` are manual
 * seeks: a forward jump re-anchors without crediting the skipped span (it was
 * never listened to), a backward jump resets `played` (the audio is being
 * re-listened). Normal playback accrues positive deltas, and `played` never
 * exceeds the track duration (poll-glitch guard). Exported pure so the seek
 * policy is pinned without the store/DOM machinery (TODO 3.10).
 */
export function advancePlayhead(played: number, lastPos: number, pos: number, duration: number): PlayheadStep {
  const delta = pos - lastPos
  if (delta > MAX_SEEK_DELTA) {
    return { played, lastPos: pos }
  }
  if (delta < -MAX_SEEK_DELTA) {
    return { played: 0, lastPos: pos }
  }
  const nextPlayed = delta > 0 ? played + delta : played
  const clamped = duration > 0 && nextPlayed > duration ? duration : nextPlayed
  return { played: clamped, lastPos: pos }
}

export class ScrobbleManager {
  private enabled = false
  private playhead: Playhead | null = null
  private curTrackId: string | null = null
  private unsubs: (() => void)[] = []
  private destinations: ScrobbleDestinations

  constructor(destinations: ScrobbleDestinations = defaultDestinations()) {
    this.destinations = destinations
  }

  /** Kept for the playbackManager.init() contract; gating is per-destination now. */
  init(): void {}

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.unsubs.push(
      currentTrack.subscribe((t) => this.onTrackChange(t)),
      currentTime.subscribe((pos) => this.onTick(pos)),
    )
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    this.unsubs.forEach((unsub) => unsub())
    this.unsubs = []
    this.playhead = null
    this.curTrackId = null
  }

  /** Called on every position tick while a track is active. */
  private onTick(pos: number): void {
    const ph = this.playhead
    if (!ph) return
    const step = advancePlayhead(ph.played, ph.lastPos, pos, ph.track.duration)
    ph.played = step.played
    ph.lastPos = step.lastPos
  }

  private onTrackChange(track: Track | null): void {
    const id = track?.trackId ?? null
    if (id === this.curTrackId) {
      return
    }

    if (this.playhead && this.curTrackId) {
      void this.evaluate(this.playhead)
    }

    this.curTrackId = id
    if (track) {
      this.playhead = { track, played: 0, lastPos: 0, startedAt: Date.now() }
      // No master gate — each destination checks its own toggle/credentials.
      this.destinations.navidromeNowPlaying(track)
      this.destinations.lastfmNowPlaying(track)
      this.destinations.listenbrainzNowPlaying(track)
    } else {
      this.playhead = null
    }
  }

  private async evaluate(ph: Playhead): Promise<void> {
    if (!canScrobble(ph.track.duration, ph.played)) return

    const event: ListenEvent = {
      artist: ph.track.artist,
      title: ph.track.title,
      album: ph.track.album || undefined,
      albumArtist: ph.track.albumArtist || undefined,
      duration: ph.track.duration > 0 ? ph.track.duration : undefined,
      startedAtMs: ph.startedAt,
    }
    this.destinations.navidromeScrobble(ph.track, ph.startedAt)
    this.destinations.lastfmScrobble(event)
    this.destinations.listenbrainzScrobble(event)
  }
}

/** Last.fm-style listen threshold: ≥ 50 % of a short track, ≥ 4 min of a long one. */
export function canScrobble(duration: number, played: number): boolean {
  if (!duration || duration <= 0 || played <= 0) return false
  if (duration >= MIN_LISTEN_SECONDS) return played >= MIN_LISTEN_SECONDS
  return played >= duration * SCROBBLE_RATIO
}

function stripPrefix(trackId: string): string {
  return trackId.replace(/^navidrome-/, '')
}

export const scrobbleManager = new ScrobbleManager()
