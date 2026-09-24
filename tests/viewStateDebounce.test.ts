// Pins the scroll-jank persistence debounce (P2, 2026-09-23): every view's
// scroll handler calls saveViewState PER SCROLL EVENT, and the pre-debounce
// code JSON.stringify'd the whole store + hit localStorage synchronously
// mid-gesture each time. Contract: the in-memory merge stays SYNCHRONOUS
// (restore right after save sees the value), only the stringify+write is
// trailing-debounced, and flushViewStatePersistence() writes pending state
// immediately (the pagehide/visibilitychange lifeline — iOS kills the
// webview without beforeunload).
//
// The module reads localStorage/sessionStorage AT IMPORT TIME (the initial
// `load()`), so the storage stubs are installed before the dynamic import.
// setTimeout/clearTimeout are captured so the 300 ms debounce fires
// deterministically (no wall-clock sleeps).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'

type PendingFire = { fire: () => void; cleared: boolean }

/** Map-backed storage stub (authSalt.test.ts precedent). */
function stubStorage(name: 'localStorage' | 'sessionStorage'): { store: Map<string, string>; restore: () => void } {
  const store = new Map<string, string>()
  const original = (globalThis as any)[name]
  ;(globalThis as any)[name] = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  return { store, restore: () => { (globalThis as any)[name] = original } }
}

/** Captures debounce timers: the returned object IS the live capture —
 *  `timers.pending` updates when viewState schedules, and assigning null
 *  just resets the observation point. */
function stubTimers(): { pending: PendingFire | null; restore: () => void } {
  const originals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  const capture: { pending: PendingFire | null; restore?: () => void } = { pending: null }
  ;(globalThis as any).setTimeout = (fn: () => void, _ms?: number) => {
    const slot: PendingFire = { fire: fn, cleared: false }
    capture.pending = slot
    return slot as unknown as ReturnType<typeof setTimeout>
  }
  ;(globalThis as any).clearTimeout = (handle: unknown) => {
    if (handle && typeof (handle as PendingFire).fire === 'function') (handle as PendingFire).cleared = true
    if (capture.pending === handle) capture.pending = null
  }
  capture.restore = () => {
    globalThis.setTimeout = originals.setTimeout
    globalThis.clearTimeout = originals.clearTimeout
  }
  return capture as { pending: PendingFire | null; restore: () => void }
}

const ls = stubStorage('localStorage')
const ss = stubStorage('sessionStorage')
const timers = stubTimers()

const { saveViewState, restoreViewState, saveViewStateSession, restoreViewStateSession, flushViewStatePersistence } =
  await import('../src/lib/viewState')

function persisted(): { songs?: { scrollTop?: number }; albums?: { scrollTop?: number } } {
  const raw = ls.store.get('mmdrome_viewstate')
  return raw ? JSON.parse(raw) : {}
}

test('save is synchronous in memory, NOT in storage; the debounced write lands the trailing value', () => {
  saveViewState('songs', { scrollTop: 10 })
  // In-memory merge is immediate — restore semantics unchanged.
  assert.deepEqual(restoreViewState('songs'), { scrollTop: 10 })
  // No synchronous storage write (the whole point).
  assert.equal(ls.store.has('mmdrome_viewstate'), false, 'storage must not be written synchronously')

  saveViewState('songs', { scrollTop: 20 })
  assert.deepEqual(restoreViewState('songs'), { scrollTop: 20 })

  // Fire the debounce: the TRAILING value lands.
  const slot = timers.pending
  assert.ok(slot, 'a debounce timer is pending')
  slot!.fire()
  assert.equal(persisted().songs?.scrollTop, 20)
})

test('a second save while the timer is pending does not reschedule (trailing debounce)', () => {
  timers.pending = null // reset observation only
  saveViewState('songs', { scrollTop: 30 })
  // The `timers.pending = null` above flow-narrows the property read to
  // `null`; the assertion re-widens so assert.ok narrows to PendingFire,
  // not never.
  const first = timers.pending as PendingFire | null
  assert.ok(first, 'first save schedules')
  // A second save while armed: still only the ONE timer.
  saveViewState('songs', { scrollTop: 31 })
  assert.equal(timers.pending, first, 'no second timer was scheduled')
  assert.deepEqual(restoreViewState('songs'), { scrollTop: 31 })
  // The single armed timer lands the trailing value.
  first!.fire()
  assert.equal(persisted().songs?.scrollTop, 31)
})

test('flushViewStatePersistence writes pending state immediately (both stores)', () => {
  saveViewState('albums', { scrollTop: 5 })
  saveViewStateSession('settings', { tab: 'about' })
  assert.equal(persisted().albums?.scrollTop, undefined, 'not yet written')
  flushViewStatePersistence()
  assert.equal(persisted().albums?.scrollTop, 5)
  assert.equal(JSON.parse(ss.store.get('mmdrome_viewstate')!).settings.tab, 'about')
  // Session view has the same synchronous in-memory contract.
  assert.deepEqual(restoreViewStateSession('settings'), { tab: 'about' })
})

test('flush with no pending timer is a no-op (safe for repeated lifecycle events)', () => {
  assert.doesNotThrow(() => flushViewStatePersistence())
})

// Restore the real globals after ALL tests have run. This must NOT be
// top-level code: node:test registers test() callbacks and executes them
// AFTER the module body completes, so a top-level restore stripped the stubs
// before the first test body ever ran (every assertion then saw the real
// 300 ms timer and an undefined localStorage).
after(() => {
  timers.restore()
  ls.restore()
  ss.restore()
})
