import { get } from 'svelte/store'
import { settings, metadataCache, updateMetadata } from '../stores/appState'
import type { Track } from '../stores/appState'
import type { LocalMetadataStore } from '../lib/db'
import { getAllMetadata } from '../lib/db'
import { getCachedConfig, setNavidromeRating, setNavidromeStarred } from './navidromeApi'

/**
 * Single place where rating/loved changes from the UI are committed. Routes to the
 * configured source of truth:
 *
 *  - `ratingSource: 'navidrome'` — Navidrome is authoritative. Writes go straight to
 *    the server (setRating/star/unstar). The local metadata cache is updated only for
 *    in-memory display and is normally NOT marked `pending_sync` (tags on disk are
 *    never touched) — unless `writeTagsInNavidromeMode` is enabled, in which case the
 *    row is ALSO kept `pending_sync` so Push Changes writes the tag to the WebDAV file
 *    (MusicBee sees phone edits). Rows without a `webdavPath` just count as skipped.
 *  - `ratingSource: 'webdav'` — local files are authoritative. The change is cached in
 *    Dexie marked `pending_sync` (pushed to file tags by the Push Changes / scan path).
 *    When `syncToNavidrome` is additionally enabled, the same change is ALSO mirrored
 *    to the Navidrome server as a convenience (e.g. to seed ring/recc roughness).
 */

export function commitFeedback(track: Track, rating: number, loved: boolean): void {
  const source = get(settings).ratingSource ?? 'webdav'
  const syncToNavidrome = get(settings).syncToNavidrome ?? false
  const writeTags = get(settings).writeTagsInNavidromeMode ?? false

  if (source === 'navidrome') {
    const existing = get(metadataCache).get(track.trackId)
    const meta: LocalMetadataStore = {
      trackId: track.trackId,
      rating,
      loved,
      fileType: track.fileType,
      syncStatus: writeTags ? 'pending_sync' : 'synced',
      lastModifiedLocally: Date.now(),
      comments: existing?.comments ?? track.comments,
      webdavPath: existing?.webdavPath,
      webdavLastModified: existing?.webdavLastModified,
      webdavBase: existing?.webdavBase,
      // The full-row replace must not drop matching intent: a rating edit on a
      // dismissed or manually-bound track would otherwise un-ignore it / lose
      // the manual-bind marker and let the next scan re-match it (D8).
      matchSource: existing?.matchSource,
      ignored: existing?.ignored,
    }
    updateMetadata(meta)
    // prevRating lets the mirror clear a prior rating when it's actually being
    // cleared (rating 0 with a nonzero prior local value) without wiping a
    // server-side rating a track just gets a ♥ for.
    void pushToNavidrome(track, rating, loved, existing?.rating ?? 0)
    return
  }

  // webdav source of truth
  const existing = get(metadataCache).get(track.trackId)
  const meta: LocalMetadataStore = {
    trackId: track.trackId,
    rating,
    loved,
    fileType: track.fileType,
    syncStatus: 'pending_sync',
    lastModifiedLocally: Date.now(),
    comments: existing?.comments ?? track.comments,
    webdavPath: existing?.webdavPath,
    webdavLastModified: existing?.webdavLastModified,
    webdavBase: existing?.webdavBase,
    // See the navidrome branch: the full-row replace must preserve matching
    // intent (dismissal + manual-bind marker), never drop it on an edit.
    matchSource: existing?.matchSource,
    ignored: existing?.ignored,
  }
  updateMetadata(meta)

  if (syncToNavidrome) {
    void pushToNavidrome(track, rating, loved, existing?.rating ?? 0)
  }
}

/** Mirrors the raw user value to the Subsonic server (star + rating, halves folded). */
async function pushToNavidrome(track: Track, rating: number, loved: boolean, prevRating: number): Promise<void> {
  const config = getCachedConfig()
  if (!config) return
  const songId = navSongId(track.trackId)
  if (!songId) return
  try {
    await setNavidromeStarred(config, [songId], loved)
    // Subsonic uses a 1–5 integer star scale; fold local 0–100 onto it.
    // Rating 0 removes the rating — pushed only when a prior rating is actually
    // being cleared, so an unrated track receiving a ♥ keeps its server state.
    if (rating > 0) {
      const star = Math.min(5, Math.max(1, Math.round(rating / 20)))
      await setNavidromeRating(config, songId, star)
    } else if (prevRating > 0) {
      await setNavidromeRating(config, songId, 0)
    }
  } catch {
    // Server unreachable — the local state remains authoritative for webdav mode;
    // for navidrome mode the UI is optimistic and the store is refetched on next scan.
  }
}

/** Strips the navidrome- prefix; returns null for WebDAV-backed tracks. */
function navSongId(trackId: string): string | null {
  return trackId.startsWith('navidrome-') ? trackId.replace(/^navidrome-/, '') : null
}

/**
 * One-shot reconcile used when `syncToNavidrome` is first enabled: diffs every
 * locally cached Navidrome-backed track against its server state by pushing the
 * local rating/loved value. Batch-unstars are not performed (a server value
 * already matches a cleared local heart would need full scans both ways).
 * Returns diagnostic counts for the settings UI.
 */
export async function reconcileToNavidrome(): Promise<{ pushed: number; cleared: number; skipped: number }> {
  const config = getCachedConfig()
  if (!config) return { pushed: 0, cleared: 0, skipped: 0 }

  const all = await getAllMetadata()
  const targets: { id: string; rating: number; loved: boolean }[] = []
  for (const m of all) {
    const id = navSongId(m.trackId)
    if (!id) continue
    if (m.rating > 0 || m.loved) targets.push({ id, rating: m.rating, loved: m.loved })
  }

  const loveIds = targets.filter((t) => t.loved).map((t) => t.id)
  let pushed = 0
  let skipped = 0
  try {
    if (loveIds.length > 0) {
      await setNavidromeStarred(config, loveIds, true)
      pushed += loveIds.length
    }
    for (const t of targets) {
      if (t.rating > 0) {
        const star = Math.min(5, Math.max(1, Math.round(t.rating / 20)))
        await setNavidromeRating(config, t.id, star)
        pushed += 1
      } else {
        skipped += 1
      }
    }
  } catch {
    // Partial fail — leave counts as-is; the UI reports the error path.
  }
  return { pushed, cleared: 0, skipped }
}