import { get } from 'svelte/store'
import { currentTrack, currentTime, settings } from '../stores/appState'
import { getCachedConfig, submitNowPlaying, submitScrobble } from './navidromeApi'
import type { Track } from '../stores/appState'

/**
 * Client-side listening tracker. Feeds Navidrome's Subsonic `scrobble` endpoint
 * (`submission=false` on start, `submission=true` on leave); Navidrome handles
 * forwarding to Last.fm / ListenBrainz server-side and bumps its own play counts.
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

class ScrobbleManager {
  private enabled = false
  private playhead: Playhead | null = null
  private curTrackId: string | null = null
  private scrobblingFlag = false
  private unsubs: (() => void)[] = []

  /** Reads the persisted toggle; called once at app init. */
  init(): void {
    this.scrobblingFlag = !!get(settings).scrobbling
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.unsubs.push(
      settings.subscribe((s) => {
        this.scrobblingFlag = !!s.scrobbling
      }),
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
      if (this.scrobblingFlag && isNavidromeTrack(track.trackId) && getCachedConfig()) {
        void this.reportNowPlaying(track)
      }
    } else {
      this.playhead = null
    }
  }

  private async reportNowPlaying(track: Track): Promise<void> {
    const config = getCachedConfig()
    if (!config) return
    try {
      await submitNowPlaying(config, stripPrefix(track.trackId))
    } catch {
      // Non-fatal: a failed nowPlaying heartbeat is not worth surfacing.
    }
  }

  private async evaluate(ph: Playhead): Promise<void> {
    if (!canScrobble(ph.track.duration, ph.played)) return
    if (!this.scrobblingFlag) return
    if (!isNavidromeTrack(ph.track.trackId)) return
    const config = getCachedConfig()
    if (!config) return
    try {
      await submitScrobble(config, stripPrefix(ph.track.trackId), ph.startedAt)
    } catch {
      // A failed scrobble is dropped — the server is authoritative anyway and
      // external listeners (Last.fm) keep their own session; retries add noise.
    }
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

/** Only Navidrome-backed songs expose a server id to scrobble against. */
function isNavidromeTrack(trackId: string): boolean {
  return trackId.startsWith('navidrome-')
}

export const scrobbleManager = new ScrobbleManager()
