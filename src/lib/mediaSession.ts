import { currentTrack, playbackState } from '../stores/appState'
import type { Track } from '../stores/appState'
import { get } from 'svelte/store'

export interface MediaSessionHooks {
  /** The element position reads/writes target — the bg element while engaged,
   *  the fg element otherwise (WebBgTransport.sessionElement). */
  getPositionElement: () => HTMLAudioElement
  /** The foreground a/b elements (position-state refresh on timeupdate). */
  a: HTMLAudioElement
  b: HTMLAudioElement
}

export interface MediaSessionController {
  /** Re-pushes the current position into the lock-screen position state
   *  (called from the bg transport's 250 ms tick — iOS stalls timeupdate). */
  refreshPositionState(): void
}

export function setupMediaSession(
  onPlay?: () => void,
  onPause?: () => void,
  onNextTrack?: () => void,
  onPreviousTrack?: () => void,
  getCoverBlobUrl?: (track: Track) => string | undefined,
  hooks?: MediaSessionHooks
): MediaSessionController {
  const cleanup: (() => void)[] = []

  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return { refreshPositionState: () => {} }
  }
  if (!hooks) {
    return { refreshPositionState: () => {} }
  }
  const h = hooks // closure-safe: params don't narrow inside closures

  const unsubTrack = currentTrack.subscribe((track) => {
    if (!track) {
      navigator.mediaSession.metadata = null
      return
    }

    const artwork: MediaImage[] = []
    const coverUrl = getCoverBlobUrl?.(track)
    if (coverUrl) {
      artwork.push({ src: coverUrl, sizes: '512x512', type: 'image/jpeg' })
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork,
    })
  })
  cleanup.push(unsubTrack)

  const unsubPlayState = playbackState.subscribe((state) => {
    navigator.mediaSession.playbackState = state === 'stopped' ? 'none' : state === 'buffering' ? 'playing' : state
  })
  cleanup.push(unsubPlayState)

  function updatePositionState(): void {
    const el = h.getPositionElement()
    const metaDur = get(currentTrack)?.duration ?? 0
    if (metaDur) {
      try {
        navigator.mediaSession.setPositionState?.({
          duration: metaDur,
          playbackRate: el.playbackRate,
          position: el.currentTime,
        })
      } catch {
        /* setPositionState may throw if metadata hasn't been set yet */
      }
    }
  }

  const onTimeUpdate = () => updatePositionState()
  h.a.addEventListener('timeupdate', onTimeUpdate)
  h.b.addEventListener('timeupdate', onTimeUpdate)
  cleanup.push(() => {
    h.a.removeEventListener('timeupdate', onTimeUpdate)
    h.b.removeEventListener('timeupdate', onTimeUpdate)
  })

  // Play/pause/next/prev route through the manager, which dispatches to the bg
  // transport (machine) when engaged — media commands need no bg branches here.

  navigator.mediaSession.setActionHandler('play', () => {
    onPlay?.()
  })

  navigator.mediaSession.setActionHandler('pause', () => {
    onPause?.()
  })

  navigator.mediaSession.setActionHandler('nexttrack', () => {
    onNextTrack?.()
  })

  navigator.mediaSession.setActionHandler('previoustrack', () => {
    onPreviousTrack?.()
  })

  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) {
      const el = h.getPositionElement()
      // Clamp to the metadata duration (1.11 — A1: `HTMLAudioElement.duration`
      // lies; an unclamped lock-screen seek past the end stalls the element).
      const metaDur = get(currentTrack)?.duration ?? 0
      const clamped = metaDur > 0 ? Math.min(details.seekTime, metaDur) : details.seekTime
      el.currentTime = clamped
      updatePositionState()
    }
  })

  return {
    refreshPositionState: updatePositionState,
  }
}
