/**
 * Pure stale-id pending-edit re-link decisions (2026-09-26).
 *
 * A Navidrome id migration (the 0.64 re-encode is the proven case) re-encodes
 * every internal id while scan timestamps survive, so a pending_sync metadata
 * row — the user's unpushed rating/loved edit — can outlive its own track id
 * and become an ORPHAN. `pruneStaleMetadata` deliberately keeps pending
 * orphans (never silently destroy an unpushed edit), which is why the Push
 * dialog could show raw `navidrome-…` ids with no name behind them.
 *
 * This module decides HOW an orphan can be RE-LINKED to the id the same track
 * carries after the migration, before anyone reaches for the discard ×. Two
 * evidence sources, tried in order:
 *
 *  1. PATH — the orphan's stamped `webdavPath` still identifies the FILE on
 *     the user's server; ids change, the file does not. The path's OWNER is
 *     whoever the scanner's own row binding says: exactly ONE live metadata
 *     row bound to that path, on the CURRENT server base (`webdavBase` equals
 *     the caller-computed `webdavBaseKey`), synced, not ignored. Uniqueness
 *     is what makes the claim safe — two rows on one path means the evidence
 *     is unsettled, never a pick. (Namespace note: `webdavPath` values are
 *     ONLY compared against other `webdavPath` values — never against the
 *     library's `navidromePath`, a different server's path scheme.)
 *  2. METADATA — when the orphan never had a path (or lost it), fall back to
 *     the track's own identity (title + artist, CJK-safe via the canonical
 *     normalizeForMatch fold). The edit survives; the BINDING is left as the
 *     live target row already had it (identity evidence never re-stamps a
 *     path — the next scan re-matches the track normally).
 *
 * The RELINK-NEVER-DEMOTE rules are absolute, here and in every caller:
 *  - only `pending_sync` rows participate (synced orphans are pruned
 *    elsewhere — there is nothing to preserve);
 *  - a live row that is itself pending is NEVER overwritten (its edit wins —
 *    two conflicting edits resolve as NO-CONSENSUS residue, not silently);
 *  - an `ignored` live row is never re-linked onto (the user's dismissal);
 *  - ambiguity is never resolved by a coin flip: a tie lands in the residue.
 */

import { normalizeForMatch } from './matchNormalize'

/** The orphan surface this decision reads (LocalMetadataStore satisfies it). */
export interface PendingRelinkOrphan {
  trackId: string
  rating: number
  loved: boolean
  syncStatus?: string
  webdavPath?: string
  /** The binding's server stamp — a stale-base orphan's path names a file on
   *  a DIFFERENT server, so it can never be claimed for the current one. */
  webdavBase?: string
  /** Optional display identity — stamped onto pending rows at commit time
   *  (2026-09-26). Only claimed when the caller supplies one: commit-time
   *  stamping covers rows edited SINCE the snapshot landed, so legacy
   *  path-less rows still have none and stay residue rather than being
   *  claimed blindly. */
  title?: string
  artist?: string
}

/** The live-row surface: what the new-id row already holds. */
export interface PendingRelinkLive {
  trackId: string
  rating: number
  loved: boolean
  syncStatus?: string
  ignored?: boolean
  webdavPath?: string
  /** `baseUrl|user` the binding was stamped against — a same-path row on a
   *  DIFFERENT server is not a candidate owner for the current server. */
  webdavBase?: string
}

/** The live-track surface: identity, from the library. */
export interface PendingRelinkTrack {
  trackId: string
  title: string
  artist?: string
  album?: string
}

export interface PendingRelinkMove {
  /** The stale id whose row dies; its edit moves onto `toTrackId`. */
  fromTrackId: string
  toTrackId: string
  which: 'path' | 'metadata'
}

export interface PendingRelinkDecision {
  moves: PendingRelinkMove[]
  /** Orphans that could not be re-linked — the dialog's discard candidates. */
  unmatchedTrackIds: string[]
}

/**
 * Decide, for every pending orphan, whether a live track can PROVE it is the
 * same song after the migration. `currentBaseKey` is the caller's
 * `webdavBaseKey(url, user)` — path evidence only counts bindings stamped on
 * THAT server. Purity contract: `orphanOf` supplies the orphan's metadata row
 * (the caller owns the store read) so the decision is injectable and
 * unit-testable without Dexie.
 */
export function planPendingRelink(
  orphans: string[],
  tracks: PendingRelinkTrack[],
  liveRows: ReadonlyMap<string, PendingRelinkLive>,
  orphanOf: (trackId: string) => PendingRelinkOrphan | undefined,
  currentBaseKey: string,
): PendingRelinkDecision {
  // Path-owner index: CURRENT-server bindings only — a same-path row left
  // over from an old server must neither claim nor suppress ownership here.
  const liveRowsByPath = new Map<string, PendingRelinkLive[]>()
  for (const row of liveRows.values()) {
    if (!row.webdavPath || row.webdavBase !== currentBaseKey) continue
    const list = liveRowsByPath.get(row.webdavPath)
    if (list) list.push(row)
    else liveRowsByPath.set(row.webdavPath, [row])
  }

  // Metadata evidence index: normalized title+artist → tracks. Two live
  // tracks sharing a fold (a title reused across albums/versions) can never
  // be disambiguated from the orphan's row — that tie is residue.
  const byFold = new Map<string, PendingRelinkTrack[]>()
  for (const t of tracks) {
    const key = foldOf(t)
    if (!key) continue
    const list = byFold.get(key)
    if (list) list.push(t)
    else byFold.set(key, [t])
  }

  const moves: PendingRelinkMove[] = []
  const unmatchedTrackIds: string[] = []
  for (const orphanId of orphans) {
    const orphan = orphanOf(orphanId)
    // Callers only feed pending orphans, but a stale snapshot could race a
    // concurrent flatten — never re-link a row that no longer carries an
    // unpushed edit (the prune would have handled it; defensive, not dead).
    if (!orphan || orphan.syncStatus !== 'pending_sync') continue

    // 1. PATH evidence — exact, the file never changed. The owner is the
    //    UNIQUE current-server row bound to that path (the scanner's own
    //    claim rule), excluding ignored rows. Uniqueness is the proof; a
    //    second same-path row means unsettled evidence, never a pick.
    //    Namespace note: webdavPath values are compared ONLY against other
    //    webdavPath values — the library's navidromePath is a different
    //    server's path scheme and is never a witness here.
    const orphanPath = orphan.webdavPath
    if (orphanPath) {
      // The orphan's binding must be THIS server's too: a same RELATIVE path
      // can exist on a different server, and an old-server stamp is not
      // evidence about the current server's files. Such an orphan keeps its
      // edit (the keep rule) — Push will report it wrong-server, which is
      // the honest classification.
      if (orphan.webdavBase !== undefined && orphan.webdavBase !== currentBaseKey) {
        unmatchedTrackIds.push(orphanId)
        continue
      }
      const owners = (liveRowsByPath.get(orphanPath) ?? []).filter((r) => !r.ignored && r.trackId !== orphanId)
      if (owners.length === 1) {
        const owner = owners[0]
        if (owner.syncStatus !== 'pending_sync') {
          moves.push({ fromTrackId: orphanId, toTrackId: owner.trackId, which: 'path' })
          continue
        }
        // A live pending edit on the candidate owner: the orphan is its own
        // residue — no merge, the newer edit wins by being on the live row.
        unmatchedTrackIds.push(orphanId)
        continue
      }
      // Path stamped but not provable → fall through to metadata evidence?
      // NO: a stamped path is stronger identity than title text — if the
      // file's owner cannot be established, claiming a track by title could
      // move the edit onto a DIFFERENT file's song. Leave it as residue.
      unmatchedTrackIds.push(orphanId)
      continue
    }

    // 2. METADATA evidence — title+artist fold matches EXACTLY one live
    //    track whose own row is not itself pending. Only claimed when the
    //    caller supplied the orphan's identity — rows edited before the
    //    commit-time snapshot (2026-09-26) carry none, so those path-less
    //    orphans stay residue rather than being claimed blindly.
    const key = foldOf({ title: orphan.title ?? '', artist: orphan.artist })
    if (key) {
      const candidates = (byFold.get(key) ?? []).filter((t) => {
        const live = liveRows.get(t.trackId)
        return !live?.ignored && live?.syncStatus !== 'pending_sync'
      })
      if (candidates.length === 1) {
        moves.push({ fromTrackId: orphanId, toTrackId: candidates[0].trackId, which: 'metadata' })
        continue
      }
    }
    unmatchedTrackIds.push(orphanId)
  }
  return { moves, unmatchedTrackIds }
}

function foldOf(t: { title: string; artist?: string }): string | null {
  const title = normalizeForMatch(t.title)
  if (!title) return null
  const artist = t.artist ? normalizeForMatch(t.artist) : ''
  return `${title}|${artist}`
}
