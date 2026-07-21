import { audioManager } from './audioManager'
import { currentTrack, playbackState, setPlaybackState } from '../stores/appState'
import type { Track } from '../stores/appState'

export function setupMediaSession(
  onNextTrack?: () => void,
  onPreviousTrack?: () => void,
  getCoverBlobUrl?: (track: Track) => string | undefined
): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return

  currentTrack.subscribe((track) => {
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

  playbackState.subscribe((state) => {
    navigator.mediaSession.playbackState = state === 'stopped' ? 'none' : state
  })

  function updatePositionState() {
    const el = audioManager.activeElement
    if (el.duration && isFinite(el.duration)) {
      try {
        navigator.mediaSession.setPositionState?.({
          duration: el.duration,
          playbackRate: el.playbackRate,
          position: el.currentTime,
        })
      } catch {
        /* setPositionState may throw if metadata hasn't been set yet */
      }
    }
  }

  const onTimeUpdate = () => updatePositionState()
  audioManager.a.addEventListener('timeupdate', onTimeUpdate)
  audioManager.b.addEventListener('timeupdate', onTimeUpdate)

  navigator.mediaSession.setActionHandler('play', () => {
    const el = audioManager.activeElement
    if (audioManager.ctx?.state === 'suspended') {
      audioManager.ctx.resume()
    }
    el.play().catch(() => {})
    setPlaybackState('playing')
  })

  navigator.mediaSession.setActionHandler('pause', () => {
    audioManager.activeElement.pause()
    setPlaybackState('paused')
  })

  navigator.mediaSession.setActionHandler('nexttrack', () => {
    onNextTrack?.()
  })

  navigator.mediaSession.setActionHandler('previoustrack', () => {
    onPreviousTrack?.()
  })

  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) {
      audioManager.activeElement.currentTime = details.seekTime
      updatePositionState()
    }
  })
}
