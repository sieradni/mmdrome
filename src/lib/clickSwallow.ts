/**
 * Swallows the ONE click a gesture leaves behind (2026-11-07).
 *
 * Two places SPEND a gesture instead of letting it activate what is under it:
 *  - a long press that OPENS a context menu — the finger's release still emits
 *    a click, and that click must not press the row behind the open menu;
 *  - an outside press that DISMISSES a context menu — the press means "cancel",
 *    so it must not also run the control it landed on.
 *
 * Both are the same problem (a click belonging to a gesture the app has already
 * consumed), so they share ONE primitive instead of two hand-rolled capturing
 * listeners that drift apart. The listener is page-wide because the gesture's
 * click can land anywhere: a finger that slides off the row before release, or
 * any control under an outside press.
 *
 * Lifetime is GESTURE-driven, never time-driven: the swallow stays armed until
 * the gesture's click arrives, and is disarmed by a NEW pointerdown (which
 * starts a gesture that owns its own click). That is what makes an arbitrarily
 * long hold safe — the old fixed 700 ms window let a 2 s press open the menu
 * and then press the row on release.
 */

/** Only a leak guard: a click is always preceded by its gesture's pointerdown,
 *  which disarms. 60 s covers a hold nobody would actually make. */
const SAFETY_MS = 60_000

let armed = false
let armedAt = 0
let safety: ReturnType<typeof setTimeout> | null = null

function disarm(): void {
  if (!armed) return
  armed = false
  window.removeEventListener('click', onClick, true)
  window.removeEventListener('pointerdown', onPointerDown, true)
  if (safety !== null) {
    clearTimeout(safety)
    safety = null
  }
}

function onClick(event: MouseEvent): void {
  if (!armed) return
  // `detail === 0` is a keyboard/AT activation or a programmatic `.click()` —
  // a separate intent that no pointer gesture consumed, so it is never eaten.
  // Not a guess about mobile: UI Events defines click `detail` as the click
  // count, and WebKit reports 0 only for keyboard invocation (bug 281430), so
  // a real tap (iOS included) can never look programmatic.
  if (event.detail === 0) {
    disarm()
    return
  }
  event.preventDefault()
  event.stopPropagation()
  disarm()
}

/** A new gesture owns its own click: disarm so a later legitimate tap is not
 *  swallowed. The event that armed the swallow cannot land here (the listener
 *  is added while that event is already being dispatched), and the timestamp
 *  check keeps it that way regardless of dispatch details. */
function onPointerDown(event: PointerEvent): void {
  if (!armed) return
  if (event.isPrimary === false) return
  if (event.timeStamp <= armedAt) return
  disarm()
}

/**
 * Arms the swallow for the CURRENT gesture. Idempotent, so a path that both
 * opens a menu and dismisses another one cannot arm it twice.
 */
export function armClickSwallow(): void {
  if (armed || typeof window === 'undefined') return
  armed = true
  armedAt = performance.now()
  window.addEventListener('click', onClick, true)
  window.addEventListener('pointerdown', onPointerDown, true)
  safety = setTimeout(disarm, SAFETY_MS)
}
