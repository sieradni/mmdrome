import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateCrossfadeGate,
  isSeekInCrossfadeWindow,
  shouldPauseOldElement,
} from '../src/lib/playbackCore/crossfadePolicy'

// ── evaluateCrossfadeGate ───────────────────────────────────────────────────

const BASE = {
  fadeDuration: 15,
  currentDuration: 300,
  hasTarget: true,
  nextDuration: 240,
  seekSuppressed: false,
}

/** Narrows the gate to its blocked reason for assertion brevity. */
function blockedReason(gate: ReturnType<typeof evaluateCrossfadeGate>): string | undefined {
  return gate.allowed ? undefined : gate.blockedBy
}

test('gate allows the happy path', () => {
  assert.deepEqual(evaluateCrossfadeGate(BASE), { allowed: true })
})

test('gate blocks when the crossfade is disabled (fadeDuration <= 0)', () => {
  for (const fadeDuration of [0, -1]) {
    const gate = evaluateCrossfadeGate({ ...BASE, fadeDuration })
    assert.deepEqual(gate, { allowed: false, blockedBy: 'disabled' })
  }
})

test('gate blocks on unknown current duration', () => {
  const gate = evaluateCrossfadeGate({ ...BASE, currentDuration: 0 })
  assert.deepEqual(gate, { allowed: false, blockedBy: 'missingCurrentDuration' })
})

test('gate blocks a current track shorter than fadeDuration + 1 (margin parity with Swift)', () => {
  // 15.9 < 15 + 1 → too short; exactly 16 passes.
  assert.equal(blockedReason(evaluateCrossfadeGate({ ...BASE, currentDuration: 15.9 })), 'currentTooShort')
  assert.deepEqual(evaluateCrossfadeGate({ ...BASE, currentDuration: 16 }), { allowed: true })
})

test('gate blocks when no target is armed', () => {
  const gate = evaluateCrossfadeGate({ ...BASE, hasTarget: false })
  assert.deepEqual(gate, { allowed: false, blockedBy: 'noTarget' })
})

test('gate blocks an UNKNOWN target duration — never fade in blind', () => {
  const gate = evaluateCrossfadeGate({ ...BASE, nextDuration: null })
  assert.deepEqual(gate, { allowed: false, blockedBy: 'nextTooShort' })
})

test('gate blocks a target shorter than the fade (it would end mid-ramp)', () => {
  assert.equal(blockedReason(evaluateCrossfadeGate({ ...BASE, nextDuration: 14.9 })), 'nextTooShort')
  assert.deepEqual(evaluateCrossfadeGate({ ...BASE, nextDuration: 15 }), { allowed: true })
})

test('gate blocks while seek suppression is latched', () => {
  const gate = evaluateCrossfadeGate({ ...BASE, seekSuppressed: true })
  assert.deepEqual(gate, { allowed: false, blockedBy: 'seekSuppressed' })
})

test('gate reason precedence is deterministic (documented check order)', () => {
  // disabled wins over everything
  assert.equal(
    blockedReason(evaluateCrossfadeGate({ ...BASE, fadeDuration: 0, seekSuppressed: true, hasTarget: false })),
    'disabled',
  )
  // missing duration beats shortness; noTarget beats nextTooShort
  assert.equal(
    blockedReason(evaluateCrossfadeGate({ ...BASE, currentDuration: 0, hasTarget: false })),
    'missingCurrentDuration',
  )
  assert.equal(
    blockedReason(evaluateCrossfadeGate({ ...BASE, hasTarget: false, nextDuration: null })),
    'noTarget',
  )
  // suppression is evaluated LAST — a suppressed-but-valid window reports it
  assert.equal(
    blockedReason(evaluateCrossfadeGate({ ...BASE, seekSuppressed: true, nextDuration: null })),
    'nextTooShort',
  )
})

// ── isSeekInCrossfadeWindow ────────────────────────────────────────────────

test('seek at/inside the window boundary is in-window', () => {
  // 30s track, 10s fade: position 20 is exactly the transition point.
  assert.equal(isSeekInCrossfadeWindow(20, 30, 10), true)
  assert.equal(isSeekInCrossfadeWindow(29.9, 30, 10), true)
  assert.equal(isSeekInCrossfadeWindow(30, 30, 10), true) // clamped-to-end seeks
})

test('seek outside the window leaves automation intact', () => {
  assert.equal(isSeekInCrossfadeWindow(19.9, 30, 10), false)
  assert.equal(isSeekInCrossfadeWindow(0, 30, 10), false)
})

test('zero fade or zero duration is never in-window', () => {
  assert.equal(isSeekInCrossfadeWindow(25, 30, 0), false)
  assert.equal(isSeekInCrossfadeWindow(25, 0, 10), false)
})

// ── shouldPauseOldElement ──────────────────────────────────────────────────

test('delayed retire pauses only genuinely-retired, still-running elements', () => {
  assert.equal(shouldPauseOldElement(false, false), true)
  // The stale-timer regression: a second switch made the element ACTIVE again
  // — pausing would kill live audio (the reported "next song pauses" bug).
  assert.equal(shouldPauseOldElement(false, true), false)
  // Ended on its own — nothing to do.
  assert.equal(shouldPauseOldElement(true, false), false)
  assert.equal(shouldPauseOldElement(true, true), false)
})
