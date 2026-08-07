import { get } from 'svelte/store'
import { sleepTimer, currentTrack } from '../stores/appState'
import { Capacitor } from '@capacitor/core'
import { BackgroundAudio } from './nativePlugin'
import { playbackManager } from './playbackManager'

/**
 * Sleep timer controller.
 *
 * Web path: a JS interval owns the countdown and pauses via the wrapped engine.
 * Native path: the iOS engine owns the actual timer (it keeps running while the app
 * is in the background); the JS store mirrors remaining time for the UI and listens
 * for the native `sleepTimerFired` event so both stay consistent.
 */

const TICK_MS = 1000

class SleepTimerController {
  private timer: ReturnType<typeof setInterval> | null = null
  private listener: { remove: () => void } | null = null

  private isNative(): boolean {
    return Capacitor.isNativePlatform()
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
    if (active && mode === 'endOfTrack') this.startEndOfTrackWatch()
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

  /** Web-only: stop when the current track's id changes (i.e. the queue advanced past
   *  it). On native the engine pauses at the natural end itself and emits
   *  `sleepTimerFired`. */
  private startEndOfTrackWatch(): void {
    let lastId = get(currentTrack)?.trackId ?? ''
    this.timer = setInterval(() => {
      const t = get(sleepTimer)
      if (!t.active || t.mode !== 'endOfTrack') return
      const id = get(currentTrack)?.trackId ?? ''
      if (id !== lastId) {
        this.clearLocal(true)
      }
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