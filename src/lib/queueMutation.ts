/**
 * Pure queue-mutation algebra — the single source of truth for how a queue
 * edit rewrites its sections and re-anchors the active index.
 *
 * Owned exclusively by queueManager (`_mutateQueue` delegates here); kept free
 * of store/Dexie access so the anchor invariant and occurrence identity are
 * unit-verifiable without a live app.
 *
 * IDENTITY MODEL (2026-10-21, queue redesign step 1): a row is an OCCURRENCE —
 * `(section, trackId, ordinal)` — never a bare id. Duplicates are legal in
 * BOTH sections (D3): the user section is a listening log, and an id may occur
 * any number of times. Nothing here dedupes, normalizes, or asserts uniqueness;
 * row identity, drag identity, removal and the anchor all speak occurrences
 * (`queueOccurrence.ts`). The native `queueEntryId` is the occurrence's entry
 * id, so Swift can name one copy of a repeated song.
 *
 * Anchor rule: preserve the active OCCURRENCE, not merely its song id. The
 * anchor is captured from `combined[activeIndex]` BEFORE the sections change
 * and re-resolved by (section, id, ordinal) after them. When that exact copy
 * was moved across sections (promotion, a drag across the user/auto seam) the
 * anchor follows the moved copy — `anchorIndex` is the planner's explicit
 * target for that case. Only a genuinely vanished id degrades to position
 * semantics, and DEV records the violation.
 *
 * Reordering with duplicates: a REORDER is row-scoped
 * (`moveUserRowToNext`/`moveUserRowToEnd`) — an id names several rows, so
 * there is no id-taking move. Row-specific UI paths (drag, remove, auto-row
 * promote) take a section index or an occurrence for the same reason. The one
 * id-taking builder left is `playNext`, which INSERTS its own row and never
 * repositions an existing one.
 */

import { inscribeRecent, RECENT_LIMIT } from './recentWindow'
import {
  entryIdOf,
  findEntryIndex,
  findOccurrenceIndex,
  occurrenceAt,
  occurrenceCounts,
  sameOccurrence,
  sectionOccurrences,
  type QueueOccurrence,
  type QueueSection,
} from './queueOccurrence'
import type { QueueState } from '../stores/appState'

const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true

/**
 * The sections a queue mutation may rewrite. `activeIndex` is deliberately NOT
 * part of the mutation surface — `applyQueueMutation` owns it exclusively,
 * re-anchoring from the pre-mutation active occurrence (single source of truth
 * for the anchor invariant). `anchorIndex` is the one exception: a planner that
 * MOVES the active occurrence across sections (a drag over the user/auto seam)
 * knows its post-mutation index, which section-local re-resolution cannot
 * derive. It is validated against the expected id before use.
 */
export type QueueMutation = Partial<Pick<QueueState, 'userQueue' | 'autoQueue' | 'recentTrackIds'>> & {
  anchorIndex?: number
}

/** Resolve the exact reported occurrence when available; otherwise preserve
 * a matching selection, prefer forward playback, then allow wraps/re-adoption.
 * Never trust numeric indexes from an engine's older snapshot. */
export function resolveQueueOccurrence(
  combined: string[],
  trackId: string,
  activeIndex: number,
  occurrence?: { entryId: string; userLength: number },
): number {
  if (occurrence) {
    const userLength = Math.max(0, Math.min(occurrence.userLength, combined.length))
    const exact = findEntryIndex(combined.slice(0, userLength), combined.slice(userLength), occurrence.entryId)
    if (exact >= 0 && combined[exact] === trackId) return exact
  }
  if (activeIndex >= 0 && activeIndex < combined.length && combined[activeIndex] === trackId) return activeIndex
  const forward = combined.indexOf(trackId, Math.max(0, activeIndex + 1))
  return forward >= 0 ? forward : combined.indexOf(trackId)
}

/**
 * Where the pre-mutation audible occurrence lives in the mutated queue.
 *
 * 1. The exact occurrence (section + id + ordinal) still exists → its index.
 * 2. The copy moved to the OTHER section (promotion appends the audible row at
 *    the user boundary; a drag across the seam converts it) → that section's
 *    occurrence of the id (last when moving auto→user, first when moving
 *    user→auto — the boundary the move produced in practice).
 * 3. Another copy of the same id remains in its own section → that copy.
 * 4. The id is gone entirely → position semantics (the pre-mutation index,
 *    clamped) + a DEV violation line.
 */
function resolveAnchorAfterMutation(active: QueueOccurrence, before: QueueState, updated: QueueState): number {
  const exact = findOccurrenceIndex(updated.userQueue, updated.autoQueue, active)
  if (exact >= 0) return exact

  const otherIds = active.section === 'user' ? updated.autoQueue : updated.userQueue
  const otherIdx = active.section === 'user' ? otherIds.indexOf(active.trackId) : otherIds.lastIndexOf(active.trackId)
  if (otherIdx >= 0) return active.section === 'user' ? updated.userQueue.length + otherIdx : otherIdx

  const ownIds = active.section === 'user' ? updated.userQueue : updated.autoQueue
  const ownIdx = ownIds.indexOf(active.trackId)
  if (ownIdx >= 0) return active.section === 'user' ? ownIdx : updated.userQueue.length + ownIdx

  const total = updated.userQueue.length + updated.autoQueue.length
  if (DEV) {
    console.error(
      '[queueMutation] anchor invariant violated — a mutation dropped the active id from the queue:',
      { active, userQueue: updated.userQueue, autoQueue: updated.autoQueue },
    )
  }
  return Math.min(before.activeIndex, total - 1)
}

/**
 * Applies a section mutation to a queue snapshot and returns the updated
 * snapshot, or `null` for a deliberate no-op (the caller must NOT write the
 * store then).
 *
 * No uniqueness enforcement exists here — a within-section duplicate is legal
 * input and legal output (D3). Row identity is the occurrence, so a duplicate
 * is never a key collision: QueueView keys rows by `u-<id>#<n>`.
 */
export function applyQueueMutation(
  q: QueueState,
  mutate: (q: QueueState) => QueueMutation | null,
): QueueState | null {
  const active = occurrenceAt(q.userQueue, q.autoQueue, q.activeIndex)
  const mutation = mutate(q)
  if (mutation === null) return null
  const { anchorIndex, ...sections } = mutation
  const updated: QueueState = { ...q, ...sections }
  if (!active) {
    updated.activeIndex = -1
    return updated
  }
  // A planner's explicit target wins over ordinal re-resolution: with two
  // copies of one id, the ordinal that was audible can name a DIFFERENT
  // physical row after a same-id copy moved past it. The hint is validated by
  // id, so a stale/incorrect hint can never anchor a different song.
  if (anchorIndex !== undefined) {
    const combined = [...updated.userQueue, ...updated.autoQueue]
    if (anchorIndex >= 0 && anchorIndex < combined.length && combined[anchorIndex] === active.trackId) {
      updated.activeIndex = anchorIndex
      return updated
    }
  }
  const exact = findOccurrenceIndex(updated.userQueue, updated.autoQueue, active)
  if (exact >= 0) {
    updated.activeIndex = exact
    return updated
  }
  updated.activeIndex = resolveAnchorAfterMutation(active, q, updated)
  return updated
}

/** Appends a new occurrence to the user queue. Always — a queued row is an
 *  occurrence, not a set membership (D2). */
export function addToUserQueue(q: QueueState, trackId: string): QueueMutation | null {
  return { userQueue: [...q.userQueue, trackId] }
}

/**
 * "Play next" (the row menu / library press): inserts a NEW user occurrence
 * right after the active row. D2/step 2 — a press-driven insert is an INTENT to
 * hear this song next, not a request to relocate a copy the user already has
 * (that copy may be history above the anchor, and moving it would rewrite the
 * listening log). Row-scoped reorders stay in `moveUserRowToNext`/
 * `moveUserRowToEnd`.
 *
 * In-auto active row: clamped to the user tail, which can sit before the
 * playing track in combined order — accepted by design.
 */
export function playNext(q: QueueState, trackId: string): QueueMutation | null {
  const insertAt = q.activeIndex >= 0 ? Math.min(q.activeIndex + 1, q.userQueue.length) : q.userQueue.length
  // Inserted BELOW the audible user row (or at the tail), so the anchor needs no
  // hint: the audible occurrence keeps its ordinal and `applyQueueMutation`
  // re-resolves it exactly. An auto-active row is untouched by a user insert.
  return { userQueue: [...q.userQueue.slice(0, insertAt), trackId, ...q.userQueue.slice(insertAt)] }
}

/**
 * A PRESS on a song outside the queue (D1): start THAT song, never jump to an
 * old copy of it. Returns the rewritten state, or `null` when the press is the
 * audible row itself (resume/restart — no new row).
 *
 * The write: drop the id's auto occurrence(s) (a suggestion is superseded by
 * an explicit play), append ONE user occurrence, anchor it, and cool the
 * previous audible row into the recency window. Anchor-changing by design, so
 * it returns a full state instead of a `QueueMutation` (whose anchor contract
 * is "preserve the audible occurrence").
 */
export function pressTrack(q: QueueState, trackId: string): QueueState | null {
  const combined = [...q.userQueue, ...q.autoQueue]
  const activeId = q.activeIndex >= 0 && q.activeIndex < combined.length ? combined[q.activeIndex] : undefined
  if (activeId === trackId) return null
  const userQueue = [...q.userQueue, trackId]
  return {
    ...q,
    userQueue,
    autoQueue: q.autoQueue.filter((id) => id !== trackId),
    activeIndex: userQueue.length - 1,
    recentTrackIds: activeId ? inscribeRecent(q.recentTrackIds, activeId, RECENT_LIMIT) : q.recentTrackIds,
  }
}

/**
 * Moves the auto OCCURRENCE at `autoIndex` to the end of the user queue — a
 * new user occurrence, because promoting a suggestion is exactly "queue this
 * now". An older user copy of the same id stays where it is as history. Out-of-
 * range index is a no-op.
 */
export function promoteToUser(q: QueueState, autoIndex: number): QueueMutation | null {
  const trackId = q.autoQueue[autoIndex]
  if (trackId === undefined) return null
  const removedCombined = q.userQueue.length + autoIndex
  const anchorIndex = q.activeIndex >= q.userQueue.length && q.activeIndex > removedCombined
    ? q.activeIndex - 1
    : undefined
  return {
    userQueue: [...q.userQueue, trackId],
    autoQueue: q.autoQueue.filter((_, i) => i !== autoIndex),
    ...(anchorIndex !== undefined ? { anchorIndex } : {}),
  }
}

/**
 * Moves the auto OCCURRENCE at `autoIndex` to the slot right after the active
 * row, appending a new user occurrence (no dedupe-move: the auto row and any
 * user copy are independent rows). Out-of-range index is a no-op.
 */
export function promoteToUserNext(q: QueueState, autoIndex: number): QueueMutation | null {
  const trackId = q.autoQueue[autoIndex]
  if (trackId === undefined) return null
  const insertAt = q.activeIndex >= 0 ? Math.min(q.activeIndex + 1, q.userQueue.length) : q.userQueue.length
  let anchorIndex: number | undefined
  if (q.activeIndex >= 0 && q.activeIndex < q.userQueue.length) {
    anchorIndex = insertAt <= q.activeIndex ? q.activeIndex + 1 : q.activeIndex
  } else if (q.activeIndex >= q.userQueue.length) {
    // The user section grows by one ABOVE the auto row, and the removed auto
    // occurrence may have sat before the audible one.
    anchorIndex = q.activeIndex + 1 - (autoIndex < q.activeIndex - q.userQueue.length ? 1 : 0)
  }
  return {
    userQueue: [...q.userQueue.slice(0, insertAt), trackId, ...q.userQueue.slice(insertAt)],
    autoQueue: q.autoQueue.filter((_, i) => i !== autoIndex),
    ...(anchorIndex !== undefined ? { anchorIndex } : {}),
  }
}

/**
 * Reorders the user OCCURRENCE at `index` to just after the active row. The
 * exact row is addressed by index (the view always has it), so a duplicate id
 * can never move a different copy. No-op when the row is already in place.
 */
export function moveUserRowToNext(q: QueueState, index: number): QueueMutation | null {
  const trackId = q.userQueue[index]
  if (trackId === undefined) return null
  const insertAt = q.activeIndex >= 0 ? Math.min(q.activeIndex + 1, q.userQueue.length) : q.userQueue.length
  if (insertAt === index || insertAt === index + 1) return null
  const userQueue = [...q.userQueue]
  userQueue.splice(index, 1)
  const adjusted = Math.max(0, Math.min(insertAt > index ? insertAt - 1 : insertAt, userQueue.length))
  userQueue.splice(adjusted, 0, trackId)
  let anchorIndex: number | undefined
  if (q.activeIndex >= 0 && q.activeIndex < q.userQueue.length) {
    if (q.activeIndex === index) anchorIndex = adjusted
    else {
      const base = q.activeIndex - (index < q.activeIndex ? 1 : 0)
      anchorIndex = adjusted <= base ? base + 1 : base
    }
  }
  return { userQueue, ...(anchorIndex !== undefined ? { anchorIndex } : {}) }
}

/** Moves the user OCCURRENCE at `index` to the very end of the user queue. */
export function moveUserRowToEnd(q: QueueState, index: number): QueueMutation | null {
  const trackId = q.userQueue[index]
  if (trackId === undefined) return null
  const userQueue = [...q.userQueue]
  userQueue.splice(index, 1)
  userQueue.push(trackId)
  let anchorIndex: number | undefined
  if (q.activeIndex >= 0 && q.activeIndex < q.userQueue.length) {
    anchorIndex = q.activeIndex === index
      ? userQueue.length - 1
      : q.activeIndex > index ? q.activeIndex - 1 : q.activeIndex
  }
  return { userQueue, ...(anchorIndex !== undefined ? { anchorIndex } : {}) }
}

/**
 * Promote ONLY the active AUTO occurrence (D5): append a NEW user occurrence at
 * the boundary and remove the auto occurrence. An older user copy of the same
 * id stays where it is as history — promotion never relocates it (moving it
 * would delete a row the user already played). The consumed skipped auto
 * prefix cools down atomically.
 */
export function promoteActiveTrack(q: QueueState): QueueMutation | null {
  const combined = [...q.userQueue, ...q.autoQueue]
  const activeId = q.activeIndex >= 0 && q.activeIndex < combined.length ? combined[q.activeIndex] : undefined
  if (!activeId || q.activeIndex < q.userQueue.length) return null
  const autoIdx = q.activeIndex - q.userQueue.length
  // The CONSUMED prefix cools down in the same write (2026-09-12): tapping
  // an auto row deep in the queue discards every row before it — rows the
  // user never played. Without a recency mark they re-enter the fresh fill
  // pool on the very next replenish (tier 1) at the anchor-rotation head, so
  // the auto tail visibly reshuffled itself after every manual auto-row play
  // ("songs afterward keep changing order"). It rides THIS mutation because
  // afterwards the rows are gone from the queue and no caller can see what
  // was consumed.
  let recentTrackIds = q.recentTrackIds
  for (const skippedId of q.autoQueue.slice(0, autoIdx)) {
    recentTrackIds = inscribeRecent(recentTrackIds, skippedId, RECENT_LIMIT)
  }
  return {
    userQueue: [...q.userQueue, activeId],
    autoQueue: q.autoQueue.slice(autoIdx + 1),
    // The appended tail row is the new anchor (the hint is validated against
    // the audible id by `applyQueueMutation`).
    anchorIndex: q.userQueue.length,
    ...(recentTrackIds !== q.recentTrackIds ? { recentTrackIds } : {}),
  }
}

/**
 * The drag-preview transform, shared by the QueueView preview AND the drop
 * resolver (2026-09-12). Operates on ID arrays in combined order: `fromIdx`
 * is the dragged row's combined index, `toIdx` the DOM drop slot (combined
 * space). Semantics:
 *   - user→user: reorder within the user section;
 *   - user→auto: the dragged row lands PAST the user tail and auto rows
 *     above the slot join the user tail (the "convert" rule);
 *   - auto→user: the dragged row is inserted into the user section;
 *   - auto→auto: reorder within the auto section.
 * One algorithm for what-you-see and what-you-get.
 *
 * The OCCURRENCE-aware form (`planDragDropRows`) is the source of truth: it
 * carries each row's origin section, so duplicates and cross-section
 * conversion keep their identity. `planDragDrop` is the preview's id view.
 */
export type DragRow = QueueOccurrence

export function planDragDropRows(
  user: string[],
  auto: string[],
  fromIdx: number,
  toIdx: number,
): { user: DragRow[]; auto: DragRow[] } {
  const userRows = sectionOccurrences(user, 'user')
  const autoRows = sectionOccurrences(auto, 'auto')
  const U = userRows.length
  const isUserSource = fromIdx < U
  const rows = isUserSource ? userRows : autoRows
  const sourceIdx = isUserSource ? fromIdx : fromIdx - U
  const dragged = rows[sourceIdx]
  if (dragged === undefined) return { user: userRows, auto: autoRows }
  const target = Math.max(0, toIdx)

  if (isUserSource) {
    const remainingUser = userRows.filter((_, i) => i !== fromIdx)
    if (target <= U) {
      let insertAt = target
      if (insertAt > fromIdx) insertAt--
      insertAt = Math.max(0, Math.min(insertAt, remainingUser.length))
      const nextUser = [...remainingUser]
      nextUser.splice(insertAt, 0, dragged)
      return { user: nextUser, auto: autoRows }
    }
    const autoTargetIdx = target - U
    return {
      user: [...remainingUser, ...autoRows.slice(0, autoTargetIdx), dragged],
      auto: autoRows.slice(autoTargetIdx),
    }
  }

  const remainingAuto = autoRows.filter((_, i) => i !== sourceIdx)
  if (target <= U) {
    const insertAt = Math.max(0, Math.min(target, userRows.length))
    const nextUser = [...userRows]
    nextUser.splice(insertAt, 0, dragged)
    return { user: nextUser, auto: remainingAuto }
  }
  const autoTargetIdx = target - U
  let insertAt = autoTargetIdx
  if (insertAt > sourceIdx) insertAt--
  insertAt = Math.max(0, Math.min(insertAt, remainingAuto.length))
  const nextAuto = [...remainingAuto]
  nextAuto.splice(insertAt, 0, dragged)
  return { user: userRows, auto: nextAuto }
}

/** Id view of the drag plan (preview / legacy callers). */
export function planDragDrop(
  user: string[],
  auto: string[],
  fromIdx: number,
  toIdx: number,
): { user: string[]; auto: string[] } {
  const plan = planDragDropRows(user, auto, fromIdx, toIdx)
  return { user: plan.user.map((r) => r.trackId), auto: plan.auto.map((r) => r.trackId) }
}

/**
 * Drop resolution for the queue drag-and-drop.
 *
 * The dragged row is an OCCURRENCE (its entry id), not an id — with duplicates
 * an id cannot name the row the user grabbed (G5). The plan is computed from
 * the drag-time arrays (what the user SAW) and then RECONCILED against the
 * live store by PER-ID OCCURRENCE COUNTS: each planned row consumes one live
 * occurrence of that id in the section it came from, and planned rows with no
 * live occurrence left are dropped (removed mid-drag, never resurrected).
 * Live rows no planned row consumed (they joined mid-drag) are appended in
 * live order to their own section — the user never saw them, so the visible
 * intent stays authoritative for the rows they did see.
 *
 * Set membership (the old `liveIds.has(id)`) cannot express two copies of one
 * id: it either drops the second planned copy or re-admits the second live
 * copy as a "newcomer". Counts are the only correct budget. No-op when the
 * reconciled shape already matches the store; the dragged occurrence leaving
 * the queue entirely voids the drop.
 */
export function applyDragDrop(
  q: QueueState,
  draggedEntryId: string,
  targetCombinedIndex: number,
  dragStartUser: string[],
  dragStartAuto: string[],
): QueueMutation | null {
  const active = occurrenceAt(q.userQueue, q.autoQueue, q.activeIndex)
  const fromIdx = findEntryIndex(dragStartUser, dragStartAuto, draggedEntryId)
  if (fromIdx < 0) return null
  const draggedOccurrence = occurrenceAt(dragStartUser, dragStartAuto, fromIdx)
  if (!draggedOccurrence) return null
  const plan = planDragDropRows(dragStartUser, dragStartAuto, fromIdx, targetCombinedIndex)

  const liveCounts: Record<QueueSection, Map<string, number>> = {
    user: occurrenceCounts(q.userQueue),
    auto: occurrenceCounts(q.autoQueue),
  }
  const used: Record<QueueSection, Map<string, number>> = { user: new Map(), auto: new Map() }
  const user: string[] = []
  const auto: string[] = []
  const plannedIndexByEntry = new Map<string, number>()
  let draggedKept = false

  const keep = (row: DragRow, out: string[]): boolean => {
    const budget = liveCounts[row.section].get(row.trackId) ?? 0
    const consumed = used[row.section].get(row.trackId) ?? 0
    if (consumed >= budget) return false
    used[row.section].set(row.trackId, consumed + 1)
    out.push(row.trackId)
    return true
  }

  for (const row of plan.user) {
    if (!keep(row, user)) continue
    plannedIndexByEntry.set(entryIdOf(row.section, row.trackId, row.ordinal), user.length - 1)
    if (sameOccurrence(row, draggedOccurrence)) draggedKept = true
  }
  for (const row of plan.auto) {
    if (!keep(row, auto)) continue
    plannedIndexByEntry.set(entryIdOf(row.section, row.trackId, row.ordinal), user.length + auto.length - 1)
    if (sameOccurrence(row, draggedOccurrence)) draggedKept = true
  }
  if (!draggedKept) return null

  // Live rows the plan never consumed joined mid-drag: keep them, in live
  // order, in the section they joined.
  for (const id of q.userQueue) {
    const consumed = used.user.get(id) ?? 0
    if (consumed > 0) used.user.set(id, consumed - 1)
    else user.push(id)
  }
  for (const id of q.autoQueue) {
    const consumed = used.auto.get(id) ?? 0
    if (consumed > 0) used.auto.set(id, consumed - 1)
    else auto.push(id)
  }

  // A moved active occurrence knows its own target index — the explicit anchor
  // hint that a cross-section conversion cannot derive section-locally.
  let anchorIndex: number | undefined
  if (active) {
    const key = entryIdOf(active.section, active.trackId, active.ordinal)
    const planned = plannedIndexByEntry.get(key)
    if (planned !== undefined && [...user, ...auto][planned] === active.trackId) anchorIndex = planned
  }

  if (JSON.stringify(user) === JSON.stringify(q.userQueue) && JSON.stringify(auto) === JSON.stringify(q.autoQueue)) {
    return null
  }
  return { userQueue: user, autoQueue: auto, ...(anchorIndex !== undefined ? { anchorIndex } : {}) }
}

/**
 * "Not now": removes the auto OCCURRENCE at `autoIndex` and cools it down so
 * the next fill doesn't immediately re-suggest it (the recency window is
 * id-scoped by design). Active-row targets never reach here — the manager
 * routes those to `promoteActiveTrack` first.
 */
export function removeFromAutoQueue(q: QueueState, autoIndex: number): QueueMutation | null {
  const trackId = q.autoQueue[autoIndex]
  if (trackId === undefined) return null
  const removedCombined = q.userQueue.length + autoIndex
  const anchorIndex = q.activeIndex > removedCombined ? q.activeIndex - 1 : undefined
  return {
    autoQueue: q.autoQueue.filter((_, i) => i !== autoIndex),
    recentTrackIds: inscribeRecent(q.recentTrackIds, trackId, RECENT_LIMIT),
    ...(anchorIndex !== undefined ? { anchorIndex } : {}),
  }
}

/**
 * Removes a user-queue row and re-anchors the active index by POSITION, not
 * id — the removed id may be the playing track itself, so the B1 id re-anchor
 * (`indexOf`) can't apply. Position semantics (2.4, decided 2026-08-14 —
 * option b):
 *   - index < activeIndex  → the active track slid down one slot: decrement;
 *   - index === activeIndex → the active row is gone: KEEP the index so the
 *     highlight slides to the next playable row (the track now occupying the
 *     removed slot), never the already-played predecessor;
 *   - index > activeIndex  → the active track is untouched: keep.
 * The removed id cools in the recency window (removal is a "not now" intent).
 * Returns `null` (no store write) for an out-of-range index.
 */
export function removeFromUserQueue(q: QueueState, index: number): QueueState | null {
  if (index < 0 || index >= q.userQueue.length) return null
  const removedId = q.userQueue[index]
  const userQueue = q.userQueue.filter((_, i) => i !== index)
  const activeIndex = q.activeIndex > index ? Math.max(0, q.activeIndex - 1) : q.activeIndex
  return {
    ...q,
    userQueue,
    activeIndex,
    recentTrackIds: inscribeRecent(q.recentTrackIds, removedId, RECENT_LIMIT),
  }
}

/**
 * The index the advance paths (`advanceQueue`/`next`/`_hasNextQueued`) should
 * target, given the queue snapshot, the combined id list and the currently-
 * PLAYING track id.
 *
 * Normally `combined[activeIndex]` IS the playing track (B1), so the next
 * target is `activeIndex + 1`. After an active-row removal (2.4 option b) the
 * playing track is NOT in the queue and `combined[activeIndex]` is the NEXT
 * row — the target is `activeIndex` itself; `activeIndex + 1` would skip the
 * highlighted row (and `activeIndex + 1 < length` would wrongly read as
 * "queue ended" → stop/wrap). When there is no playing track at all
 * (`playingId` undefined — stopped, or a truly empty queue), the target stays
 * `activeIndex + 1` (the end-of-queue refill path targets the first new row).
 *
 * `pendingTrackId` (D10, 2026-10-21e) is the explicit "the anchor is ahead of
 * the audio" fact: an advance moved the anchor onto that row and its load has
 * not landed yet. While the anchor still names it, the mismatch against
 * `playingId` is a TRANSITION, not a removal — the next target is
 * `activeIndex + 1`, so a second press skips a second row instead of
 * re-loading the first. When the anchor no longer names it (a real removal,
 * an unrelated write), the positional removal rule applies unchanged.
 */
export function advanceTargetIndex(
  q: QueueState,
  combined: string[],
  playingId: string | undefined,
  pendingTrackId?: string | null,
): number {
  const currentId = q.activeIndex >= 0 && q.activeIndex < combined.length ? combined[q.activeIndex] : undefined
  if (pendingTrackId !== undefined && pendingTrackId !== null && currentId === pendingTrackId) {
    return q.activeIndex + 1
  }
  return playingId !== undefined && currentId !== playingId ? q.activeIndex : q.activeIndex + 1
}

/**
 * Empties the queue down to the actively playing track (kept at user[0] so
 * playback continues). The anti-repeat window is PRESERVED — a clear is an
 * explicit queue edit, not a "just heard it" event (asymmetric by intent vs.
 * Play All, which resets the window).
 */
export function clearQueue(q: QueueState): QueueMutation | null {
  const combined = [...q.userQueue, ...q.autoQueue]
  const currentId = q.activeIndex >= 0 && q.activeIndex < combined.length ? combined[q.activeIndex] : null
  return { userQueue: currentId ? [currentId] : [], autoQueue: [], ...(currentId ? { anchorIndex: 0 } : {}) }
}

/**
 * Removes user-queue rows ABOVE the active row. B8 keeps played rows listed,
 * so "above" is the played/passed-over pile — this is the clean-up affordance
 * for it. The active row and everything after it are untouched; the AUTO
 * queue is never touched (the buttons are user-queue-scoped by design).
 * An active row in the auto section means every user row sits above it —
 * all of them go. Null when nothing is active or nothing sits above.
 * The anti-repeat window is preserved (an explicit edit, like clearQueue).
 */
export function clearUserAboveActive(q: QueueState): QueueMutation | null {
  if (q.activeIndex < 0) return null
  const cut = q.activeIndex < q.userQueue.length ? q.activeIndex : q.userQueue.length
  if (cut === 0) return null
  const anchorIndex = q.activeIndex < q.userQueue.length ? 0 : q.activeIndex - q.userQueue.length
  return { userQueue: q.userQueue.slice(cut), anchorIndex }
}

/**
 * Removes user-queue rows BELOW the active row (everything the user queued
 * after the playing track). The active row and everything before it are
 * untouched; the AUTO queue is never touched. Null when nothing is active,
 * the active row sits in the auto section (no user row is below it), or
 * nothing sits below. The anti-repeat window is preserved.
 */
export function clearUserBelowActive(q: QueueState): QueueMutation | null {
  if (q.activeIndex < 0 || q.activeIndex >= q.userQueue.length) return null
  const userQueue = q.userQueue.slice(0, q.activeIndex + 1)
  return userQueue.length === q.userQueue.length ? null : { userQueue, anchorIndex: q.activeIndex }
}
