/**
 * The ONE way a surface becomes context-menu aware (2026-11-04; long-press
 * reach and trailing-click lifetime revised 2026-11-07).
 *
 * Three input paths, all producing the same request:
 *  - DESKTOP: `contextmenu` (right-click, two-finger tap/click on macOS).
 *  - TOUCH: a 500 ms long-press. Safari on iOS does not reliably dispatch
 *    `contextmenu` for non-link elements, so the timer is the portable path;
 *    the CSS class also suppresses the native callout/selection UI.
 *  - KEYBOARD: the ContextMenu key or Shift+F10, anchored to the element's
 *    centre (the browser's own contextmenu event has no useful coordinates).
 *
 * TWO RULES this action owns, both learned from live failures:
 *
 * 1. A press ANYWHERE on the surface opens the menu, including on the surface's
 *    own press target. A row's play `<button>` covers most of the row, so
 *    treating every nested button as "someone else's gesture" turned a long
 *    press into a dead zone over the whole row on a phone — the old e2e passed
 *    only because it dispatched on the wrapper instead of the element a finger
 *    hits. Only a nested control that DECLARES its own gesture opts out with
 *    `data-no-context-menu`: the queue drag handle (its pointerdown starts a
 *    drag) and the mini player's tooltip-bearing transport buttons (their long
 *    press already means "explain this icon"). The opt-out protects the POINTER
 *    gesture the control owns; a right-click has no such conflict, so the
 *    `contextmenu` path still opens the surface menu anywhere on it.
 *
 * 2. The trailing click is swallowed for as long as the GESTURE lasts, not for
 *    a fixed window after the menu opens. The old 700 ms window was measured
 *    from menu-open, so a hold longer than that leaked the release click and
 *    pressed the row behind the menu. `armClickSwallow()` is disarmed by the
 *    gesture's own click or by a NEW pointerdown, so a long hold is covered and
 *    a later tap is never eaten.
 */

import { armClickSwallow } from './clickSwallow'

const DEFAULT_LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 10
/** A native `contextmenu` arriving this soon after the timer opened the menu is
 *  the SAME gesture reported twice (Android Chrome dispatches both), not a
 *  second request — reopening would only re-anchor the menu under the finger. */
const SAME_GESTURE_MS = 700

export interface ContextMenuTriggerOptions {
  onOpen: (position: { x: number; y: number }, trigger: HTMLElement) => void
  longPressMs?: number
  /** A surface with nothing to target (the idle mini player) leaves the native
   *  menu alone instead of swallowing it for an empty menu. */
  disabled?: boolean
}

export function contextMenuTrigger(node: HTMLElement, initial: ContextMenuTriggerOptions) {
  let options = initial
  let pressTimer: number | null = null
  let pressed = false
  let startX = 0
  let startY = 0
  /** When the long press opened the menu — see `SAME_GESTURE_MS`. */
  let openedAt = 0

  // The class suppresses the native callout/selection UI; without a menu to
  // open it would only take behavior away from the surface.
  function syncSurfaceClass(): void {
    if (options.disabled) node.classList.remove('ui-context-menu-surface')
    else node.classList.add('ui-context-menu-surface')
  }
  syncSurfaceClass()

  function clearPressTimer(): void {
    if (pressTimer !== null) {
      window.clearTimeout(pressTimer)
      pressTimer = null
    }
  }

  function openAt(x: number, y: number): void {
    options.onOpen({ x, y }, node)
  }

  function onContextMenu(event: MouseEvent): void {
    if (options.disabled) return
    // A right-click has no gesture conflict with a nested control (a drag
    // handle cannot be right-dragged; a tooltip's long press is touch-only), so
    // the surface keeps its menu anywhere on it. Only the LONG-PRESS path
    // honours `data-no-context-menu` — that is the gesture the control owns.
    // Never let the native menu (or iOS's link/selection callout) take over a
    // surface that has a custom one.
    event.preventDefault()
    event.stopPropagation()
    clearPressTimer()
    pressed = false
    if (Date.now() - openedAt < SAME_GESTURE_MS) return
    const rect = node.getBoundingClientRect()
    // Keyboard-invoked contextmenu events arrive at (0,0): anchor to the
    // element instead of opening in the viewport corner.
    openAt(
      event.clientX > 0 ? event.clientX : rect.left + rect.width / 2,
      event.clientY > 0 ? event.clientY : rect.top + rect.height / 2,
    )
  }

  function onPointerDown(event: PointerEvent): void {
    if (options.disabled) return
    if (event.pointerType === 'mouse') return
    if (event.button !== 0) return
    // Only a control that owns its own pointer gesture keeps it (drag handle,
    // tooltip transport buttons) — see rule 1 in the module doc.
    if ((event.target as Element | null)?.closest('[data-no-context-menu]')) return

    pressed = true
    startX = event.clientX
    startY = event.clientY
    clearPressTimer()
    pressTimer = window.setTimeout(() => {
      pressTimer = null
      if (!pressed) return
      pressed = false
      openedAt = Date.now()
      // Armed while the finger is still down: it survives until this gesture's
      // click, however long the hold lasts (rule 2).
      armClickSwallow()
      // A short haptic nod where the platform exposes the Vibration API (no
      // Capacitor dependency); harmlessly absent elsewhere.
      try {
        navigator.vibrate?.(8)
      } catch {}
      openAt(startX, startY)
    }, options.longPressMs ?? DEFAULT_LONG_PRESS_MS)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pressed) return
    if (Math.abs(event.clientX - startX) > MOVE_TOLERANCE_PX || Math.abs(event.clientY - startY) > MOVE_TOLERANCE_PX) {
      pressed = false
      clearPressTimer()
    }
  }

  function cancelPress(): void {
    pressed = false
    clearPressTimer()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (options.disabled) return
    const isMenuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
    if (!isMenuKey) return
    event.preventDefault()
    const rect = node.getBoundingClientRect()
    openAt(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }

  node.addEventListener('contextmenu', onContextMenu)
  node.addEventListener('pointerdown', onPointerDown)
  node.addEventListener('pointermove', onPointerMove)
  node.addEventListener('pointerup', cancelPress)
  node.addEventListener('pointercancel', cancelPress)
  node.addEventListener('pointerleave', cancelPress)
  node.addEventListener('keydown', onKeyDown)

  return {
    update(next: ContextMenuTriggerOptions) {
      options = next
      syncSurfaceClass()
    },
    destroy() {
      clearPressTimer()
      node.classList.remove('ui-context-menu-surface')
      node.removeEventListener('contextmenu', onContextMenu)
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('pointermove', onPointerMove)
      node.removeEventListener('pointerup', cancelPress)
      node.removeEventListener('pointercancel', cancelPress)
      node.removeEventListener('pointerleave', cancelPress)
      node.removeEventListener('keydown', onKeyDown)
    },
  }
}
