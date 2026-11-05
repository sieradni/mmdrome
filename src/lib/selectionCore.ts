/**
 * The MULTI-SELECT model's pure core (2026-11-04).
 *
 * A selection is surface-scoped (`library` | `queue`) because the two surfaces
 * name rows differently: a library row is a `trackId`, a queue row is an
 * OCCURRENCE (`user:<id>#<n>`) — an id names several queue rows once duplicates
 * exist, so the queue selection must carry entry ids, exactly like the drag
 * engine and the context menu do.
 *
 * The model is kept free of DOM/stores so the interaction rules are unit
 * verifiable (`tests/selectionCore.test.ts`). The rules:
 *  - SHIFT extends the selection from the LAST SELECTED key to the clicked
 *    key, inside the surface's own ORDER (what the user is looking at,
 *    including a virtual window — the range is computed from data, never from
 *    mounted rows) and NEVER drops prior picks: selections accumulate, so
 *    Shift-picking 1 → 3 → 5 keeps every row in between. The clicked key
 *    becomes the new base for the next Shift pick;
 *  - CTRL/CMD toggles one key and moves the anchor;
 *  - a plain press in selection mode toggles (the touch path — there is no
 *    modifier key on a phone);
 *  - an empty selection leaves selection mode entirely, so no surface can get
 *    stuck in a mode with nothing selected;
 *  - keys that leave the surface's order are PRUNED (`setOrder`), so a
 *    removed/reindexed row can never stay selected invisibly.
 */

export type SelectionSurface = 'library' | 'queue'

export interface SelectionState {
  /** Which surface owns the keys (null = nothing selected). */
  surface: SelectionSurface | null
  /** Selected keys, in the surface's own order (a Shift union stays
   *  contiguous in that order; toggles append). */
  keys: string[]
  /** Range origin for Shift; the last picked/selected key. */
  anchor: string | null
  /** Explicit selection mode: the next row press toggles instead of acting. */
  mode: boolean
  /** Each surface's current ordered key list (range + select-all domain). */
  orders: Record<SelectionSurface, string[]>
}

export interface SelectionClickModifiers {
  shift?: boolean
  /** Ctrl/Cmd — toggle a single key. */
  toggle?: boolean
}

export function emptySelection(): SelectionState {
  return { surface: null, keys: [], anchor: null, mode: false, orders: { library: [], queue: [] } }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i])
}

/** Applies a resolved key set, dropping the selection entirely when empty. */
function withKeys(
  state: SelectionState,
  surface: SelectionSurface,
  keys: string[],
  anchor: string | null,
): SelectionState {
  if (keys.length === 0) {
    return { ...state, surface: null, keys: [], anchor: null, mode: false }
  }
  return {
    ...state,
    surface,
    keys,
    anchor: anchor !== null && keys.includes(anchor) ? anchor : keys[keys.length - 1],
    mode: true,
  }
}

/** Inclusive range between two keys, in the surface's own order. A key outside
 *  the order (a stale click) degrades to just that key — never a wrong range. */
export function rangeKeys(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from)
  const b = order.indexOf(to)
  if (a < 0 || b < 0) return [to]
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return order.slice(lo, hi + 1)
}

/**
 * Records a surface's ordered key list and prunes selections it no longer
 * contains (a removed queue row, a filtered-out library row). Returns the SAME
 * object when nothing changed so the store write is a real no-op.
 */
export function setSelectionOrder(
  state: SelectionState,
  surface: SelectionSurface,
  order: readonly string[],
): SelectionState {
  if (sameOrder(state.orders[surface], order)) return state
  const orders = { ...state.orders, [surface]: [...order] }
  if (state.surface !== surface) return { ...state, orders }
  const keys = state.keys.filter((key) => order.includes(key))
  if (keys.length === state.keys.length) return { ...state, orders }
  return withKeys({ ...state, orders }, surface, keys, state.anchor)
}

/** Starts a selection on `surface` with exactly `key`. */
export function beginSelection(
  state: SelectionState,
  surface: SelectionSurface,
  key: string,
): SelectionState {
  return withKeys(state, surface, [key], key)
}

/**
 * The ONE click resolver for a selectable row. `modifiers.shift` chains a range
 * onto the existing selection from the last selected key (prior picks are
 * preserved — see the module header), `modifiers.toggle` (Ctrl/Cmd) toggles one
 * key, and a bare click in selection mode toggles too — the caller decides
 * whether a bare click is a selection gesture at all (outside selection mode a
 * row press keeps its own meaning).
 */
export function planSelectionClick(
  state: SelectionState,
  surface: SelectionSurface,
  key: string,
  modifiers: SelectionClickModifiers = {},
): SelectionState {
  const order = state.orders[surface]
  const sameSurface = state.surface === surface
  const current = sameSurface ? state.keys : []
  const anchor = sameSurface ? state.anchor : null

  if (modifiers.shift) {
    const base = anchor ?? key
    const range = rangeKeys(order, base, key)
    // Shift ADDS to the existing selection, never replacing it: the range is
    // measured from the last picked key, and every prior pick survives. That
    // is the chaining behaviour (pick 1 → Shift-pick 3 → Shift-pick 5 keeps
    // all five) and it makes Ctrl/Cmd + Shift identical to Shift — both union.
    // The union is emitted in the surface's own ORDER, not pick order: the
    // ordered set is what range consumers (the batch verbs, the bar count)
    // expect, and it keeps the range contiguous even when the picks were not.
    const union = new Set([...current, ...range])
    const keys = order.filter((k) => union.has(k))
    // A key outside the order (a stale click) degrades to just itself, exactly
    // as rangeKeys always has — never drop the click.
    if (!keys.includes(key)) keys.push(key)
    return withKeys(state, surface, keys, key)
  }

  const keys = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
  return withKeys(state, surface, keys, key)
}

/** Selects the whole visible order of a surface. */
export function planSelectAll(state: SelectionState, surface: SelectionSurface): SelectionState {
  const order = state.orders[surface]
  if (order.length === 0) return state
  return withKeys(state, surface, [...order], order[0])
}

/** Exits selection mode (no surface, no keys). Orders are kept: they describe
 *  the surface, not the selection. */
export function clearedSelection(state: SelectionState): SelectionState {
  if (state.surface === null && state.keys.length === 0) return state
  return { ...state, surface: null, keys: [], anchor: null, mode: false }
}

export function isSelected(state: SelectionState, surface: SelectionSurface, key: string): boolean {
  return state.surface === surface && state.keys.includes(key)
}

/** True when the surface is in selection mode with at least one key. */
export function selectionActive(state: SelectionState, surface: SelectionSurface): boolean {
  return state.mode && state.surface === surface && state.keys.length > 0
}

/** Count label shared by the bar and the batch menu ("3 songs", "1 item"). */
export function selectionLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
