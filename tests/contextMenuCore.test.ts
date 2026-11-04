import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_MENU_RATING_STEPS,
  SELECTION_MENU_RATING_PREFIX,
  buildBatchRatingMenu,
  buildGroupMenu,
  buildRatingMenu,
  buildSelectionMenu,
  buildTrackMenu,
  menuNavigableIds,
  placeContextMenu,
  placeSubmenu,
  ratingLabel,
  stepMenuId,
  type ContextMenuEntry,
} from '../src/lib/contextMenuCore'

// The custom context menu's pure core (2026-11-04). Every surface builds its
// commands through these builders, and the primitive's placement/navigation
// rules live here too — so this file is the single pin for: command shape per
// target (library row / user queue row / auto queue row / album / artist),
// honest play labels, the rating scale, edge-aware placement (flip then clamp),
// submenu placement, and keyboard traversal.

function ids(entries: readonly ContextMenuEntry[]): string[] {
  return entries.map((entry) => entry.id)
}

function actions(entries: readonly ContextMenuEntry[]) {
  return entries.filter((entry) => entry.type === 'action')
}

const baseTrack = {
  title: 'Midnight Drive',
  subtitle: 'The Orbitals',
  isAudible: false,
  isPlaying: false,
  loved: false,
  rating: 0,
  canShowDetails: true,
}

test('library track menu: play semantics, queue insertion, feedback, details', () => {
  const menu = buildTrackMenu(baseTrack)
  assert.deepEqual(ids(menu), [
    'menu-context',
    'play',
    'playNext',
    'addToQueue',
    'menu-sep-feedback',
    'love',
    'rating',
    'menu-sep-details',
    'details',
  ])
  assert.equal(actions(menu)[0].label, 'Play now')
  assert.equal(actions(menu)[1].label, 'Play next')
  assert.equal(actions(menu)[2].label, 'Add to queue')

  // The heading is non-interactive and carries identity, not a command.
  const heading = menu[0]
  assert.equal(heading.type, 'label')
  assert.equal(heading.type === 'label' && heading.label, 'Midnight Drive')

  // A toggle's checked state mirrors the store at build time.
  const love = menu.find((entry) => entry.type === 'action' && entry.id === 'love')
  assert.equal(love?.type === 'action' && love.checked, false)
  assert.equal(love?.type === 'action' && love.ariaLabel, 'Mark as loved')

  // Details is optional: a surface with no details dialog must not offer it.
  const noDetails = buildTrackMenu({ ...baseTrack, canShowDetails: false })
  assert.equal(ids(noDetails).includes('details'), false)
  assert.equal(ids(noDetails).includes('menu-sep-details'), false)
})

test('the play label is honest about the audible row (restart vs resume)', () => {
  const playing = buildTrackMenu({ ...baseTrack, isAudible: true, isPlaying: true })
  assert.equal(actions(playing)[0].label, 'Restart')
  const paused = buildTrackMenu({ ...baseTrack, isAudible: true, isPlaying: false })
  assert.equal(actions(paused)[0].label, 'Resume')
})

test('loved state flips the toggle and its accessible name', () => {
  const menu = buildTrackMenu({ ...baseTrack, loved: true, rating: 80 })
  const love = menu.find((entry) => entry.type === 'action' && entry.id === 'love')
  assert.equal(love?.type === 'action' && love.checked, true)
  assert.equal(love?.type === 'action' && love.ariaLabel, 'Remove from loved')

  const rating = menu.find((entry) => entry.type === 'submenu' && entry.id === 'rating')
  assert.equal(rating?.type, 'submenu')
  if (rating?.type !== 'submenu') return
  const checked = rating.items.filter((item) => item.type === 'action' && item.checked)
  assert.deepEqual(checked.map((item) => item.id), ['rate:80'])
})

test('user queue row: row-scoped moves and a destructive remove, no library insert', () => {
  const menu = buildTrackMenu({ ...baseTrack, queueRow: 'user' })
  const menuIds = ids(menu)
  assert.equal(menuIds.includes('moveNext'), true)
  assert.equal(menuIds.includes('moveEnd'), true)
  assert.equal(menuIds.includes('removeRow'), true)
  assert.equal(menuIds.includes('playNext'), false)
  assert.equal(menuIds.includes('addToQueue'), false)

  const remove = menu.find((entry) => entry.type === 'action' && entry.id === 'removeRow')
  assert.equal(remove?.type === 'action' && remove.danger, true)
})

test('auto queue row: promote / play next / dismiss suggestion, never a remove', () => {
  const menu = buildTrackMenu({ ...baseTrack, queueRow: 'auto' })
  const menuIds = ids(menu)
  assert.equal(menuIds.includes('moveNext'), true)
  assert.equal(menuIds.includes('addToEnd'), true)
  assert.equal(menuIds.includes('notNow'), true)
  assert.equal(menuIds.includes('removeRow'), false)
  const moveNext = menu.find((entry) => entry.type === 'action' && entry.id === 'moveNext')
  assert.equal(moveNext?.type === 'action' && moveNext.label, 'Play next')
})

test('rating menu covers the full 0–100-in-tens scale and marks the current value', () => {
  assert.deepEqual(CONTEXT_MENU_RATING_STEPS, [0, 20, 40, 60, 80, 100])
  assert.equal(ratingLabel(0), 'No rating')
  assert.equal(ratingLabel(20), '1 star')
  assert.equal(ratingLabel(100), '5 stars')

  const menu = buildRatingMenu(40)
  assert.deepEqual(ids(menu), ['rate:0', 'rate:20', 'rate:40', 'rate:60', 'rate:80', 'rate:100'])
  const checked = menu.filter((entry) => entry.type === 'action' && entry.checked)
  assert.deepEqual(checked.map((entry) => entry.id), ['rate:40'])
})

test('every row surface offers the multi-select entry point; transient rows do not', () => {
  const library = buildTrackMenu({ ...baseTrack, showSelect: true })
  assert.deepEqual(ids(library).slice(0, 3), ['menu-context', 'play', 'select'])
  const select = library.find((entry) => entry.type === 'action' && entry.id === 'select')
  assert.equal(select?.type === 'action' && select.label, 'Select')

  // The select verb is optional: the push-confirm rows deliberately omit it.
  assert.equal(ids(buildTrackMenu(baseTrack)).includes('select'), false)
})

test('an auto queue row can convert its whole suggestion prefix into the user queue', () => {
  const menu = buildTrackMenu({ ...baseTrack, queueRow: 'auto' })
  const convert = menu.find((entry) => entry.type === 'action' && entry.id === 'convertUpTo')
  assert.equal(convert?.type === 'action' && convert.label, 'Convert up to here')
  assert.match(
    String(convert?.type === 'action' ? convert.ariaLabel : ''),
    /up to and including this one/,
    'the label must state the INCLUSIVE boundary — it is the one thing a user cannot guess',
  )
  // A user row is already queued: no conversion command exists there.
  const userRow = buildTrackMenu({ ...baseTrack, queueRow: 'user' })
  assert.equal(ids(userRow).includes('convertUpTo'), false)
})

test('the batch menu offers the same verbs for both surfaces, surface-appropriate', () => {
  const library = buildSelectionMenu({ surface: 'library', count: 3, canRemove: false, allInUserQueue: false })
  assert.deepEqual(ids(library), [
    'menu-context',
    'selectionPlayNext',
    'selectionAddToQueue',
    'selectionSetUserQueue',
    'menu-sep-feedback',
    'selectionLove',
    'selectionRating',
    'menu-sep-selection',
    'clearSelection',
  ])
  const heading = library[0]
  assert.equal(heading.type === 'label' && heading.label, '3 selected')
  const add = library.find((entry) => entry.type === 'action' && entry.id === 'selectionAddToQueue')
  assert.equal(add?.type === 'action' && add.label, 'Add to queue')

  const queue = buildSelectionMenu({ surface: 'queue', count: 2, canRemove: true, allInUserQueue: false })
  assert.equal(ids(queue).includes('selectionRemove'), true)
  // "Play next" is a library verb: queue rows are already queued, and a dead
  // command must not be offered (the host would silently no-op on it).
  assert.equal(ids(queue).includes('selectionPlayNext'), false)
  const queueAdd = queue.find((entry) => entry.type === 'action' && entry.id === 'selectionAddToQueue')
  assert.equal(queueAdd?.type === 'action' && queueAdd.label, 'Add to user queue')
  const remove = queue.find((entry) => entry.type === 'action' && entry.id === 'selectionRemove')
  assert.equal(remove?.type === 'action' && remove.danger, true)

  // Every selected row already sits in the user queue: the verb is present but
  // inert, rather than silently doing nothing when tapped.
  const alreadyQueued = buildSelectionMenu({
    surface: 'queue',
    count: 2,
    canRemove: true,
    allInUserQueue: true,
  })
  const disabledAdd = alreadyQueued.find((entry) => entry.type === 'action' && entry.id === 'selectionAddToQueue')
  assert.equal(disabledAdd?.type === 'action' && disabledAdd.disabled, true)
  // A queue selection with nothing removable hides the destructive verb.
  const locked = buildSelectionMenu({ surface: 'queue', count: 1, canRemove: false, allInUserQueue: true })
  assert.equal(ids(locked).includes('selectionRemove'), false)
})

test('the batch rating submenu writes a distinct command prefix and claims no checked row', () => {
  const items = buildBatchRatingMenu()
  assert.deepEqual(
    ids(items),
    CONTEXT_MENU_RATING_STEPS.map((step) => `${SELECTION_MENU_RATING_PREFIX}:${step}`),
  )
  // Different rows may hold different values: a single check mark would lie.
  assert.equal(items.some((entry) => entry.type === 'action' && entry.checked !== undefined), false)
  assert.equal(items[0].type === 'action' && items[0].label, 'Clear rating')
})

test('album and artist menus reuse the same command vocabulary for whole groups', () => {
  const album = buildGroupMenu({ kind: 'album', name: 'Nightdrive', trackCount: 2 })
  assert.deepEqual(ids(album), ['menu-context', 'play', 'playNext', 'addToQueue'])
  assert.equal(actions(album)[0].label, 'Play album')
  const heading = album[0]
  assert.equal(heading.type === 'label' && heading.detail, '2 tracks')

  const artist = buildGroupMenu({ kind: 'artist', name: 'Mara Voss', trackCount: 1 })
  assert.equal(actions(artist)[0].label, 'Play artist')
  const single = artist[0]
  assert.equal(single.type === 'label' && single.detail, '1 track')
})

test('keyboard traversal skips headings, separators and disabled commands, and wraps', () => {
  const entries: ContextMenuEntry[] = [
    { type: 'label', id: 'head', label: 'Head' },
    { type: 'action', id: 'a', label: 'A' },
    { type: 'separator', id: 'sep' },
    { type: 'action', id: 'b', label: 'B', disabled: true },
    { type: 'action', id: 'c', label: 'C' },
    { type: 'submenu', id: 'sub', label: 'Sub', items: [] },
  ]
  const navigable = menuNavigableIds(entries)
  assert.deepEqual(navigable, ['a', 'c', 'sub'])

  assert.equal(stepMenuId(navigable, 'a', 1), 'c')
  assert.equal(stepMenuId(navigable, 'c', 1), 'sub')
  assert.equal(stepMenuId(navigable, 'sub', 1), 'a')
  assert.equal(stepMenuId(navigable, 'a', -1), 'sub')
  // A current id that is not in the list (submenu switched) selects an edge.
  assert.equal(stepMenuId(navigable, 'b', 1), 'a')
  assert.equal(stepMenuId(navigable, 'b', -1), 'sub')
  assert.equal(stepMenuId([], 'a', 1), null)
})

test('placement opens at the pointer and flips only when the edge would clip', () => {
  const fits = placeContextMenu({
    x: 100,
    y: 100,
    width: 200,
    height: 200,
    viewportWidth: 1000,
    viewportHeight: 800,
  })
  assert.deepEqual(fits, { left: 100, top: 100, flippedX: false, flippedY: false })

  const rightEdge = placeContextMenu({
    x: 950,
    y: 100,
    width: 200,
    height: 200,
    viewportWidth: 1000,
    viewportHeight: 800,
  })
  assert.deepEqual(rightEdge, { left: 750, top: 100, flippedX: true, flippedY: false })

  const bottomEdge = placeContextMenu({
    x: 100,
    y: 750,
    width: 200,
    height: 200,
    viewportWidth: 1000,
    viewportHeight: 800,
  })
  assert.deepEqual(bottomEdge, { left: 100, top: 550, flippedX: false, flippedY: true })

  // A menu larger than the viewport clamps to the margin on both axes rather
  // than producing a negative coordinate.
  const huge = placeContextMenu({
    x: 100,
    y: 100,
    width: 1200,
    height: 1000,
    viewportWidth: 1000,
    viewportHeight: 800,
  })
  assert.deepEqual(huge, { left: 8, top: 8, flippedX: true, flippedY: true })
})

test('submenu opens beside its parent, flips left at the edge, and stays on-screen', () => {
  const beside = placeSubmenu({
    parentLeft: 100,
    parentTop: 200,
    parentWidth: 220,
    parentHeight: 36,
    width: 200,
    height: 160,
    viewportWidth: 1000,
    viewportHeight: 800,
  })
  assert.deepEqual(beside, { left: 316, top: 196, flipped: false })

  const flip = placeSubmenu({
    parentLeft: 850,
    parentTop: 200,
    parentWidth: 220,
    parentHeight: 36,
    width: 200,
    height: 160,
    viewportWidth: 1000,
    viewportHeight: 800,
  })
  assert.deepEqual(flip, { left: 654, top: 196, flipped: true })

  const bottom = placeSubmenu({
    parentLeft: 100,
    parentTop: 780,
    parentWidth: 220,
    parentHeight: 36,
    width: 200,
    height: 300,
    viewportWidth: 1000,
    viewportHeight: 800,
  })
  assert.equal(bottom.top, 492)
})
