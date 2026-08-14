/**
 * Pure Push re-pend decision (TODO 3.1).
 *
 * `runManualWebDAVSync` pushes each pending row's rating/loved to its WebDAV
 * file via a GET → modify → PUT round-trip. The loop captures the row snapshot
 * BEFORE that round-trip, so a user edit or File Matching re-bind landing
 * mid-flight makes the snapshot stale. After a successful PUT the loop either
 * flattens the snapshot to `synced` (writing it back to Dexie) or keeps the
 * LIVE row pending for the next Push.
 *
 * Flattening writes the WHOLE stale snapshot back — so any live field the PUT
 * did not cover would be lost. The old comparison only diffed `rating`/`loved`
 * (the two fields the PUT actually writes); a mid-push re-bind (new
 * `webdavPath`/`webdavBase` — the PUT went to the OLD file, the NEW file was
 * never written) or a `comments` change (never written by the PUT at all) was
 * silently flattened to `synced` with the stale values. This module widens the
 * comparison to the user-intent + file-identity fields:
 *
 *  - `rating`/`loved` — the values the PUT wrote; a newer edit must stay pending.
 *  - `webdavPath`/`webdavBase` — a re-bind re-points the row at a different
 *    file; the pushed PUT targeted the OLD path, so the row must be re-pushed.
 *  - `comments` — scan-extracted and never written by the PUT; flattening the
 *    stale snapshot would clobber a live comment.
 *
 * `syncStatus` is NOT compared (the caller keys on it: the snapshot is always
 * `pending_sync`, and the live row is only kept pending when it is STILL
 * `pending_sync` — a concurrent flatten elsewhere means there is no live edit
 * to preserve). `fileType` is deliberately excluded (the cache row's fileType
 * is stale by design — the library Track is authoritative, D12).
 */

/** The row surface this decision reads (LocalMetadataStore satisfies it). */
export interface PushRowSnapshot {
  rating: number
  loved: boolean
  syncStatus?: string
  webdavPath?: string
  webdavBase?: string
  comments?: string
}

/**
 * True when the LIVE row carries an edit the pushed snapshot does not cover
 * and must therefore stay `pending_sync` instead of being flattened to
 * `synced` with the stale values. False (flatten) when there is no live row,
 * the live row is no longer pending, or the live row matches the snapshot on
 * every pushed/identity field.
 */
export function shouldKeepPushPending(stale: PushRowSnapshot, live: PushRowSnapshot | undefined): boolean {
  if (!live) return false
  if (live.syncStatus !== 'pending_sync') return false
  return (
    live.rating !== stale.rating ||
    live.loved !== stale.loved ||
    live.webdavPath !== stale.webdavPath ||
    live.webdavBase !== stale.webdavBase ||
    live.comments !== stale.comments
  )
}
