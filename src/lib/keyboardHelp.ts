/**
 * The ONE keyboard gate for the shortcuts help sheet.
 *
 * `?` is the conventional "show shortcuts" key: on US layouts it IS Shift+/,
 * so `e.key === '?'` covers the shifted path without ever requiring a
 * shift-free '/' (which would hijack the plain '/' many apps reserve for
 * search). The '/' + shift clause exists for layouts where Shift+/ yields
 * '/' instead of '?'.
 *
 * DOM-free (type refs only) so Node tests pin the matrix — F2.
 */

export const SHORTCUTS_HELP_SHORTCUT = '?'

/** True when the event target is, or sits inside, a text-editing surface —
 *  typing `?` into search or a filter must never open the sheet. */
export function isHelperInput(target: HTMLElement | null): boolean {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = target.tagName?.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (typeof target.closest === 'function') {
    return target.closest('input, textarea, select, [contenteditable]') != null
  }
  return false
}

export function shouldOpenShortcuts(e: KeyboardEvent, target: HTMLElement | null): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  if (isHelperInput(target)) return false
  return e.key === SHORTCUTS_HELP_SHORTCUT || (e.key === '/' && e.shiftKey)
}
