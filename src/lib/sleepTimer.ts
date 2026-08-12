import { get } from 'svelte/store'
import { sleepTimer } from '../stores/appState'
import { Capacitor } from '@capacitor/core'
import { BackgroundAudio } from './nativePlugin'
import { playbackManager } from './playbackManager'
import { audioManager } from './audioManager'

/**
 * Sleep timer controller.
 *
 * Web path: a JS interval owns the minutes countdown; the end-of-track mode
 * parks at the natural-end advance decision (playbackManager's advance-hook)
 * so the full track plays and no polling cadence is involved. Native path: the
 * iOS engine owns the actual timer (it keeps running while the app is in the
 * background); the JS store mirrors remaining time for the UI and listens for
 * the native `sleepTimerFired` event so both stay consistent.
 */

const TICK_MS = 1000

class SleepTimerController {
  private timer: ReturnType<typeof setInterval> | null = null
  private listener: { remove: () => void } | null = null
  /** Set when the end-of-track sleep pauses during a track transition. The
   *  `_loadAndPlay` that follows could otherwise resume the newly loaded track
   *  with its own `play()` right after our pause; the manager uses this flag to
   *  keep the transition parked. Cleared by explicit playback control or when a
   *  load honors it. */
  private pendingStop = false
  /** Set when an end-of-track sleep parked at a track's natural end; consumed
   *  by `play()` which nudges the element past the parked position so its
   *  natural `ended` event drives the normal advance machinery. Cleared by any
   *  manual playback control via `clearPendingStop()`. */
  private parkedAtEnd = false

  private isNative(): boolean {
    return Capacitor.isNativePlatform()
  }

  /** True if an end-of-track sleep fired while a transition was in flight;
   *  consumes the flag so only the immediately-following load is blocked. */
  consumePendingStop(): boolean {
    const v = this.pendingStop
    this.pendingStop = false
    return v
  }

  /** Cleared by any explicit user playback control (play/next/prev/seek/track
   *  select) so a stale stop never blocks a manual start. Also clears the
   *  parked-at-end flag — a manual rotation supersedes a fired sleep park. */
  clearPendingStop(): void {
    this.pendingStop = false
    this.parkedAtEnd = false
  }

  /** True while the end-of-track sleep is armed (web parks at the advance
   *  decision; on native the engine owns the timer and the web guard never
   *  applies). */
  isEndOfTrackArmed(): boolean {
    if (this.isNative()) return false
    const t = get(sleepTimer)
    return t.active && t.mode === 'endOfTrack'
  }

  /** A web end-of-track park: clears the timer store and sets the flag for
   *  `play()` to consume. */
  parkAtEnd(): void {
    this.parkedAtEnd = true
    sleepTimer.set({ active: false, mode: 'minutes', minutes: 30, endsAt: 0, remainingSeconds: 0 })
  }

  /** Consumes the parked-at-end flag; `play()` nudges the element past the
   *  parked position so its natural `ended` event drives the advance. */
  consumeParkedAtEnd(): boolean {
    const v = this.parkedAtEnd
    this.parkedAtEnd = false
    return v
  }

  async init(): Promise<void> {
    if (!this.isNative()) return
    this.listener = await BackgroundAudio.addListener('sleepTimerFired', () => {
      // The native engine already paused; just reset local UI state.
      this.clearLocal()
    })
  }

  async destroy(): Promise<void> {
    this.stopInterval()
    await this.listener?.remove()
    this.listener = null
  }

  private clearLocal(pause = false): void {
    this.stopInterval()
    this.pendingStop = pause
    sleepTimer.set({ active: false, mode: 'minutes', minutes: 30, endsAt: 0, remainingSeconds: 0 })
    if (pause) void playbackManager.pause()
  }

  /** Arms or cancels the timer. mode 'minutes' stops after N minutes; `endOfTrack`
   *  stops when the current track completes. */
  async set(mode: 'minutes' | 'endOfTrack', minutes: number, active: boolean): Promise<void> {
    this.stopInterval()
    if (!active) {
      sleepTimer.set({ active: false, mode, minutes, endsAt: 0, remainingSeconds: 0 })
    } else if (mode === 'minutes') {
      const ms = Math.max(1, minutes) * 60_000
      sleepTimer.set({ active: true, mode, minutes, endsAt: Date.now() + ms, remainingSeconds: ms / 1000 })
    } else {
      sleepTimer.set({ active: true, mode, minutes, endsAt: 0, remainingSeconds: -1 })
    }

    if (this.isNative()) {
      await BackgroundAudio.setSleepTimer({ active, mode, minutes }).catch(() => {})
      // Native owns the actual stop; run a display-only countdown so the UI
      // ticks down in sync. The native `sleepTimerFired` event clears the store.
      if (active && mode === 'minutes') this.startCountdown()
      return
    }

    if (active && mode === 'minutes') this.startCountdown()
    if (active && mode === 'endOfTrack') {
      // The track must reach its natural end cleanly — tear down any armed
      // crossfade so the ended event parks here instead of advancing mid-fade.
      audioManager.cancelNextTrack()
    }
  }

  private startCountdown(): void {
    const native = this.isNative()
    this.timer = setInterval(() => {
      const t = get(sleepTimer)
      if (!t.active || t.mode !== 'minutes') return
      const remaining = Math.max(0, t.endsAt - Date.now())
      if (remaining <= 0) {
        this.clearLocal(!native)
        return
      }
      sleepTimer.update((s) => (s.active ? { ...s, remainingSeconds: remaining / 1000 } : s))
    }, TICK_MS)
  }

  private stopInterval(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

export const sleepTimerManager = new SleepTimerController()