/**
 * The shared scroll-window machinery behind every virtual surface (2026-09-28
 * extraction — SongsView, the Albums/Artists grids + detail lists, and the
 * Queue's two sections previously carried four hand-copies of the same
 * engine): the `SCROLL_UPDATE_MS`-throttled scroll handler with its trailing
 * rAF pass (a scrollbar drag's LAST event must never leave a stale window),
 * the per-scroll view-state save, the immediate derive, the ResizeObserver
 * re-derive, and the consume-once scrollTop restore.
 *
 * DELIBERATELY RUNES-FREE (design rule F2): the machine is plain, Node-
 * testable logic. A view hands in reactive accessors — `getTotal: () =>
 * processed.length`, `setWindow: (w) => { win = w }` — and because those
 * arrows are defined INSIDE the component, Svelte compiles the `$state`
 * reads/writes at the call site: the machine's synchronous calls track and
 * drive real signals without importing a single rune. The view keeps only
 * the genuinely reactive parts: the `$state` window/row-height holders, the
 * `$derived` slices and spacer pads, the pure compute closure (computeWindow
 * / computeGridWindow / the queue's two-section math), and ONE small effect
 * that re-derives on content changes, consumes the restore, and owns the
 * ResizeObserver lifecycle.
 *
 * Restore semantics (consume-once): `armRestore(v)` parks a scrollTop;
 * `restoreIfReady()` assigns it and derives ONLY once the container exists
 * and the list has content (`getTotal() > 0`) — the window model's spacer
 * sum always spans the full list, so the assignment lands exactly. A pending
 * restore survives until the content arrives; a consumed one never re-fires
 * (a later filter change must not yank the scroll position — the views'
 * explicit re-arm triggers, e.g. the grids' detail-close flow, re-arm it).
 */

import { saveViewState } from './viewState'
import { SCROLL_UPDATE_MS, updateRowMetrics } from './virtualWindow'

export interface ScrollWindowOptions<W> {
  /** Total rendered items — pass an arrow reading the component's derived. */
  getTotal: () => number
  /** The scroller element — pass an arrow reading the bound container. */
  getViewport: () => HTMLElement | null
  /** Current window state (read) — a `$state` holder in the view. */
  getWindow: () => W
  /** Window write — the same `$state` holder's setter. */
  setWindow: (w: W) => void
  /** Current row height (lists: px; grids: rowPx) — a `$state` holder. */
  getRowH: () => number
  setRowH: (h: number) => void
  /** The pure window derivation (computeWindow / computeGridWindow / the
   *  queue's two-section math). Receives the CURRENT row height. */
  compute: (o: { total: number; scrollTop: number; viewportH: number; rowH: number }) => W
  /** Optional DOM measurement: fold one real row height into the EMA (and
   *  for grids, sync the column count) BEFORE the derive, so the first
   *  window is already correct. Return the current value to write nothing. */
  measure?: (el: HTMLElement, currentRowH: number) => number
  /** viewState key + field name for the per-scroll save. */
  viewKey: string
  scrollTopField: string
  /** Test seams (defaults: performance.now / requestAnimationFrame). */
  now?: () => number
  raf?: (cb: () => void) => unknown
}

export interface ScrollWindowMachine {
  /** Wire to the scroller's `onscroll`. Saves the position every event and
   *  derives at the throttle cadence (with the trailing pass). */
  onScroll(): void
  /** Derive immediately — the view's `$effect`, RO callbacks, jump writes. */
  deriveNow(): void
  /** Park a scrollTop for the consume-once restore. */
  armRestore(scrollTop: number): void
  /** Consume the armed restore when the container has content; no-op while
   *  it doesn't (call this inside a reactive effect so pending restores
   *  survive until the list renders). */
  restoreIfReady(): void
  /** Observe the container for viewport resizes and re-derive; returns the
   *  disconnector (a no-op when ResizeObserver is unavailable) — the view's
   *  `$effect` returns it as its own cleanup. */
  observeResize(): () => void
}

export function createScrollWindow<W>(o: ScrollWindowOptions<W>): ScrollWindowMachine {
  const now = o.now ?? (() => performance.now())
  // Node-safe default (F2: a plain import must not throw) — the rederive and
  // trailing passes run on rAF in the browser, setTimeout in tests/Node.
  const raf = o.raf ?? ((cb: () => void) => (typeof requestAnimationFrame === 'undefined' ? setTimeout(cb, 0) : requestAnimationFrame(cb)))

  let lastDeriveAt = 0
  let trailingPending = false
  let pendingRestore: number | null = null
  let rederiveQueued = false

  function deriveNow(): void {
    const el = o.getViewport()
    if (!el) return
    // Measure FIRST so the derive uses the fresh row height (the grids'
    // first window must already carry the real rowPx — a stale-estimate
    // first paint is what fed the 2026-09-28 spacer-oscillator family).
    if (o.measure) {
      const next = o.measure(el, o.getRowH())
      if (next !== o.getRowH()) {
        o.setRowH(next)
        // The spacer pads derive from the row height: once the DOM applies
        // the new pads, THIS window is stale by the pad delta — and with
        // scroll anchoring OFF (app.css) no compensating scroll event fires
        // to re-derive (a clamped landing could settle one band away from
        // its rows — the 2026-09-28 adversarial-review catch). Re-derive on
        // the next frame; it re-queues only while the row height keeps
        // changing, so the EMA's convergence terminates it.
        if (!rederiveQueued) {
          rederiveQueued = true
          raf(() => {
            rederiveQueued = false
            deriveNow()
          })
        }
      }
    }
    const rowH = o.getRowH()
    o.setWindow(
      o.compute({
        total: o.getTotal(),
        scrollTop: el.scrollTop,
        viewportH: el.clientHeight,
        rowH,
      }),
    )
  }

  function onScroll(): void {
    const el = o.getViewport()
    if (!el) return
    saveViewState(o.viewKey, { [o.scrollTopField]: el.scrollTop })
    const t = now()
    if (t - lastDeriveAt < SCROLL_UPDATE_MS) {
      // Throttled: schedule ONE trailing derive so the final scroll event of
      // a gesture can never leave a stale window.
      if (!trailingPending) {
        trailingPending = true
        raf(() => {
          trailingPending = false
          onScroll()
        })
      }
      return
    }
    lastDeriveAt = t
    deriveNow()
  }

  function armRestore(scrollTop: number): void {
    pendingRestore = scrollTop
  }

  function restoreIfReady(): void {
    if (pendingRestore === null) return
    const el = o.getViewport()
    if (!el || o.getTotal() === 0) return
    el.scrollTop = pendingRestore
    pendingRestore = null
    deriveNow()
  }

  function observeResize(): () => void {
    const el = o.getViewport()
    if (!el || typeof ResizeObserver === 'undefined') return () => {}
    const ro = new ResizeObserver(() => deriveNow())
    ro.observe(el)
    return () => ro.disconnect()
  }

  return { onScroll, deriveNow, armRestore, restoreIfReady, observeResize }
}

/**
 * A measure closure for fixed-height lists: fold the FIRST rendered row's
 * offsetHeight into the clamped EMA (`updateRowMetrics`). Shared verbatim by
 * SongsView, the Albums/Artists detail lists, and the Queue's sections —
 * every row is CSS-fixed height, so one representative row per derive is the
 * whole measurement contract.
 */
export function firstRowMeasure(selector: string) {
  return (el: HTMLElement, current: number): number => {
    const first = el.querySelector<HTMLElement>(selector)
    return first && first.offsetHeight > 0 ? updateRowMetrics(current, first.offsetHeight) : current
  }
}
