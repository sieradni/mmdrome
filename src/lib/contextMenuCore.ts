/**
 * The custom context menu's PURE core (2026-11-04): the declarative menu model,
 * the per-target builders, the edge-aware placement math and the keyboard
 * navigation rules. No DOM, no stores, no Svelte — pinned by
 * `tests/contextMenuCore.test.ts`.
 *
 * Why a model instead of markup per surface: every surface (library rows,
 * album/artist detail rows and headers, queue rows, album/artist grid cells,
 * the mini player and the expanded Now Playing) opens the SAME primitive menu
 * with a different COMMAND LIST. The builders return commands as
 * plain ids (`play`, `playNext`, `rate:40`, `removeRow`, …); the host maps an id
 * to a side effect. That split is what keeps the menu extensible: adding a
 * command is a builder entry + one host branch, never new markup. The
 * multi-select batch menu reuses it unchanged (`buildSelectionMenu`): the host
 * swaps builders when the targeted row is part of the live selection, so the
 * primitive, placement, focus and dismissal contract stay untouched.
 */

/** Icons rendered by `ContextMenu.svelte`. Paths are 24×24, fill=`currentColor`. */
export type ContextMenuIcon =
  | 'play'
  | 'playNext'
  | 'queue'
  | 'heart'
  | 'star'
  | 'details'
  | 'remove'
  | 'moveNext'
  | 'moveEnd'
  | 'notNow'
  | 'album'
  | 'artist'
  | 'select'
  | 'refresh'
  | 'convertUp'

export const CONTEXT_MENU_ICONS: Record<ContextMenuIcon, string> = {
  play: 'M8 5v14l11-7z',
  playNext: 'M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z',
  queue: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  heart:
    'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  star: 'M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26Z',
  details:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  remove:
    'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  moveNext: 'M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z',
  moveEnd: 'M7 13l5 5 5-5-1.41-1.41L13 14.17V5h-2v9.17l-2.59-2.58L7 13z',
  notNow:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z',
  album: 'M12 3v10.55A4 4 0 1014 17V7h4V3h-6z',
  artist:
    'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  select:
    'M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  refresh:
    'M17.65 6.35A7.95 7.95 0 0012 4a8 8 0 100 16 8 8 0 007.73-6h-2.08A6 6 0 1112 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  convertUp: 'M12 3L7.41 7.59 8.83 9 11 6.83V15h2V6.83L15.17 9l1.41-1.41L12 3zM5 19h14v2H5z',
}

/** A non-interactive heading (the target's title/artist). Never focusable. */
export interface ContextMenuLabel {
  type: 'label'
  id: string
  label: string
  detail?: string
}

export interface ContextMenuSeparator {
  type: 'separator'
  id: string
}

export interface ContextMenuAction {
  type: 'action'
  id: string
  label: string
  icon?: ContextMenuIcon
  /** Destructive styling (remove). */
  danger?: boolean
  disabled?: boolean
  /** Present = a toggle (`menuitemcheckbox`); `aria-checked` mirrors it. */
  checked?: boolean
  /** Screen-reader name when the visible label is symbol-like. */
  ariaLabel?: string
}

/** One level of nesting is intentional: it covers Rating today and future
 *  "Add to playlist"-style groupings without an unbounded menu tree. */
export interface ContextMenuSubmenu {
  type: 'submenu'
  id: string
  label: string
  icon?: ContextMenuIcon
  items: ContextMenuEntry[]
  disabled?: boolean
}

export type ContextMenuEntry =
  | ContextMenuLabel
  | ContextMenuSeparator
  | ContextMenuAction
  | ContextMenuSubmenu

/** The rating scale is the app's 0–100-in-tens model (0 = unrated). */
export const CONTEXT_MENU_RATING_STEPS = [0, 20, 40, 60, 80, 100] as const

export function ratingLabel(value: number): string {
  if (value <= 0) return 'No rating'
  const stars = Math.round(value / 20)
  return stars === 1 ? '1 star' : `${stars} stars`
}

export function buildRatingMenu(rating: number): ContextMenuEntry[] {
  return CONTEXT_MENU_RATING_STEPS.map((value) => ({
    type: 'action' as const,
    id: `rate:${value}`,
    label: ratingLabel(value),
    checked: rating === value,
    ariaLabel: value === 0 ? 'Clear rating' : `Set rating to ${value}`,
  }))
}

export interface TrackMenuContext {
  title: string
  subtitle?: string
  /** This track is the CURRENT track and playback has not stopped. */
  isAudible: boolean
  isPlaying: boolean
  loved: boolean
  rating: number
  /**
   * Present when the menu was opened on a QUEUE row. Queue rows own row-scoped
   * commands (move/remove) that a library row must not offer — with duplicate
   * occurrences an id cannot name a row, so the commands are only meaningful
   * where the occurrence is known.
   */
  queueRow?: 'user' | 'auto'
  canShowDetails: boolean
  /** Offer the multi-select entry point (every row surface has one; a transient
   *  push-confirm row deliberately does not). */
  showSelect?: boolean
}

/**
 * The single track menu builder. The play label is honest about what pressing
 * the audible row does (restart/resume) — the same fact the queue row's press
 * encodes.
 */
export function buildTrackMenu(ctx: TrackMenuContext): ContextMenuEntry[] {
  const playLabel = ctx.isAudible ? (ctx.isPlaying ? 'Restart' : 'Resume') : 'Play now'
  const entries: ContextMenuEntry[] = [
    { type: 'label', id: 'menu-context', label: ctx.title, detail: ctx.subtitle },
    { type: 'action', id: 'play', label: playLabel, icon: 'play' },
  ]

  if (ctx.showSelect) {
    entries.push({ type: 'action', id: 'select', label: 'Select', icon: 'select' })
  }

  if (ctx.queueRow === 'user') {
    entries.push(
      { type: 'separator', id: 'menu-sep-queue' },
      { type: 'action', id: 'moveNext', label: 'Move to next', icon: 'moveNext' },
      { type: 'action', id: 'moveEnd', label: 'Move to end', icon: 'moveEnd' },
      { type: 'action', id: 'removeRow', label: 'Remove from queue', icon: 'remove', danger: true },
    )
  } else if (ctx.queueRow === 'auto') {
    entries.push(
      { type: 'separator', id: 'menu-sep-queue' },
      { type: 'action', id: 'moveNext', label: 'Play next', icon: 'moveNext' },
      { type: 'action', id: 'addToEnd', label: 'Add to end of queue', icon: 'queue' },
      {
        type: 'action',
        id: 'convertUpTo',
        label: 'Convert up to here',
        icon: 'convertUp',
        ariaLabel: 'Convert every suggestion up to and including this one into the user queue',
      },
      { type: 'action', id: 'notNow', label: 'Not now', icon: 'notNow' },
    )
  } else {
    entries.push(
      { type: 'action', id: 'playNext', label: 'Play next', icon: 'playNext' },
      { type: 'action', id: 'addToQueue', label: 'Add to queue', icon: 'queue' },
    )
  }

  entries.push(
    { type: 'separator', id: 'menu-sep-feedback' },
    {
      type: 'action',
      id: 'love',
      label: 'Loved',
      icon: 'heart',
      checked: ctx.loved,
      ariaLabel: ctx.loved ? 'Remove from loved' : 'Mark as loved',
    },
    { type: 'submenu', id: 'rating', label: 'Rating', icon: 'star', items: buildRatingMenu(ctx.rating) },
  )

  if (ctx.canShowDetails) {
    entries.push(
      { type: 'separator', id: 'menu-sep-details' },
      { type: 'action', id: 'details', label: 'Details', icon: 'details' },
    )
  }
  return entries
}

export interface GroupMenuContext {
  kind: 'album' | 'artist'
  name: string
  trackCount: number
}

/**
 * Album/artist grid menus. The commands reuse the track menu's ids (`play`,
 * `playNext`, `addToQueue`) because the meaning is identical — the host applies
 * them to the whole group — which keeps one command vocabulary for single and
 * future multi-item targets.
 */
export function buildGroupMenu(ctx: GroupMenuContext): ContextMenuEntry[] {
  const noun = ctx.kind === 'album' ? 'album' : 'artist'
  return [
    {
      type: 'label',
      id: 'menu-context',
      label: ctx.name,
      detail: `${ctx.trackCount} ${ctx.trackCount === 1 ? 'track' : 'tracks'}`,
    },
    { type: 'action', id: 'play', label: `Play ${noun}`, icon: ctx.kind === 'album' ? 'album' : 'artist' },
    { type: 'action', id: 'playNext', label: 'Play next', icon: 'playNext' },
    { type: 'action', id: 'addToQueue', label: 'Add to queue', icon: 'queue' },
  ]
}

/**
 * The batch menu for a multi-select (2026-11-04). One builder for BOTH
 * surfaces, because the command ids are the same concept and the host resolves
 * them against the surface that owns the selection — a library selection is a
 * list of track ids, a queue selection a list of occurrences.
 */
export interface SelectionMenuContext {
  surface: 'library' | 'queue'
  count: number
  /** Queue selections only: at least one selected row may be removed (the
   *  audible row never can — deleting it would strand playback). */
  canRemove: boolean
  /** Queue selections only: every selected row already sits in the user
   *  queue, so "Add to user queue" would be a no-op. */
  allInUserQueue: boolean
}

export const SELECTION_MENU_RATING_PREFIX = 'selectionRate'

/** Rating choices for a multi-selection: no checked mark, because the rows may
 *  hold different values (a single "current" star would lie about the rest). */
export function buildBatchRatingMenu(): ContextMenuEntry[] {
  return CONTEXT_MENU_RATING_STEPS.map((value) => ({
    type: 'action' as const,
    id: `${SELECTION_MENU_RATING_PREFIX}:${value}`,
    label: value === 0 ? 'Clear rating' : ratingLabel(value),
    ariaLabel:
      value === 0 ? 'Clear the rating of every selected song' : `Rate every selected song ${value}`,
  }))
}

export function buildSelectionMenu(ctx: SelectionMenuContext): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [
    {
      type: 'label',
      id: 'menu-context',
      label: `${ctx.count} selected`,
      detail: ctx.surface === 'queue' ? 'Queue rows' : 'Library songs',
    },
    // "Play next" only means something for a library selection: a queue row is
    // already queued, and moving a SET is a reorder the queue surfaces spell
    // out per row. Offering a dead command would be worse than omitting it.
    ...(ctx.surface === 'library'
      ? ([{ type: 'action', id: 'selectionPlayNext', label: 'Play next', icon: 'playNext' }] satisfies ContextMenuEntry[])
      : []),
    {
      type: 'action',
      id: 'selectionAddToQueue',
      label: ctx.surface === 'queue' ? 'Add to user queue' : 'Add to queue',
      icon: 'queue',
      disabled: ctx.surface === 'queue' && ctx.allInUserQueue,
    },
    {
      type: 'action',
      id: 'selectionSetUserQueue',
      label: 'Set as user queue',
      icon: 'queue',
      ariaLabel: 'Replace the user queue with the selected songs',
    },
    { type: 'separator', id: 'menu-sep-feedback' },
    { type: 'action', id: 'selectionLove', label: 'Loved', icon: 'heart' },
    {
      type: 'submenu',
      id: 'selectionRating',
      label: 'Rating',
      icon: 'star',
      items: buildBatchRatingMenu(),
    },
  ]

  if (ctx.surface === 'queue' && ctx.canRemove) {
    entries.push(
      { type: 'separator', id: 'menu-sep-remove' },
      { type: 'action', id: 'selectionRemove', label: 'Remove from queue', icon: 'remove', danger: true },
    )
  }

  entries.push(
    { type: 'separator', id: 'menu-sep-selection' },
    { type: 'action', id: 'clearSelection', label: 'Clear selection', icon: 'remove' },
  )
  return entries
}

/** Ids a keyboard user can land on, in visual order (labels/separators skipped,
 *  disabled entries skipped, submenu parents included). */
export function menuNavigableIds(entries: readonly ContextMenuEntry[]): string[] {
  const ids: string[] = []
  for (const entry of entries) {
    if (entry.type === 'action' && !entry.disabled) ids.push(entry.id)
    else if (entry.type === 'submenu' && !entry.disabled) ids.push(entry.id)
  }
  return ids
}

/** Next/previous focus id with wrap-around. `currentId` need not exist (a
 *  submenu switch), in which case the edge of the new list is chosen. */
export function stepMenuId(
  ids: readonly string[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (ids.length === 0) return null
  const current = currentId ? ids.indexOf(currentId) : -1
  if (current < 0) return direction > 0 ? ids[0] : ids[ids.length - 1]
  return ids[(current + direction + ids.length) % ids.length]
}

export interface ContextMenuPlacementInput {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  /** Keeps the menu clear of the viewport edges (and the iOS safe area is
   *  handled by the host's padding, so a uniform margin is equivalent). */
  margin?: number
  /** Distance from the pointer/focus point to the menu edge. */
  gap?: number
}

export interface ContextMenuPlacement {
  left: number
  top: number
  flippedX: boolean
  flippedY: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Pointer-anchored placement: open down-right of the pointer; when that would
 * overflow, FLIP to the other side of the pointer (the platform convention)
 * and only then clamp to the viewport. Works the same for a keyboard-invoked
 * menu anchored to an element's centre and for a long-press touch point.
 */
export function placeContextMenu(input: ContextMenuPlacementInput): ContextMenuPlacement {
  const margin = input.margin ?? 8
  const gap = input.gap ?? 0
  const maxLeft = Math.max(margin, input.viewportWidth - margin - input.width)
  const maxTop = Math.max(margin, input.viewportHeight - margin - input.height)

  let left = input.x
  let top = input.y + gap
  const flippedX = left > maxLeft
  if (flippedX) left = input.x - input.width
  const flippedY = top > maxTop
  if (flippedY) top = input.y - gap - input.height

  return {
    left: clamp(left, margin, maxLeft),
    top: clamp(top, margin, maxTop),
    flippedX,
    flippedY,
  }
}

export interface SubmenuPlacementInput {
  parentLeft: number
  parentTop: number
  parentWidth: number
  parentHeight: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  margin?: number
  overlap?: number
}

export interface SubmenuPlacement {
  left: number
  top: number
  /** True when the submenu opened to the LEFT of its parent (no room right). */
  flipped: boolean
}

/**
 * Submenu placement: beside the parent row (right, overlapping it slightly so
 * the two panes read as one surface), flipping left at the viewport edge, then
 * vertically clamped so a long list never runs off-screen.
 */
export function placeSubmenu(input: SubmenuPlacementInput): SubmenuPlacement {
  const margin = input.margin ?? 8
  const overlap = input.overlap ?? 4
  const maxLeft = Math.max(margin, input.viewportWidth - margin - input.width)
  const maxTop = Math.max(margin, input.viewportHeight - margin - input.height)

  let left = input.parentLeft + input.parentWidth - overlap
  let flipped = false
  if (left > maxLeft) {
    left = input.parentLeft - input.width + overlap
    flipped = true
  }
  return {
    left: clamp(left, margin, maxLeft),
    top: clamp(input.parentTop - overlap, margin, maxTop),
    flipped,
  }
}
