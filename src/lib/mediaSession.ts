import { audioManager } from './audioManager'
import { currentTrack, currentTime, playbackState, setPlaybackState } from '../stores/appState'
import type { Track } from '../stores/appState'

export function setupMediaSession(
  onPlay?: () => void,
  onPause?: () => void,
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
    navigator.mediaSession.playbackState = state === 'stopped' ? 'none' : state === 'buffering' ? 'playing' : state
  })

  function updatePositionState() {
    const el = audioManager.playbackElement
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

  // Poll position state during background mode (iOS timeupdate can stall)
  let bgInterval: ReturnType<typeof setInterval> | null = null
  const bgCheck = () => {
    if (audioManager.isInBgMode) {
      if (!bgInterval) {
        bgInterval = setInterval(() => {
          updatePositionState()
          currentTime.set(audioManager.playbackElement.currentTime)
        }, 250)
      }
    } else {
      if (bgInterval) { clearInterval(bgInterval); bgInterval = null }
    }
  }
  // Re-check bg mode whenever playback state changes
  playbackState.subscribe(bgCheck)
  currentTrack.subscribe(bgCheck)

  navigator.mediaSession.setActionHandler('play', () => {
    if (audioManager.isInBgMode) {
      const el = audioManager.playbackElement
      el.play().catch(() => {})
      setPlaybackState('playing')
    } else {
      onPlay?.()
    }
  })

  navigator.mediaSession.setActionHandler('pause', () => {
    if (audioManager.isInBgMode) {
      audioManager.playbackElement.pause()
      setPlaybackState('paused')
    } else {
      onPause?.()
    }
  })

  navigator.mediaSession.setActionHandler('nexttrack', () => {
    if (audioManager.isInBgMode) {
      /* PlaybackManager.next() routes to _loadAndPlayInBg when in bg mode */
    }
    onNextTrack?.()
  })

  navigator.mediaSession.setActionHandler('previoustrack', () => {
    if (audioManager.isInBgMode) {
      /* PlaybackManager.prev() routes to _loadAndPlayInBg when in bg mode */
    }
    onPreviousTrack?.()
  })

  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) {
      audioManager.playbackElement.currentTime = details.seekTime
      updatePositionState()
    }
  })
}
