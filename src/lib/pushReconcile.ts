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
 * never written), a `comments` change (never written by the PUT at all), or a
 * dismissal / match-source flip (File Matching intent) was silently flattened
 * to `synced` with the stale values. This module diffs every user-intent +
 * file-identity field the flatten would clobber:
 *
 *  - `rating`/`loved` — the values the PUT wrote; a newer edit must stay pending.
 *  - `webdavPath`/`webdavBase` — a re-bind re-points the row at a different
 *    file; the pushed PUT targeted the OLD path, so the row must be re-pushed.
 *  - `comments` — scan-extracted and never written by the PUT; flattening the
 *    stale snapshot would clobber a live comment.
 *  - `matchSource` — a manual bind sets `'manual'` (and scans can clear it);
 *    flattening would re-stamp the stale marker and let a scan re-match a
 *    binding the user just made or revoked.
 *  - `ignored` — a dismissal (`ignoreTrack` sets `ignored: true` WITHOUT
 *    clearing syncStatus or path); flattening would silently un-ignore the row
 *    so the next scan re-matches and re-pushes it.
 *
 * `syncStatus` is NOT compared (the caller keys on it: the snapshot is always
 * `pending_sync`, and the live row is only kept pending when it is STILL
 * `pending_sync` — a concurrent flatten elsewhere means there is no live edit
 * to preserve). `fileType` is deliberately excluded (the cache row's fileType
 * is stale by design — the library Track is authoritative, D12), as is
 * `webdavLastModified` (a scan-updated cache, re-detected on the next scan —
 * not user intent).
 */

/** The row surface this decision reads (LocalMetadataStore satisfies it). */
export interface PushRowSnapshot {
  rating: number
  loved: boolean
  syncStatus?: string
  webdavPath?: string
  webdavBase?: string
  comments?: string
  matchSource?: 'auto' | 'manual'
  ignored?: boolean
}

/**
 * True when the LIVE row carries an edit the pushed snapshot does not cover
 * and must therefore stay `pending_sync` instead of being flattened to
 * `synced` with the stale values. False (flatten) when there is no live row,
 * the live row is no longer pending, or the live row matches the snapshot on
 * every user-intent/identity field.
 */
export function shouldKeepPushPending(stale: PushRowSnapshot, live: PushRowSnapshot | undefined): boolean {
  if (!live) return false
  if (live.syncStatus !== 'pending_sync') return false
  return (
    live.rating !== stale.rating ||
    live.loved !== stale.loved ||
    live.webdavPath !== stale.webdavPath ||
    live.webdavBase !== stale.webdavBase ||
    live.comments !== stale.comments ||
    live.matchSource !== stale.matchSource ||
    live.ignored !== stale.ignored
  )
}

/**
 * Pure pre-PUT re-check (TODO 3.9). `runManualWebDAVSync` loops over a
 * START-of-loop snapshot; between that snapshot and the GET→PUT the user may
 * re-bind the row (new `webdavPath`), dismiss it (`ignored`), clear its path,
 * or swap credentials (new `currentBaseKey`) — writing tags to the OLD target
 * would be wrong, and the POST-PUT re-pend (3.1) cannot undo the write. True =
 * abort this row's PUT (the caller un-marks its path and skips, without
 * counting synced). `undefined` live row = no live edit, proceed.
 */
export function shouldSkipBeforePut(stale: PushRowSnapshot, live: PushRowSnapshot | undefined, currentBaseKey: string): boolean {
  if (!live) return false
  if (!live.webdavPath) return true
  if (live.ignored) return true
  if (live.webdavPath !== stale.webdavPath) return true
  if (live.webdavBase !== currentBaseKey) return true
  return false
}
