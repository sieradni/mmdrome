// Pins the shared scroll-window machine (`src/lib/scrollWindow.ts`) — the
// engine extracted from the four virtual views (2026-09-28): the
// SCROLL_UPDATE_MS-throttled scroll handler with its trailing rAF pass, the
// consume-once restore, and the measure-before-compute ordering. The machine
// is deliberately runes-free, so these pins run in plain Node with fake time
// and a manual rAF queue.
//
// The pure window math itself is pinned by tests/virtualWindow.test.ts and
// tests/gridWindow.test.ts — this suite pins the ENGINE around it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScrollWindow } from '../src/lib/scrollWindow'
import { SCROLL_UPDATE_MS } from '../src/lib/virtualWindow'

interface Win {
  start: number
  end: number
}

function makeHarness() {
  const el = { scrollTop: 0, clientHeight: 700 } as HTMLElement
  let total = 100
  let win: Win = { start: 0, end: 0 }
  let rowH = 56
  let deriveCount = 0
  let t = 1_000
  const rafQueue: Array<() => void> = []

  const machine = createScrollWindow<Win>({
    getTotal: () => total,
    getViewport: () => el,
    getWindow: () => win,
    setWindow: (w) => {
      win = w
      deriveCount++
    },
    getRowH: () => rowH,
    setRowH: (h) => {
      rowH = h
    },
    // Simple visible floor math: start = the row at scrollTop.
    compute: (o) => ({ start: Math.floor(o.scrollTop / o.rowH), end: Math.min(o.total, Math.floor(o.scrollTop / o.rowH) + 5) }),
    viewKey: 'test',
    scrollTopField: 'scrollTop',
    now: () => t,
    raf: (cb) => {
      rafQueue.push(cb)
      return rafQueue.length
    },
  })

  return {
    machine,
    el,
    win: () => win,
    rowH: () => rowH,
    deriveCount: () => deriveCount,
    setTotal: (n: number) => {
      total = n
    },
    advance: (ms: number) => {
      t += ms
    },
    /** Run every queued rAF callback (one frame). */
    frame: () => {
      const cbs = rafQueue.splice(0)
      for (const cb of cbs) cb()
    },
    rafPending: () => rafQueue.length,
  }
}

test('onScroll derives immediately when the throttle is open', () => {
  const h = makeHarness()
  h.el.scrollTop = 800
  h.machine.onScroll()
  assert.equal(h.deriveCount(), 1)
  assert.equal(h.win().start, Math.floor(800 / 56))
})

test('rapid scrolls throttle, and the trailing pass derives the LAST position', () => {
  const h = makeHarness()
  h.machine.onScroll() // t=1000: open → derive #1
  assert.equal(h.deriveCount(), 1)

  h.advance(10) // inside the throttle window
  h.el.scrollTop = 5_600
  h.machine.onScroll()
  assert.equal(h.deriveCount(), 1, 'throttled: no immediate derive')
  assert.equal(h.rafPending(), 1, 'one trailing pass scheduled')

  // The trailing pass fires while STILL throttled (frozen time) → it must
  // reschedule, never derive a stale window.
  h.frame()
  assert.equal(h.deriveCount(), 1)

  // Time passes the throttle → the trailing pass derives the CURRENT
  // scrollTop (the scrollbar drag's final position).
  h.advance(SCROLL_UPDATE_MS + 1)
  h.frame()
  assert.equal(h.deriveCount(), 1 + 1)
  assert.equal(h.win().start, Math.floor(5_600 / 56))
})

test('restore waits for content, lands once, never re-fires', () => {
  const h = makeHarness()
  h.setTotal(0) // empty list (boot / library not loaded yet)
  h.machine.armRestore(1_234)
  h.machine.restoreIfReady()
  assert.equal(h.el.scrollTop, 0, 'no content: pending restore survives')

  h.setTotal(100)
  const before = h.deriveCount()
  h.machine.restoreIfReady()
  assert.equal(h.el.scrollTop, 1_234, 'lands exactly once content exists')
  assert.equal(h.deriveCount(), before + 1, 'the landing derives the window')

  h.machine.restoreIfReady()
  assert.equal(h.deriveCount(), before + 1, 'consume-once: never re-fires')
})

test('measure runs BEFORE compute in the same derive (then re-derives)', () => {
  const el = { scrollTop: 800, clientHeight: 700 } as HTMLElement
  let win: Win = { start: 0, end: 0 }
  let rowH = 56
  let deriveCount = 0
  const rafQueue: Array<() => void> = []
  const machine = createScrollWindow<Win>({
    getTotal: () => 100,
    getViewport: () => el,
    getWindow: () => win,
    setWindow: (w) => {
      win = w
      deriveCount++
    },
    getRowH: () => rowH,
    setRowH: (h) => {
      rowH = h
    },
    compute: (o) => ({ start: Math.floor(o.scrollTop / o.rowH), end: 0 }),
    // A DOM measurement that changes the row height (the grid's first derive).
    measure: (_el, current) => (current === 56 ? 100 : current),
    viewKey: 'test',
    scrollTopField: 'scrollTop',
    // Manual rAF queue: the row-height change schedules the follow-up derive
    // (the spacer pads shift after this frame — the anchoring-off rederive).
    raf: (cb) => {
      rafQueue.push(cb)
      return rafQueue.length
    },
  })
  machine.deriveNow()
  assert.equal(rowH, 100, 'the measured row height is folded in')
  assert.equal(win.start, Math.floor(800 / 100), 'the SAME derive used the fresh row height')
  assert.equal(rafQueue.length, 1, 'the pad-shift follow-up is scheduled')
  for (const cb of rafQueue.splice(0)) cb()
  assert.equal(deriveCount, 2, 'the follow-up derive re-cuts the window')
  assert.equal(rafQueue.length, 0, 'EMA converged: no further rederives')
})

test('observeResize is a safe no-op without ResizeObserver (Node)', () => {
  const h = makeHarness()
  const disconnect = h.machine.observeResize()
  assert.equal(typeof disconnect, 'function')
  disconnect()
})
