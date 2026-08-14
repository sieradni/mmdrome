/**
 * PlaybackTransport contract (TODO 1.0) — the interface the playback manager
 * drives for the FOREGROUND web adapter only (WebTransport — Step 2). The bg
 * and native adapters are SIBLINGS, not implementations: WebBgTransport
 * (Step 3) and NativeTransport (Step 4) expose their own command surfaces and
 * policy events because their engines are not element-shaped. This file
 * deliberately declares only the members the foreground adapter needs (no
 * dead code before an adapter implements it).
 *
 * Ownership boundary: the transport owns element mechanics — playing the
 * loaded element, arming/cancelling the crossfade, replay-gain refresh on a
 * switch, element listeners, and the error retry machine. It never touches
 * the queue, stores, or sleep timer — those stay with the manager (which owns
 * park/promote/advance and applies the pure `reconcileCrossfadeTarget` patch).
 */

/** The minimal track facts the transport needs (structurally satisfied by the library Track). */
export interface TransportTrack {
  trackId: string
  replayGain?: number | null
  albumReplayGain?: number | null
}

/** Replay-gain facts computed by `computeReplayGainFields` (playbackCore/replayGain.ts). */
export interface ReplayGainFields {
  /** Linear gain for the standby node at crossfade arm time (A7) — null when mode is off or the gain is missing. */
  linearGain: number | null
  /** Raw track gain dB — the transport refreshes the engine's fields with these on a switch. */
  trackGainDb: number | null
  /** Raw album gain dB — the transport refreshes the engine's fields with these on a switch. */
  albumGainDb: number | null
}

/**
 * Track-ended event, discriminated by origin:
 *  - `crossfade` — the engine completed a crossfade switch; `targetId` is the
 *    track that is now actually playing (null when the arm was cancelled
 *    mid-fade — the manager still advances, but reconciles nothing).
 *  - `natural` — the active element fired `ended` (fromError false) or the
 *    retry machine gave up on a stream error (fromError true — the manager's
 *    advance chain skips the sleep park on those).
 */
export type TransportEndedEvent =
  | { kind: 'crossfade'; targetId: string | null }
  | { kind: 'natural'; fromError: boolean }

export interface PlaybackTransport {
  /** Wires engine callbacks + element listeners. Callbacks must be assigned before init. */
  init(): Promise<void>

  /**
   * Plays the element the manager already loaded (src set, web audio ready,
   * park guard consulted). Retries the autoplay rejection up to 3 times with
   * 1s/2s backoff — DELIBERATELY outside RetryPolicy (an autoplay-policy
   * rejection needs a user gesture, not backoff). Returns false when the
   * element never starts; the manager reports the stopped state.
   */
  playLoaded(track: TransportTrack): Promise<boolean>

  /**
   * Arms the next track for the crossfade (target id + url) and remembers the
   * replay-gain fields so the post-switch refresh can re-apply them. Passing
   * null target/url disarms.
   */
  prepareNext(targetId: string | null, url: string | null, rg?: ReplayGainFields): void

  /** Disarms any armed next track. */
  cancelNext(): void

  /** The element currently driving audible playback (bg-aware, like the engine's). */
  readonly playbackElement: HTMLAudioElement

  /** Fires on track end: crossfade switch completion or natural/error end. */
  onTrackEnded: ((event: TransportEndedEvent) => void) | null

  /** Fires when a retry timer fires for the last-played track; the manager re-runs its load. */
  onRetry: ((trackId: string) => void) | null

  /** Fires on element play/pause/waiting/playing — the manager maps these to the playback state store. */
  onPlaybackState: ((state: 'playing' | 'paused' | 'buffering') => void) | null

  /** Tears down engine wiring and cancels pending timers/arms. */
  destroy(): void
}