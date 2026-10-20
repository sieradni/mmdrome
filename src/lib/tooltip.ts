/**
 * Lightweight, zero-wrapper tooltip action (`use:tooltip`) for icon-only
 * controls (Phase 1C of docs/plans/2026-10-18-holistic-polish-and-roadmap.md).
 *
 * Reads the explicit string parameter or falls back to `node.getAttribute('aria-label')`.
 *
 * Behavior:
 *  - Desktop pointer (`pointerType === 'mouse'`): shows after 400ms hover.
 *  - Keyboard (`focus-visible`): shows after 300ms focus.
 *  - Touch (`pointerType === 'touch'`): 450ms long-press shows the tooltip for
 *    1.6s and suppresses the trailing synthetic click so inspecting an icon
 *    button on a phone doesn't trigger its action.
 *  - Only one singleton tooltip DOM node exists on `document.body` while active.
 */

const HOVER_DELAY_MS = 400
const LONG_PRESS_MS = 450
const TOUCH_HOLD_VISIBLE_MS = 1600
const VIEWPORT_PAD_PX = 8

let tooltipEl: HTMLDivElement | null = null
let activeOwner: HTMLElement | null = null
let touchHideTimer: ReturnType<typeof setTimeout> | null = null

function ensureTooltipEl(): HTMLDivElement {
  if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl
  const el = document.createElement('div')
  el.setAttribute('role', 'tooltip')
  el.setAttribute('data-app-tooltip', '')
  el.className =
    'pointer-events-none fixed z-[80] max-w-xs truncate rounded-md border border-white/15 bg-surface-raised px-2.5 py-1 text-xs font-medium text-primary '
  el.style.opacity = '0'
  document.body.appendChild(el)
  tooltipEl = el
  return el
}

function positionTooltip(target: HTMLElement, el: HTMLDivElement): void {
  const rect = target.getBoundingClientRect()
  const tipRect = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  let top = rect.top - tipRect.height - 6
  if (top < VIEWPORT_PAD_PX) {
    top = Math.min(vh - tipRect.height - VIEWPORT_PAD_PX, rect.bottom + 6)
  }

  let left = rect.left + rect.width / 2 - tipRect.width / 2
  left = Math.max(VIEWPORT_PAD_PX, Math.min(vw - tipRect.width - VIEWPORT_PAD_PX, left))

  el.style.top = `${Math.round(top)}px`
  el.style.left = `${Math.round(left)}px`
}

function showTooltipFor(target: HTMLElement, text: string): void {
  if (typeof document === 'undefined' || !text) return
  if (touchHideTimer) {
    clearTimeout(touchHideTimer)
    touchHideTimer = null
  }
  activeOwner = target
  const el = ensureTooltipEl()
  el.textContent = text
  el.style.opacity = '1'
  positionTooltip(target, el)
}

export function hideTooltip(owner?: HTMLElement): void {
  if (owner && activeOwner !== owner) return
  if (touchHideTimer) {
    clearTimeout(touchHideTimer)
    touchHideTimer = null
  }
  activeOwner = null
  if (tooltipEl) {
    tooltipEl.remove()
    tooltipEl = null
  }
}

export function tooltip(node: HTMLElement, customText?: string) {
  let labelOverride = customText
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let suppressNextClick = false

  function resolveLabel(): string {
    return (labelOverride ?? node.getAttribute('aria-label') ?? '').trim()
  }

  function clearTimers() {
    if (hoverTimer) {
      clearTimeout(hoverTimer)
      hoverTimer = null
    }
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }

  function onPointerEnter(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return
    clearTimers()
    hoverTimer = setTimeout(() => {
      const text = resolveLabel()
      if (text) showTooltipFor(node, text)
    }, HOVER_DELAY_MS)
  }

  function onPointerLeave() {
    clearTimers()
    hideTooltip(node)
  }

  let pressX = 0
  let pressY = 0

  function onPointerMove(e: PointerEvent) {
    if (e.pointerType !== 'mouse' && Math.hypot(e.clientX - pressX, e.clientY - pressY) > 8) {
      onPointerCancel()
    }
  }

  function onPointerDown(e: PointerEvent) {
    pressX = e.clientX
    pressY = e.clientY
    if (e.pointerType === 'mouse') {
      clearTimers()
      hideTooltip(node)
      return
    }
    clearTimers()
    suppressNextClick = false
    pressTimer = setTimeout(() => {
      pressTimer = null
      const text = resolveLabel()
      if (!text) return
      suppressNextClick = true
      showTooltipFor(node, text)
      touchHideTimer = setTimeout(() => {
        hideTooltip(node)
      }, TOUCH_HOLD_VISIBLE_MS)
    }, LONG_PRESS_MS)
  }

  function onPointerCancel() {
    clearTimers()
    suppressNextClick = false
    hideTooltip(node)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      clearTimers()
      hideTooltip(node)
    }
  }

  function onPointerUpOrCancel() {
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
  }

  function onClickCapture(e: MouseEvent) {
    if (suppressNextClick) {
      suppressNextClick = false
      e.preventDefault()
      e.stopPropagation()
      return
    }
    hideTooltip(node)
  }

  function onFocus() {
    try {
      if (!node.matches(':focus-visible')) return
    } catch {
      return
    }
    clearTimers()
    hoverTimer = setTimeout(() => {
      const text = resolveLabel()
      if (text) showTooltipFor(node, text)
    }, 300)
  }

  function onBlur() {
    clearTimers()
    hideTooltip(node)
  }

  node.addEventListener('pointerenter', onPointerEnter)
  node.addEventListener('pointerleave', onPointerLeave)
  node.addEventListener('pointerdown', onPointerDown)
  node.addEventListener('pointerup', onPointerUpOrCancel)
  node.addEventListener('pointercancel', onPointerCancel)
  node.addEventListener('keydown', onKeyDown)
  // A long press that becomes a scroll must not inspect or activate a button.
  node.addEventListener('pointermove', onPointerMove)
  node.addEventListener('click', onClickCapture, true)
  node.addEventListener('focus', onFocus)
  node.addEventListener('blur', onBlur)

  return {
    update(newText?: string) {
      labelOverride = newText
      if (activeOwner === node) {
        const text = resolveLabel()
        if (text && tooltipEl) {
          tooltipEl.textContent = text
          positionTooltip(node, tooltipEl)
        } else {
          hideTooltip(node)
        }
      }
    },
    destroy() {
      clearTimers()
      hideTooltip(node)
      node.removeEventListener('pointerenter', onPointerEnter)
      node.removeEventListener('pointerleave', onPointerLeave)
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('pointerup', onPointerUpOrCancel)
      node.removeEventListener('pointercancel', onPointerCancel)
      node.removeEventListener('pointermove', onPointerMove)
      node.removeEventListener('keydown', onKeyDown)
      node.removeEventListener('click', onClickCapture, true)
      node.removeEventListener('focus', onFocus)
      node.removeEventListener('blur', onBlur)
    },
  }
}
