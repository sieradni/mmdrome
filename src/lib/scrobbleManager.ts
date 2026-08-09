import { get } from 'svelte/store'
import { currentTrack, currentTime, settings } from '../stores/appState'
import { getCachedConfig, submitNowPlaying, submitScrobble } from './navidromeApi'
import type { Track } from '../stores/appState'

/**
 * Client-side listening tracker. Feeds Navidrome's `nowPlaying`/`scrobble` Subsonic
 * endpoints; Navidrome handles forwarding to Last.fm / ListenBrainz server-side and
 * bumps its own play counts.
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
    const delta = pos - ph.lastPos
    if (delta > MAX_SEEK_DELTA) {
      // Manual forward seek: the skipped span was not listened to — do not
      // credit it as play time, but anchor the playhead at the new position.
      ph.lastPos = pos
      return
    }
    if (delta < -MAX_SEEK_DELTA) {
      // Manual backward seek: the audio from here on is being re-listened —
      // restart the listening credit at the new position.
      ph.played = 0
      ph.lastPos = pos
      return
    }
    if (delta > 0) ph.played += delta
    ph.lastPos = pos
    // A track can never accrue more listening time than its own length
    // (guard against poll glitches inflating the count).
    const dur = ph.track.duration
    if (dur > 0 && ph.played > dur) ph.played = dur
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
      await submitNowPlaying(config, stripPrefix(track.trackId), {
        artist: track.artist,
        title: track.title,
        album: track.album,
        duration: track.duration,
      })
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
      await submitScrobble(config, stripPrefix(ph.track.trackId), Math.floor(ph.startedAt / 1000))
    } catch {
      // A failed scrobble is dropped — the server is authoritative anyway and
      // external listeners (Last.fm) keep their own session; retries add noise.
    }
  }
}

function canScrobble(duration: number, played: number): boolean {
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
