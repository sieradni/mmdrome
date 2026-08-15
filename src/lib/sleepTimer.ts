import { get } from 'svelte/store'
import { sleepTimer, type SleepTimerState } from '../stores/appState'
import { Capacitor } from '@capacitor/core'
import { BackgroundAudio } from './nativePlugin'
import { rearmDecision } from './sleepTimerMirror'
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

/**
 * Pure web-countdown step: given the store state and `now`, the next remaining
 * seconds and whether the timer expired. The manager's interval drives this;
 * exported pure so the web timer policy is pinned without timers (TODO 3.12).
 */
export function webCountdownStep(t: SleepTimerState, now: number): { expired: boolean; remainingSeconds?: number } {
  if (!t.active || t.mode !== 'minutes') return { expired: false }
  const remaining = Math.max(0, t.endsAt - now)
  if (remaining <= 0) return { expired: true }
  return { expired: false, remainingSeconds: remaining / 1000 }
}

class SleepTimerController {
  private timer: ReturnType<typeof setInterval> | null = null
  private listener: { remove: () => void } | null = null
  /** Set when the end-of-track sleep pauses during a track transition. The
   *  `_loadAndPlay` that follows could otherwise resume the newly loaded track
   *  with its own `play()` right after our pause; the manager uses this flag to
   *  keep the transition parked. Cleared by explicit playback control or when a
   *  load honors it. */
  private pendingStop = false
  /** Set when an end-of-track sleep parked at a track's natural end. The park
   *  leaves the element paused just below its end (never ended), so every resume
   *  path plays the tail and re-fires `ended` to drive the natural advance.
   *  Cleared by any manual playback control via `clearPendingStop()`. */
  private parkedAtEnd = false
  /** Track the parked pause belongs to; guards the exit-background position
   *  carry so a stale park (already resumed in bg) can never land on a
   *  different track. */
  private _parkedTrackId: string | null = null
  /** Pause action for web minutes-countdown expiry, registered by
   *  playbackManager.init(). This class must NOT import playbackManager: that
   *  import closes a module-eval cycle (playbackManager's singleton constructor
   *  eagerly reads sleepTimerManager), and the production bundle resolves the
   *  cyclic binding to `undefined` — `this._stm` becomes undefined and every
   *  playback call throws. The callback inverts the dependency. */
  private onExpire: (() => void) | null = null

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
   *  parked-at-end state — a manual rotation supersedes a fired sleep park. */
  clearPendingStop(): void {
    this.pendingStop = false
    this.parkedAtEnd = false
    this._parkedTrackId = null
  }

  /** Register the pause action invoked when the web minutes countdown expires.
   *  playbackManager.init() registers `() => this.pause()` here; the indirection
   *  (instead of importing the manager singleton) keeps this module out of the
   *  playbackManager ↔ sleepTimer module-eval cycle. */
  setExpireHandler(fn: (() => void) | null): void {
    this.onExpire = fn
  }

  /** True while the end-of-track sleep is armed (web parks at the advance
   *  decision; on native the engine owns the timer and the web guard never
   *  applies). */
  isEndOfTrackArmed(): boolean {
    if (this.isNative()) return false
    const t = get(sleepTimer)
    return t.active && t.mode === 'endOfTrack'
  }

  /** A web end-of-track park: clears the timer store and records the parked
   *  state (flag + owning track) for the exit-background carry. */
  parkAtEnd(trackId: string): void {
    this.parkedAtEnd = true
    this._parkedTrackId = trackId
    sleepTimer.set({ active: false, mode: 'minutes', minutes: 30, endsAt: 0, remainingSeconds: 0 })
  }

  /** True while an end-of-track park is pending (not yet superseded by a
   *  manual control). */
  isParkedAtEnd(): boolean {
    return this.parkedAtEnd
  }

  /** The track id the pending park belongs to. */
  parkedTrackId(): string | null {
    return this._parkedTrackId
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
    if (pause) this.onExpire?.()
  }

  /** Native: every JS queue snapshot (setQueue → native `stopPlayback`)
   *  cancels the engine's armed timer AND its end-of-track flag. Re-arm the
   *  engine mirror from the authoritative store so the sleep intent survives
   *  next/prev/select/retry and queue-end wraps. No-op when the timer is
   *  inactive or expired (the mirror floors an expired minutes timer at ~1s
   *  so the pause still arrives). */
  async rearmAfterSnapshot(): Promise<void> {
    if (!this.isNative()) return
    const d = rearmDecision(get(sleepTimer), Date.now())
    if (!d.shouldReArm) return
    await BackgroundAudio.setSleepTimer({ active: true, mode: d.mode, minutes: d.minutes }).catch(() => {})
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
      const step = webCountdownStep(get(sleepTimer), Date.now())
      if (step.expired) {
        this.clearLocal(!native)
        return
      }
      if (step.remainingSeconds !== undefined) {
        const remaining = step.remainingSeconds
        sleepTimer.update((s) => (s.active ? { ...s, remainingSeconds: remaining } : s))
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