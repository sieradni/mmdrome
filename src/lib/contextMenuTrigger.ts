/**
 * The ONE way a surface becomes context-menu aware (2026-11-04).
 *
 * Three input paths, all producing the same request:
 *  - DESKTOP: `contextmenu` (right-click, two-finger tap/click on macOS).
 *  - TOUCH: a 500 ms long-press. Safari on iOS does not reliably dispatch
 *    `contextmenu` for non-link elements, so the timer is the portable path;
 *    the CSS class also suppresses the native callout/selection UI.
 *  - KEYBOARD: the ContextMenu key or Shift+F10, anchored to the element's
 *    centre (the browser's own contextmenu event has no useful coordinates).
 *
 * A long-press must not also fire the surface's press action (a queue/track
 * row's click plays it, an album cell navigates): the trailing click is
 * swallowed by a one-shot capturing listener.
 */

const DEFAULT_LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 10
/** Covers the synthetic click/contextmenu a touch long-press can emit after
 *  the menu already opened. */
const SUPPRESS_MS = 700

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
  let suppressTrailingClickUntil = 0

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

  function swallowNextClick(): void {
    suppressTrailingClickUntil = Date.now() + SUPPRESS_MS
    const onClick = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      cleanup()
    }
    const cleanup = () => {
      node.removeEventListener('click', onClick, true)
      window.clearTimeout(fallback)
    }
    const fallback = window.setTimeout(cleanup, SUPPRESS_MS)
    node.addEventListener('click', onClick, true)
  }

  function openAt(x: number, y: number): void {
    options.onOpen({ x, y }, node)
  }

  function onContextMenu(event: MouseEvent): void {
    if (options.disabled) return
    // Never let the native menu (or iOS's link/selection callout) take over a
    // surface that has a custom one.
    event.preventDefault()
    event.stopPropagation()
    clearPressTimer()
    pressed = false
    if (Date.now() < suppressTrailingClickUntil) return
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
    // Pressing a nested control (the row's + button, the ⋮, a queue action)
    // belongs to that control, not to the row's menu.
    const interactive = (event.target as Element | null)?.closest(
      'button, a, input, textarea, select, [data-no-context-menu]',
    )
    if (interactive && interactive !== node) return

    pressed = true
    startX = event.clientX
    startY = event.clientY
    clearPressTimer()
    pressTimer = window.setTimeout(() => {
      pressTimer = null
      if (!pressed) return
      pressed = false
      swallowNextClick()
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
