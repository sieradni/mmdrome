/**
 * Pure background-mode state machine (TODO 1.0 Step 1) — the consolidation of
 * the web/iOS bg interlock soup in playbackManager/audioManager/mediaSession
 * (`_inBgMode`, `_enterBgSeq`, `_handlingEnd`, `parkedAtEnd`/`parkedTrackId`,
 * the mediaSession watchdog re-trip guard) into ONE explicit transition
 * function. No DOM, no stores, no timers — a pure reducer over plain data,
 * with the advance chain delegated to `decideAdvance`.
 *
 * Adapter contract (WebBgTransport, later step): the adapter translates DOM
 * events into `BgEvent`s, executes the returned `BgCommand`s, and is the ONLY
 * thing that touches the audio elements and queue:
 *
 *   - `enterBg`   — visibilitychange → hidden while the foreground element is
 *                   actually playing (a paused element never enters bg).
 *   - `bgStarted` — the pending bg play() succeeded (fg element pauses when
 *                   the origin is 'enter' — the swap handoff).
 *   - `bgFailed`  — the pending bg play() rejected OR the load was a no-op
 *                   (no track to load). origin 'enter' rolls back to
 *                   foreground (fg element is still audible); origin 'load'
 *                   idles in bg-paused — background has NO retry policy
 *                   (parity with `_loadAndPlayInBg`'s `if (!started) return`).
 *   - `trackEnded`— bg element ended, OR the mediaSession watchdog fired, OR
 *                   the bg element errored (adapter sets fromError). Carries
 *                   the queue facts the advance chain needs; the adapter
 *                   computes them BEFORE any queue mutation.
 *   - `exitBg`    — visibilitychange → visible. Carries the teardown snapshot
 *                   (`ended`/`wasPlaying`/`position`), the current track id
 *                   (park gate), and the queue facts for the fg advance chain.
 *   - `loadRequest` — an explicit load (next/prev/select/play) while bg is
 *                   engaged; the queue was already advanced by the caller, so
 *                   the load decision is 'reload' (load the resolved track).
 *                   Superseding an in-flight enter-swap marks the handoff
 *                   `superseded` — the exit then re-routes the load to the fg
 *                   path (correction 7).
 *   - `playCmd`/`pauseCmd` — lock-screen media-session commands (in bg). A
 *                   pause during a handoff parks immediately (correction 6):
 *                   the audible element pauses and the pending swap is
 *                   cancelled (a stale bgStarted/bgFailed settle is a no-op
 *                   in bg-paused).
 *   - `resumed`   — the exit-bg foreground resume finished (adapter fires it
 *                   even when play() rejects — swallowed, same as today).
 *
 * Command → adapter:
 *   - load{target:'bg'}    → resolve the track per decision (restart = current,
 *     advance = advanceQueue() + next, wrap = index 0 + first, reload = the
 *     caller-resolved track) and run the bg load; fire bgStarted/bgFailed.
 *     'reload' on target:'fg' (exit raced an in-flight load) retries that same
 *     track through the foreground load path.
 *   - load{target:'fg'}    → same decision mapping, foreground load.
 *   - pause / play         → pause/resume the bg element. During an enter-
 *     handoff `pause` means the AUDIBLE element (the fg one) and cancels the
 *     pending swap (correction 6).
 *   - resumeFg(position)   → carry position to the fg element + resume.
 *   - carryPaused(position)→ carry position to the fg element, stay paused.
 *   - stop{target:'fg'}    → clear element src + stopped state (the `_onTrackEnded`
 *     end-of-queue behavior). stop{target:'bg'} → idle no-op (the bg element
 *     already ended; parity with `_onBgTrackEnd`, which has no stop branch).
 *
 * Deliberate corrections over the current four-site behavior (pinned by tests,
 * documented in AGENTS.md §4 A6):
 *   1. The exit-bg park is gated on `parkArmed && (ended || atEnd)` — the old
 *      `_handleExitBackground` parked unconditionally when the end-of-track
 *      sleep was armed, pausing mid-track playback on unlock (the sleep is
 *      "stop at track end", not "pause on unlock"; the fg advance chain parks
 *      at the natural end anyway).
 *   2. Exiting a manually-paused bg carries the bg position to the fg element
 *      (`carryPaused`) — the old code left the fg element at its stale pre-bg
 *      position, so resuming re-listened from the wrong spot.
 *   3. The exit-bg ended chain routes through `decideAdvance`, so loop-one
 *      RESTARTS the current track — `_handleExitBackground`'s missing loop-one
 *      branch (it advanced instead) is fixed.
 *   4. `trackEnded` in any paused or in-flight state is structurally a no-op —
 *      the old `_handlingEnd` re-entrance guard and the watchdog re-trip
 *      paused-guard collapse into state.
 *   5. A re-hide DURING the fg resume re-engages the swap (`resuming + enterBg
 *      → handoff{enter}`) — `_enterBackground` (audioManager.ts:209) only
 *      guards `_inBgMode`, which is already false during the resume window
 *      (`_exitBackground` flips it before `onExitBackground`), so the current
 *      code re-enters background there. A no-op would strand the fg element
 *      playing with no bg element and no lock-screen routing. (Originally
 *      pinned as a no-op from a misremembered `_enterBgSeq` claim — corrected
 *      same-day on re-review.)
 *   6. Lock-screen pause during a handoff parks immediately (`handoff +
 *      pauseCmd → bg-paused + pause`) instead of being dropped — the current
 *      code pauses the bg element directly while `_inBgMode` is true mid-swap
 *      (audioManager.ts:239 sets it synchronously), so the user's pause must
 *      land. The adapter pauses the AUDIBLE element (fg during an enter-swap)
 *      and cancels the pending swap; a stale settle is a no-op here.
 *   7. A load that supersedes an in-flight enter-swap (`loadRequest` marks the
 *      handoff `superseded`) is re-routed to the fg load path on exit —
 *      without it the fg element resumes the OLD track while the queue already
 *      advanced (an in-bg next/prev). The current code has this same flaw;
 *      the machine fixes it.
 */

import { decideAdvance, type LoopMode } from './advanceDecider'

export type BgState =
  | { name: 'foreground' }
  | {
      name: 'handoff'
      origin: 'enter' | 'load'
      /** True when an explicit loadRequest superseded an in-flight enter-swap
       *  — exit then re-routes the load to the fg path (correction 7). */
      superseded: boolean
    }
  | { name: 'bg-playing' }
  | { name: 'bg-paused' }
  | { name: 'park-pending'; trackId: string | null }
  | { name: 'resuming' }

export type BgEvent =
  | { type: 'enterBg' }
  | { type: 'bgStarted' }
  | { type: 'bgFailed' }
  | {
      type: 'exitBg'
      ended: boolean
      /** True when the bg position is within the end-of-track park window
       *  (duration − 0.5s) — the adapter computes it; the park gate needs it
       *  because `ended` alone misses the watchdog's −0.25s trip point. */
      atEnd: boolean
      wasPlaying: boolean
      position: number
      /** Current track id at exit — the park-carry gate. */
      trackId: string | null
      parkArmed: boolean
      loopMode: LoopMode
      hasNext: boolean
      hasUserQueue: boolean
    }
  | {
      type: 'trackEnded'
      trackId: string | null
      fromError: boolean
      parkArmed: boolean
      loopMode: LoopMode
      hasNext: boolean
      hasUserQueue: boolean
    }
  | { type: 'loadRequest' }
  | { type: 'playCmd' }
  | { type: 'pauseCmd' }
  | { type: 'resumed' }

export type BgCommand =
  | { kind: 'load'; target: 'fg' | 'bg'; decision: 'restart' | 'advance' | 'wrap' | 'reload' }
  | { kind: 'pause' }
  | { kind: 'play' }
  | { kind: 'resumeFg'; position: number }
  | { kind: 'carryPaused'; position: number }
  | { kind: 'stop'; target: 'fg' | 'bg' }

export interface BgTransition {
  state: BgState
  /** Side effect for the adapter to execute; null = nothing to do. */
  command: BgCommand | null
}

export function transitionBg(state: BgState, event: BgEvent): BgTransition {
  switch (event.type) {
    case 'enterBg':
      return enterBg(state)
    case 'bgStarted':
      return bgStarted(state)
    case 'bgFailed':
      return bgFailed(state)
    case 'exitBg':
      return exitBg(state, event)
    case 'trackEnded':
      return trackEnded(state, event)
    case 'loadRequest':
      return loadRequest(state)
    case 'playCmd':
      return playCmd(state)
    case 'pauseCmd':
      return pauseCmd(state)
    case 'resumed':
      return resumed(state)
  }
}

function stay(s: BgState): BgTransition {
  return { state: s, command: null }
}

function enterBg(s: BgState): BgTransition {
  // A re-hide during the fg resume re-engages the swap (correction 5): the
  // adapter fires enterBg only when the fg element is actually playing, so
  // resuming is a valid handoff source.
  if (s.name !== 'foreground' && s.name !== 'resuming') return stay(s)
  return { state: { name: 'handoff', origin: 'enter', superseded: false }, command: null }
}

function bgStarted(s: BgState): BgTransition {
  if (s.name !== 'handoff') return stay(s)
  if (s.origin === 'enter') {
    // The swap succeeded: the fg element was audible until now — pause it.
    return { state: { name: 'bg-playing' }, command: { kind: 'pause' } }
  }
  return { state: { name: 'bg-playing' }, command: null }
}

function bgFailed(s: BgState): BgTransition {
  if (s.name !== 'handoff') return stay(s)
  if (s.origin === 'enter') {
    // Enter rollback: the fg element never paused — nothing to undo.
    return { state: { name: 'foreground' }, command: null }
  }
  // A bg load that never started — idle, no retry (bg has no retry policy).
  return { state: { name: 'bg-paused' }, command: null }
}

function trackEnded(s: BgState, e: Extract<BgEvent, { type: 'trackEnded' }>): BgTransition {
  if (s.name !== 'bg-playing') return stay(s)
  const decision = decideAdvance({
    fromError: e.fromError,
    parkArmed: e.parkArmed,
    loopMode: e.loopMode,
    hasNext: e.hasNext,
    hasUserQueue: e.hasUserQueue,
  })
  switch (decision) {
    case 'park':
      return {
        state: { name: 'park-pending', trackId: e.trackId },
        command: { kind: 'pause' },
      }
    case 'restart':
    case 'advance':
    case 'wrap':
      return {
        state: { name: 'handoff', origin: 'load', superseded: false },
        command: { kind: 'load', target: 'bg', decision },
      }
    case 'stop':
      return { state: { name: 'bg-paused' }, command: { kind: 'stop', target: 'bg' } }
  }
}

function loadRequest(s: BgState): BgTransition {
  switch (s.name) {
    case 'foreground':
    case 'resuming':
      return stay(s)
    case 'handoff':
      // A second load during an in-flight one supersedes it (last wins, like
      // playBg overwriting the src today). If this was an enter-swap, the exit
      // re-routes the load to the fg path (correction 7).
      return { state: { ...s, superseded: true }, command: { kind: 'load', target: 'bg', decision: 'reload' } }
    case 'bg-playing':
    case 'bg-paused':
    case 'park-pending':
      return {
        state: { name: 'handoff', origin: 'load', superseded: false },
        command: { kind: 'load', target: 'bg', decision: 'reload' },
      }
  }
}

function playCmd(s: BgState): BgTransition {
  switch (s.name) {
    case 'bg-paused':
    case 'park-pending':
      // Park consumed by the resume — the tail plays out and the re-fired
      // ended drives the natural advance.
      return { state: { name: 'bg-playing' }, command: { kind: 'play' } }
    default:
      return stay(s)
  }
}

function pauseCmd(s: BgState): BgTransition {
  switch (s.name) {
    case 'bg-playing':
    case 'handoff':
      // Pause during a handoff lands immediately (correction 6): the audible
      // element pauses (fg during an enter-swap, bg during a load) and the
      // pending swap is cancelled — a stale settle is a no-op in bg-paused.
      return { state: { name: 'bg-paused' }, command: { kind: 'pause' } }
    default:
      return stay(s)
  }
}

function resumed(s: BgState): BgTransition {
  if (s.name !== 'resuming') return stay(s)
  return { state: { name: 'foreground' }, command: null }
}

function exitBg(s: BgState, e: Extract<BgEvent, { type: 'exitBg' }>): BgTransition {
  switch (s.name) {
    case 'foreground':
    case 'resuming':
      return stay(s)
    case 'handoff':
      if (s.origin === 'enter' && !s.superseded) {
        // The swap never completed — the fg element is still audible.
        return { state: { name: 'foreground' }, command: null }
      }
      // Exit raced an in-flight bg load — or a load that superseded an
      // enter-swap (correction 7) — retry the same track via the fg path.
      return {
        state: { name: 'foreground' },
        command: { kind: 'load', target: 'fg', decision: 'reload' },
      }
    case 'bg-paused':
      return { state: { name: 'foreground' }, command: { kind: 'carryPaused', position: e.position } }
    case 'park-pending':
      if (!e.wasPlaying && e.trackId === s.trackId) {
        // The sleep park survives the exit: carry the bg position and stay
        // paused — a later play resumes the tail and the re-fired ended
        // advances (loop-all wrap, queue end, scrobble).
        return { state: { name: 'foreground' }, command: { kind: 'carryPaused', position: e.position } }
      }
      // The park was superseded (resumed in bg / track changed) — treat like
      // a regular bg-playing exit.
      return exitFromBgPlaying(e)
    case 'bg-playing':
      return exitFromBgPlaying(e)
  }
}

function exitFromBgPlaying(e: Extract<BgEvent, { type: 'exitBg' }>): BgTransition {
  // Park gate: the end-of-track sleep parks at exit ONLY when the track is at
  // its end (correction 1 — unlocking mid-track must not pause playback).
  if (e.parkArmed && (e.ended || e.atEnd)) {
    return { state: { name: 'foreground' }, command: { kind: 'carryPaused', position: e.position } }
  }
  if (e.ended) {
    // The bg element ended while backgrounded — run the fg advance chain
    // (correction 3: loop-one RESTARTS, via decideAdvance).
    const decision = decideAdvance({
      fromError: false,
      parkArmed: false,
      loopMode: e.loopMode,
      hasNext: e.hasNext,
      hasUserQueue: e.hasUserQueue,
    })
    switch (decision) {
      case 'restart':
      case 'advance':
      case 'wrap':
        return { state: { name: 'foreground' }, command: { kind: 'load', target: 'fg', decision } }
      case 'stop':
        return { state: { name: 'foreground' }, command: { kind: 'stop', target: 'fg' } }
      case 'park':
        return { state: { name: 'foreground' }, command: { kind: 'carryPaused', position: e.position } }
    }
  }
  if (e.wasPlaying) {
    return { state: { name: 'resuming' }, command: { kind: 'resumeFg', position: e.position } }
  }
  // Manually/sleep-paused exit: carry the bg position, stay paused
  // (correction 2 — the old code left the fg element at its stale pre-bg spot).
  return { state: { name: 'foreground' }, command: { kind: 'carryPaused', position: e.position } }
}