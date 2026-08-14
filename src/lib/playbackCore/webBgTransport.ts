/**
 * WebBgTransport (TODO 1.0 Step 3) — the iOS background-mode adapter. It owns:
 *  - the bg element lifecycle (engine.createBgElement) and the iOS
 *    visibilitychange handler (3 branches: hidden → enter-bg swap; visible
 *    while engaged → exit; visible while fg → revive the suspended context);
 *  - the BgStateMachine (Step 1) — the consolidation of the interlock soup
 *    (`_inBgMode`, `_enterBgSeq`, `_handlingEnd`, parkedAtEnd, the mediaSession
 *    watchdog) into ONE explicit transition function;
 *  - the swap mechanics (src copy, latency-offset seek, iOS `load()`) and the
 *    bg load path, both guarded by the settle token (the `_enterBgSeq` analog —
 *    a stale play() settle from a superseded load is dropped);
 *  - the 250 ms position/watchdog tick (iOS stalls `timeupdate` in background
 *    — the ONE unavoidable poll; runs only while the bg element is audible);
 *  - the park nudge: a parked element is paused just below its end (never
 *    ended), so a later play() resumes the ~0.05s tail and the re-fired
 *    `ended` drives the natural advance (play() on an ENDED element would
 *    seek to the start and replay the whole track);
 *  - the bg retry machine: `RetryPolicy` with the bg cap (0 — the FIRST error
 *    is a give-up; the adapter fires `trackEnded{fromError:true}` so the
 *    manager's advance chain skips the sleep park).
 *
 * Boundary (mirrors WebTransport): the transport NEVER touches the queue,
 * stores, or sleep timer. The manager supplies `BgFacts` via `deps.facts()`
 * and receives POLICY EVENTS — the bg analog of WebTransport's onTrackEnded/
 * onRetry:
 *  - `onLoad(target, decision)` — the machine decided to load; the manager
 *    resolves the track (advanceQueue / wrap / restart / reload) and runs the
 *    load. For target 'bg' it calls back into `startBgLoad`/`abortBgLoad`
 *    (every onLoad must settle — a load that never settles strands the
 *    machine in `handoff`); the exit path awaits onLoad so the post-exit
 *    crossfade re-arm runs after the fg load.
 *  - `onStop(target)` — the end-of-queue stop decision ('fg': clear the
 *    stores + element; 'bg': idle no-op, parity with `_onBgTrackEnd`).
 *  - `onParked(trackId)` — the sleep park landed in bg; the manager records
 *    the park (sleepTimerManager.parkAtEnd) and sets the paused state.
 *  - `onTick(position)` — the 250 ms bg position for the UI + lock screen.
 *
 * Element mechanics stay INSIDE the transport; `deps.fgElement` is stable
 * because `activeElement` cannot flip while backgrounded (the crossfade
 * monitor is torn down at the swap and its tick requires a playing fg
 * element — audioManager.ts `_setupCrossfadeMonitor`).
 */

import { transitionBg, type BgCommand, type BgEvent, type BgState } from './bgStateMachine'
import { RetryPolicy } from './retryPolicy'
import type { LoopMode } from './advanceDecider'

export type LoadDecision = 'restart' | 'advance' | 'wrap' | 'reload'

/** The audioManager surface the bg adapter drives. */
export interface WebBgEngine {
  readonly isIOS: boolean
  createBgElement(): HTMLAudioElement
  getTransitionOffset(): number
  teardownCrossfadeMonitor(): void
  reviveContext(): Promise<void>
  reapplyEffects(): void
  resumeCrossfadeAfterBgExit(): void
}

/** Queue/sleep facts the machine events need — supplied by the manager, never
 *  read from stores by the transport. */
export interface BgFacts {
  currentTrackId: string | null
  parkArmed: boolean
  loopMode: LoopMode
  hasNext: boolean
  hasUserQueue: boolean
  /** Metadata duration of the current track (0 = unknown). */
  duration: number
}

export interface WebBgDeps {
  facts(): BgFacts
  /** The foreground a/b element. Stable: `activeElement` can't flip during bg. */
  fgElement: HTMLAudioElement
}

export interface WebBgTimers {
  interval(ms: number, fn: () => void): () => void
}

const BG_RETRY = { maxAttempts: 0, baseDelayMs: 0 } // 1.2 — bg gives up on the first error
const TICK_MS = 250 // iOS stalls timeupdate in background (§3.1)
const WATCHDOG_MARGIN = 0.25
const PARK_WINDOW = 0.5
const PARK_TAIL = 0.05

type BgExitEvent = Extract<BgEvent, { type: 'exitBg' }>
type BgEndEvent = Extract<BgEvent, { type: 'trackEnded' }>

export class WebBgTransport {
  private readonly _engine: WebBgEngine
  private readonly _deps: WebBgDeps
  private readonly _timers: WebBgTimers
  private readonly _retry = new RetryPolicy(BG_RETRY)
  private _state: BgState = { name: 'foreground' }
  private _el: HTMLAudioElement | null = null
  private _settleToken = 0
  private _speed = 1
  private _tick: (() => void) | null = null

  onLoad: ((target: 'fg' | 'bg', decision: LoadDecision) => void | Promise<void>) | null = null
  onStop: ((target: 'fg' | 'bg') => void) | null = null
  onParked: ((trackId: string) => void) | null = null
  onTick: ((position: number) => void) | null = null

  constructor(engine: WebBgEngine, deps: WebBgDeps, timers: WebBgTimers) {
    this._engine = engine
    this._deps = deps
    this._timers = timers
  }

  /** True while the machine is engaged (any bg state except foreground/resuming). */
  get engaged(): boolean {
    return this._state.name !== 'foreground' && this._state.name !== 'resuming'
  }

  /** The element seeks/position target: the bg element while engaged, the fg
   *  element otherwise (parity with the old bg-aware `playbackElement`). */
  get sessionElement(): HTMLAudioElement {
    return this.engaged && this._el ? this._el : this._deps.fgElement
  }

  /** Creates the bg element and wires listeners; installs the iOS
   *  visibilitychange handler. */
  init(): void {
    if (this._el) return
    const el = this._engine.createBgElement()
    this._el = el
    el.addEventListener('ended', this._onEnded)
    el.addEventListener('error', this._onError)
    if (this._engine.isIOS) {
      document.addEventListener('visibilitychange', this._onVisibility)
    }
  }

  teardown(): void {
    if (this._el) {
      this._el.removeEventListener('ended', this._onEnded)
      this._el.removeEventListener('error', this._onError)
    }
    if (this._engine.isIOS) {
      document.removeEventListener('visibilitychange', this._onVisibility)
    }
    ++this._settleToken
    this._stopTick()
    if (this._el) {
      this._el.pause()
      this._el.removeAttribute('src')
      this._el.load()
    }
    this._state = { name: 'foreground' }
    this._el = null
  }

  /** Visibility entry point (wired to `document` in init on iOS). Public so
   *  the test harness can drive the adapter directly. */
  async handleVisibility(hidden: boolean): Promise<void> {
    if (hidden) {
      this._onHidden()
    } else {
      await this._onVisible()
    }
  }

  /** Explicit user load (next/prev/select) while engaged — the queue was
   *  already advanced by the caller; the machine decides the load target. */
  loadRequest(): void {
    void this._dispatch({ type: 'loadRequest' })
  }

  /** Lock-screen/app play while engaged (park-pending resumes the parked tail). */
  mediaPlay(): void {
    void this._dispatch({ type: 'playCmd' })
  }

  /** Lock-screen/app pause while engaged (during a handoff the AUDIBLE fg
   *  element pauses and the pending swap is cancelled — correction 6). */
  mediaPause(): void {
    void this._dispatch({ type: 'pauseCmd' })
  }

  /** Foreground pre-warm of the bg element (no-op while engaged). */
  syncSource(url: string): void {
    if (!this._el || this.engaged) return
    if (this._el.src !== url) this._el.src = url
  }

  setSpeed(value: number): void {
    this._speed = value
    if (this._el) this._el.playbackRate = value
  }

  /** Loads and plays a URL on the bg element (bg advancement / reload path).
   *  Resolves when the play() settles — `bgStarted`/`bgFailed` are dispatched
   *  into the machine (token-filtered, so only the LAST load's settle lands).
   *  Returns false when the element is gone or not engaged (an exit raced the
   *  load — the machine already re-routed it to the fg path). */
  async startBgLoad(url: string): Promise<boolean> {
    if (!this._el || !this.engaged) return false
    this._el.src = url
    this._el.currentTime = 0
    this._el.playbackRate = this._speed
    return this._settlePlay(++this._settleToken)
  }

  /** Aborts an in-flight bg load without touching the element (pendingStop
   *  guard, no-URL). Fires `bgFailed` so the machine idles in bg-paused
   *  instead of stranding in handoff. */
  abortBgLoad(): void {
    ++this._settleToken
    void this._dispatch({ type: 'bgFailed' })
  }

  // ── internals ────────────────────────────────────────────────────────────

  private readonly _onVisibility = (): void => {
    if (document.hidden) {
      this._onHidden()
    } else {
      void this._onVisible()
    }
  }

  private _onHidden(): void {
    if (!this._el) return
    const fg = this._deps.fgElement
    // The enterBg gate: only a genuinely playing fg element hands off (parity
    // with the old `_enterBackground` guard). A re-hide in any bg state is
    // dropped by the machine — never re-runs the swap.
    if (fg.paused || fg.ended || !fg.src) return
    const t = transitionBg(this._state, { type: 'enterBg' })
    if (t.state.name !== 'handoff') return
    this._state = t.state
    this._startSwap()
  }

  private _startSwap(): void {
    const el = this._el
    const fg = this._deps.fgElement
    if (!el) return
    this._engine.teardownCrossfadeMonitor()
    if (!el.src || el.src !== fg.src) {
      el.src = fg.src
      // On iOS, preload is ignored and the element may not have loaded enough
      // data for a reliable seek. Force a reinitialization so currentTime
      // takes effect properly.
      if (this._engine.isIOS) el.load()
    } else if (this._engine.isIOS && el.readyState < 2) {
      el.load()
    }
    // Compensate for the WebAudio pipeline latency: the user hears audio
    // slightly behind the element's decode position (SoundTouch + EQ + output
    // buffering). The raw bg element bypasses all of it, so start slightly
    // earlier to match what was just heard.
    const offset = this._engine.getTransitionOffset()
    el.currentTime = Math.max(0, fg.currentTime - offset)
    el.playbackRate = this._speed
    void this._settlePlay(++this._settleToken)
  }

  private async _onVisible(): Promise<void> {
    if (!this.engaged) {
      // Old parity: visible with a non-running context revives it even when
      // the bg swap never engaged (a failed bg play).
      await this._engine.reviveContext().catch(() => {})
      return
    }
    // A dead AudioContext must never kill the exit — the fg element plays via
    // plain element audio if the context is irrecoverable.
    await this._engine.reviveContext().catch(() => {})

    const el = this._el
    if (!el) return
    const f = this._deps.facts()
    const event: BgExitEvent = {
      type: 'exitBg',
      ended: el.ended,
      wasPlaying: !el.paused,
      position: el.currentTime,
      atEnd: f.duration > 0 && el.currentTime >= f.duration - PARK_WINDOW,
      trackId: f.currentTrackId,
      parkArmed: f.parkArmed,
      loopMode: f.loopMode,
      hasNext: f.hasNext,
      hasUserQueue: f.hasUserQueue,
    }
    this._stopTick()
    ++this._settleToken // cancel any in-flight settle (the swap/load element)
    el.pause()
    el.removeAttribute('src')
    el.load()

    const prev = this._state
    const t = transitionBg(prev, event)
    this._state = t.state
    if (t.command) await this._executeCommand(t.command, event, prev)
    this._engine.resumeCrossfadeAfterBgExit()
  }

  private readonly _onEnded = (): void => {
    if (!this.engaged || !this._el) return
    void this._dispatch(this._endEvent(false))
  }

  private readonly _onError = (): void => {
    if (!this.engaged || !this._el) return
    // bg retry cap is 0 (1.2): the FIRST error is a give-up — no backoff.
    if (this._retry.onError().kind !== 'give-up') return
    this._retry.reset()
    void this._dispatch(this._endEvent(true))
  }

  private _endEvent(fromError: boolean): BgEndEvent {
    const f = this._deps.facts()
    return {
      type: 'trackEnded',
      trackId: f.currentTrackId,
      fromError,
      parkArmed: f.parkArmed,
      loopMode: f.loopMode,
      hasNext: f.hasNext,
      hasUserQueue: f.hasUserQueue,
    }
  }

  private async _dispatch(event: BgEvent): Promise<void> {
    const prev = this._state
    const t = transitionBg(prev, event)
    this._state = t.state
    if (t.command) await this._executeCommand(t.command, event, prev)
    // Park extras fire only on the transition INTO park-pending — a re-trip
    // that stays parked must not re-report the park.
    if (prev.name !== 'park-pending' && t.state.name === 'park-pending') this._park()
  }

  private async _executeCommand(command: BgCommand, event: BgEvent, prev: BgState): Promise<void> {
    switch (command.kind) {
      case 'load':
        // The exit path awaits this so the crossfade re-arm runs after the fg
        // load; bg-target loads settle via startBgLoad/abortBgLoad.
        await this.onLoad?.(command.target, command.decision)
        return
      case 'pause':
        if (event.type === 'bgStarted') {
          // The enter-swap completed — the fg element was audible until now.
          this._deps.fgElement.pause()
          return
        }
        if (event.type === 'pauseCmd' && prev.name === 'handoff') {
          // Correction 6: pause the AUDIBLE (fg) element and cancel the
          // pending swap — a stale settle is a no-op via the token.
          ++this._settleToken
          this._el?.pause()
          this._deps.fgElement.pause()
          return
        }
        this._el?.pause()
        return
      case 'play':
        this._el?.play().catch(() => {})
        return
      case 'resumeFg':
        this._deps.fgElement.currentTime = command.position
        await this._deps.fgElement.play().catch(() => {})
        await this._dispatch({ type: 'resumed' })
        return
      case 'carryPaused':
        this._deps.fgElement.currentTime = command.position
        return
      case 'stop':
        this.onStop?.(command.target)
        return
    }
  }

  private _park(): void {
    const f = this._deps.facts()
    if (f.duration > 0 && this._el) {
      const pos = this._el.currentTime
      if (pos >= f.duration - PARK_WINDOW) {
        // Nudge below the end: play() on an ENDED element seeks to the start,
        // which would replay the whole track — a parked resume must play the
        // ~PARK_TAIL tail and re-fire `ended` to drive the natural advance.
        this._el.currentTime = Math.min(pos, f.duration - PARK_TAIL)
      }
    }
    this.onParked?.(f.currentTrackId ?? '')
  }

  private async _settlePlay(token: number): Promise<boolean> {
    if (!this._el) return false
    try {
      await this._el.play()
      if (token !== this._settleToken) return false
      await this._dispatch({ type: 'bgStarted' })
      if (this._state.name === 'bg-playing') this._startTick()
      return true
    } catch {
      if (token !== this._settleToken) return false
      await this._dispatch({ type: 'bgFailed' })
      return false
    }
  }

  private _startTick(): void {
    if (this._tick) return
    this._tick = this._timers.interval(TICK_MS, () => {
      if (!this._el) return
      const pos = this._el.currentTime
      this.onTick?.(pos)
      const f = this._deps.facts()
      // End-of-track watchdog: iOS can stall the `ended` event in background.
      // Re-trips in paused/parked states are dropped by the machine.
      if (f.duration > 0 && pos >= f.duration - WATCHDOG_MARGIN) {
        void this._dispatch(this._endEvent(false))
      }
    })
  }

  private _stopTick(): void {
    if (this._tick) {
      this._tick()
      this._tick = null
    }
  }
}
