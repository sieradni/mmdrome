/**
 * Pure crossfade-end queue reconcile (TODO 1.0 Step 2) — the computation that
 * used to live inline in `playbackManager._handleCrossfadeEnd`. After a
 * crossfade switch the track that is ACTUALLY playing may no longer match the
 * queue's active row (the manager advanced while the fade was in flight, or
 * the user removed/reordered rows mid-fade). This module pins the reconcile
 * decisions once, table-tested; the manager applies the patch.
 *
 * Inputs are the transport-reported facts AFTER `advanceQueue()` ran:
 *  - `targetId` — the armed crossfade target id (null = the arm was cancelled
 *    mid-fade: NO reconcile runs at all — including the loop-all wrap, which
 *    the old code gated inside the `_crossfadeTrackId` block);
 *  - `combined`/`activeIndex`/`userQueue` — the post-advance queue snapshot;
 *  - `advanced` — whether advanceQueue produced a next track;
 *  - `loopMode` — for the wrap decision.
 *
 * Decisions (parity with playbackManager.ts `_handleCrossfadeEnd`):
 *  - target still queued → repoint the active index to it (no-op when the
 *    index already matches);
 *  - target removed mid-fade → rescue: re-insert it at the TOP of the user
 *    queue, activeIndex 0 (the audible track must re-enter the queue);
 *  - advance exhausted + loop-all + a non-empty user queue → wrap to the
 *    first user row. The wrap is the old code's LAST write, so it wins over
 *    repoint/rescue (in the rescue case the rescued row IS userQueue[0], so
 *    the wrap lands on it at index 0 either way).
 *
 * The rescue is an anchor-CHANGING write (the active id changes) — it must
 * NOT route through queueManager._mutateQueue's id re-anchor (B1 scope
 * boundary); the manager applies it with a direct queue.update + saveQueue.
 */

import type { LoopMode } from './advanceDecider'

export type CrossfadeReconcileResult =
  | { kind: 'none' }
  | { kind: 'repoint'; index: number }
  | { kind: 'rescue'; userQueue: string[] }
  | { kind: 'wrap'; index: number }

export interface CrossfadeReconcileInput {
  /** The armed crossfade target id; null = nothing to reconcile. */
  targetId: string | null
  /** Post-advance combined queue (user + auto). */
  combined: string[]
  /** Post-advance active index. */
  activeIndex: number
  /** Post-advance user queue. */
  userQueue: string[]
  /** Whether advanceQueue found a next track. */
  advanced: boolean
  loopMode: LoopMode
}

export function reconcileCrossfadeTarget(input: CrossfadeReconcileInput): CrossfadeReconcileResult {
  const { targetId, combined, activeIndex, userQueue, advanced, loopMode } = input
  if (targetId === null) return { kind: 'none' }

  const playingIdx = combined.indexOf(targetId)
  const rescue = playingIdx < 0
  const userQueueAfter = rescue ? [targetId, ...userQueue] : userQueue

  // Wrap beats repoint (the old code's wrap write ran last). In the rescue
  // case userQueue[0] is the rescued row — the wrap lands on it at index 0.
  if (!advanced && loopMode === 'all' && userQueueAfter.length > 0) {
    const wrapIdx = combined.indexOf(userQueueAfter[0])
    return { kind: 'wrap', index: wrapIdx >= 0 ? wrapIdx : 0 }
  }

  if (rescue) return { kind: 'rescue', userQueue: userQueueAfter }
  if (activeIndex !== playingIdx) return { kind: 'repoint', index: playingIdx }
  return { kind: 'none' }
}