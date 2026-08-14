/**
 * Pure queue-mutation algebra — the single source of truth for how a queue
 * edit rewrites its sections and re-anchors the active index.
 *
 * Owned exclusively by queueManager (`_mutateQueue` delegates here); kept free
 * of store/Dexie access so the anchor invariant and duplicate rule are
 * unit-verifiable (see the scratch-verify precedent) without a live app.
 *
 * Uniqueness invariant: the USER queue holds each track at most once — every
 * "move into user" builder (add, play-next, promote) collapses an existing
 * user copy instead of duplicating it. The AUTO queue never contains an id
 * twice by construction (`_buildPool` excludes `inAuto`); a tier-3 cross-
 * section duplicate (id in both sections) is transient and collapses on
 * promote. The re-anchor is therefore always to the unambiguous first (only)
 * user occurrence.
 */

import { inscribeRecent, RECENT_LIMIT } from './recentWindow'
import type { QueueState } from '../stores/appState'

const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true

/**
 * The sections a queue mutation may rewrite. `activeIndex` is deliberately NOT
 * part of the mutation surface — `applyQueueMutation` owns it exclusively,
 * re-anchoring from the pre-mutation active id (single source of truth for the
 * anchor invariant).
 */
export type QueueMutation = Partial<Pick<QueueState, 'userQueue' | 'autoQueue' | 'recentTrackIds'>>

/**
 * Applies a section mutation to a queue snapshot and returns the updated
 * snapshot, or `null` for a deliberate no-op (the caller must NOT write the
 * store then).
 *
 * Anchor rule: the active id is captured from `combined[activeIndex]` BEFORE
 * the sections change, then re-anchored to `indexOf(activeId)` on the rebuilt
 * combined queue. Under the uniqueness invariant every builder below preserves
 * the active id, so the re-anchor always resolves — a violation fails loudly
 * in DEV (assert) and degrades to −1 (safe stop, never a wrong row) in prod.
 * No active id (empty queue, or an out-of-range pre-mutation index) → −1.
 *
 * Invariant: `combined[activeIndex]` points at the playing track whenever it
 * remains queued.
 */
export function applyQueueMutation(
  q: QueueState,
  mutate: (q: QueueState) => QueueMutation | null,
): QueueState | null {
  const combined = [...q.userQueue, ...q.autoQueue]
  const activeId = q.activeIndex >= 0 && q.activeIndex < combined.length ? combined[q.activeIndex] : undefined
  const mutation = mutate(q)
  if (mutation === null) return null
  const updated: QueueState = { ...q, ...mutation }
  if (activeId !== undefined) {
    const newCombined = [...updated.userQueue, ...updated.autoQueue]
    if (DEV && !newCombined.includes(activeId)) {
      console.error(
        '[queueMutation] anchor invariant violated — a mutation dropped the active id from the queue:',
        { activeId, userQueue: updated.userQueue, autoQueue: updated.autoQueue },
      )
    }
    updated.activeIndex = newCombined.indexOf(activeId)
  } else {
    updated.activeIndex = -1
  }
  return updated
}

/**
 * Positions `trackId` in the user queue right after the active row (clamped to
 * the user tail when the active row sits in the auto queue; appended when
 * nothing is active). An existing user copy is MOVED (dedupe-move); otherwise
 * the row is inserted. Returns `null` when the row has no user slot and is
 * already in place — or, for an existing copy, when it already occupies the
 * target slot (including the active row itself: moving "next" from the active
 * slot is a no-op reorder).
 */
export function insertUserAfterActive(q: QueueState, trackId: string): string[] | null {
  const idx = q.userQueue.indexOf(trackId)
  const insertAt = q.activeIndex >= 0 ? Math.min(q.activeIndex + 1, q.userQueue.length) : q.userQueue.length
  if (idx >= 0 && (insertAt === idx || insertAt === idx + 1)) return null
  if (idx < 0) {
    return [...q.userQueue.slice(0, insertAt), trackId, ...q.userQueue.slice(insertAt)]
  }
  const userQueue = q.userQueue.filter((id) => id !== trackId)
  userQueue.splice(insertAt > idx ? insertAt - 1 : insertAt, 0, trackId)
  return userQueue
}

/** Appends to the user queue; no-op (null) when the track already has a user slot. */
export function addToUserQueue(q: QueueState, trackId: string): QueueMutation | null {
  if (q.userQueue.includes(trackId)) return null
  return { userQueue: [...q.userQueue, trackId] }
}

/**
 * Plays a track right after the active row (user-copy move when it is already
 * queued, plain insert otherwise). In-auto active row: clamped to the user
 * tail, which can sit before the playing track in combined order — accepted
 * by design.
 */
export function playNext(q: QueueState, trackId: string): QueueMutation | null {
  const userQueue = insertUserAfterActive(q, trackId)
  return userQueue ? { userQueue } : null
}

/**
 * Moves an auto row to the end of the user queue; an existing user copy is
 * kept (no duplicate — the auto copy is simply dropped).
 */
export function promoteToUser(q: QueueState, trackId: string): QueueMutation | null {
  if (q.autoQueue.indexOf(trackId) < 0) return null
  return {
    userQueue: q.userQueue.includes(trackId) ? q.userQueue : [...q.userQueue, trackId],
    autoQueue: q.autoQueue.filter((id) => id !== trackId),
  }
}

/**
 * Moves an auto row to the slot right after the active row (dedupe-move of a
 * user copy if one exists). The auto copy is always dropped — even when the
 * user part is already in place, so a cross-section duplicate never survives.
 */
export function promoteToUserNext(q: QueueState, trackId: string): QueueMutation | null {
  if (q.autoQueue.indexOf(trackId) < 0) return null
  const userQueue = insertUserAfterActive(q, trackId)
  return {
    ...(userQueue ? { userQueue } : {}),
    autoQueue: q.autoQueue.filter((id) => id !== trackId),
  }
}

/** Reorders a user row to just after the active row; no-op (null) when the row is missing or already in place. */
export function moveToNext(q: QueueState, trackId: string): QueueMutation | null {
  if (q.userQueue.indexOf(trackId) < 0) return null
  const userQueue = insertUserAfterActive(q, trackId)
  return userQueue ? { userQueue } : null
}

/** Moves a user row to the very end of the user queue. */
export function moveToEnd(q: QueueState, trackId: string): QueueMutation | null {
  if (q.userQueue.indexOf(trackId) < 0) return null
  const userQueue = q.userQueue.filter((id) => id !== trackId)
  userQueue.push(trackId)
  return { userQueue }
}

/**
 * Promotes the active track out of the auto queue — the post-load success
 * path. The auto queue is sliced from the active id's first occurrence (rows
 * up to it are consumed; auto holds no internal duplicates), and the id gains
 * a user slot ONLY when it has none — a tier-3 cross-section duplicate
 * collapses instead of appending a repeat (which would have replayed the
 * just-finished track). No-op (null) when the active row isn't in auto
 * (already promoted, or the id lives only in the user queue).
 */
export function promoteActiveTrack(q: QueueState): QueueMutation | null {
  const combined = [...q.userQueue, ...q.autoQueue]
  const activeId = q.activeIndex >= 0 && q.activeIndex < combined.length ? combined[q.activeIndex] : undefined
  if (!activeId) return null
  const autoIdx = q.autoQueue.indexOf(activeId)
  if (autoIdx < 0) return null
  return {
    userQueue: q.userQueue.includes(activeId) ? q.userQueue : [...q.userQueue, activeId],
    autoQueue: q.autoQueue.slice(autoIdx + 1),
  }
}

/**
 * "Not now": removes an auto-queued track and cools it down so the next fill
 * doesn't immediately re-suggest it. Active-row targets never reach here —
 * the manager routes those to `promoteActiveTrack` first.
 */
export function removeFromAutoQueue(q: QueueState, trackId: string): QueueMutation | null {
  if (q.autoQueue.indexOf(trackId) < 0) return null
  return {
    autoQueue: q.autoQueue.filter((id) => id !== trackId),
    recentTrackIds: inscribeRecent(q.recentTrackIds, trackId, RECENT_LIMIT),
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
 */
export function advanceTargetIndex(
  q: QueueState,
  combined: string[],
  playingId: string | undefined,
): number {
  const currentId = q.activeIndex >= 0 && q.activeIndex < combined.length ? combined[q.activeIndex] : undefined
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
  return { userQueue: currentId ? [currentId] : [], autoQueue: [] }
}