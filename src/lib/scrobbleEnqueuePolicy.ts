/**
 * The enqueue outcome policy for the durable pending-scrobble queue
 * (A3, 2026-10-09).
 *
 * Why this tiny module exists: the 2026-10-08 dump showed 20 unhandled Dexie
 * `AbortError` rejections across 13/17 track advances, and `enqueuePendingScrobble`
 * collapsed EVERY error into `false` — which every consumer reads as "already
 * queued" (a deliberate no-op). An aborted write therefore looked exactly like a
 * duplicate, and the Listen was dropped with no trace anywhere.
 *
 * Only the unique-index violation is a duplicate. Everything else (an aborted
 * transaction above all) is a failure that must be retried and, if it still
 * fails, named in the debug ring. Pure so the classification is pinned in Node
 * without Dexie.
 */
export function isDuplicateEnqueueError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConstraintError'
}
