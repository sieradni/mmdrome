/**
 * Queue occurrence identity — the one module that says what a queue ROW is.
 *
 * A queue row is an OCCURRENCE: `(section, trackId, ordinal-within-that-id)`.
 * The same track may appear any number of times in either section (D3, the
 * 2026-10-21 queue redesign), so an id alone cannot name a row: removal,
 * drag, the native `queueEntryId` echo and the Svelte each-key all need the
 * occurrence.
 *
 * Two canonical renderings of one occurrence:
 *  - `entryId` — the transport/bridge identity: `user:<id>` for the first
 *    copy, `user:<id>#<n>` for every later one (n = 0-based ordinal; the
 *    design's `a:`/`user:` prefix is what Swift echoes back verbatim).
 *  - `rowKey` — the Svelte each-key: `u-<id>#<n>` / `a-<id>#<n>`.
 * Neither contains the row's combined POSITION. The 2026-09-23 regression
 * (`u-${i}-${id}`) destroyed and re-created every row's DOM on each advance,
 * re-arming every cover; position is data-stamped (`originalCombinedIdx`) for
 * drag/play, never part of the key. The ordinal changes only when a same-id
 * copy ABOVE this one is added or removed.
 *
 * Parsing note: a track id whose last characters are `#<digits>` is only
 * ambiguous for the ordinal-0 form. `parseEntryId` splits the suffix and the
 * callers (`findEntryIndex`, the native resolver) VALIDATE the result against
 * the actual queue arrays, so a miss degrades to the id-based fallback and can
 * never bind the wrong row.
 *
 * Pure and DOM/Dexie-free (design rule F2): unit-tested in
 * tests/queueOccurrence.test.ts.
 */


export type QueueSection = 'user' | 'auto'

export const USER_SECTION: QueueSection = 'user'
export const AUTO_SECTION: QueueSection = 'auto'

/** One queue row: which section, which track, which copy of it. */
export interface QueueOccurrence {
  section: QueueSection
  trackId: string
  /** 0-based ordinal of `trackId` within `section`. */
  ordinal: number
}

const ENTRY_PREFIX: Record<QueueSection, string> = { user: 'user', auto: 'auto' }
const KEY_PREFIX: Record<QueueSection, string> = { user: 'u', auto: 'a' }

/** Bridge/transport identity for an occurrence. Ordinal 0 keeps the legacy
 *  bare shape so older single-copy snapshots and lock-screen echoes still
 *  resolve; later copies are suffix-distinguished. */
export function entryIdOf(section: QueueSection, trackId: string, ordinal: number): string {
  return ordinal > 0 ? `${ENTRY_PREFIX[section]}:${trackId}#${ordinal}` : `${ENTRY_PREFIX[section]}:${trackId}`
}

/** Svelte each-key for an occurrence. Occurrence-scoped, position-free. */
export function rowKeyOf(section: QueueSection, trackId: string, ordinal: number): string {
  return `${KEY_PREFIX[section]}-${trackId}#${ordinal}`
}

/** Inverse of `entryIdOf` (see the parsing note above — callers validate). */
export function parseEntryId(entry: string): QueueOccurrence | null {
  const prefix = entry.startsWith('user:') ? 'user' : entry.startsWith('auto:') ? 'auto' : null
  if (!prefix) return null
  const rest = entry.slice(prefix.length + 1)
  const suffix = /^(.*?)#(\d+)$/.exec(rest)
  if (suffix) return { section: prefix, trackId: suffix[1], ordinal: Number(suffix[2]) }
  return { section: prefix, trackId: rest, ordinal: 0 }
}

/** Every occurrence in a section, in order. */
export function sectionOccurrences(ids: readonly string[], section: QueueSection): QueueOccurrence[] {
  const seen = new Map<string, number>()
  return ids.map((trackId) => {
    const ordinal = seen.get(trackId) ?? 0
    seen.set(trackId, ordinal + 1)
    return { section, trackId, ordinal }
  })
}

/** Every occurrence's entry id, in order — the bridge snapshot's identity. */
export function sectionEntryIds(ids: readonly string[], section: QueueSection): string[] {
  return sectionOccurrences(ids, section).map((o) => entryIdOf(o.section, o.trackId, o.ordinal))
}

/** Combined entry ids (`[...userQueue, ...autoQueue]` occurrences). */
export function combinedEntryIds(user: readonly string[], auto: readonly string[]): string[] {
  return [...sectionEntryIds(user, 'user'), ...sectionEntryIds(auto, 'auto')]
}

export function sameOccurrence(a: QueueOccurrence, b: QueueOccurrence): boolean {
  return a.section === b.section && a.trackId === b.trackId && a.ordinal === b.ordinal
}

/** Index of the `ordinal`-th occurrence of `trackId` inside one section. */
export function indexOfOccurrence(ids: readonly string[], trackId: string, ordinal: number): number {
  let seen = 0
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== trackId) continue
    if (seen === ordinal) return i
    seen++
  }
  return -1
}

/** Section-local index of an exact occurrence, or −1 when that copy is gone. */
export function sectionIndexOf(ids: readonly string[], occurrence: QueueOccurrence): number {
  return indexOfOccurrence(ids, occurrence.trackId, occurrence.ordinal)
}

/** Combined index of an exact occurrence, or −1 when that copy is gone. */
export function findOccurrenceIndex(
  user: readonly string[],
  auto: readonly string[],
  occurrence: QueueOccurrence,
): number {
  if (occurrence.section === 'user') return sectionIndexOf(user, occurrence)
  const idx = sectionIndexOf(auto, occurrence)
  return idx < 0 ? -1 : user.length + idx
}

/** Combined index of the occurrence named by an entry id, or −1. */
export function findEntryIndex(user: readonly string[], auto: readonly string[], entryId: string): number {
  const occurrence = parseEntryId(entryId)
  if (!occurrence) return -1
  // Validate the parse against the arrays: a track id ending in `#<digits>`
  // must still round-trip through the entry id it actually produced.
  const sectionIds = occurrence.section === 'user' ? user : auto
  if (indexOfOccurrence(sectionIds, occurrence.trackId, occurrence.ordinal) < 0) return -1
  return findOccurrenceIndex(user, auto, occurrence)
}

/** The occurrence at a combined index, or null when nothing is there. */
export function occurrenceAt(
  user: readonly string[],
  auto: readonly string[],
  combinedIndex: number,
): QueueOccurrence | null {
  if (combinedIndex < 0) return null
  if (combinedIndex < user.length) {
    const trackId = user[combinedIndex]
    return trackId === undefined ? null : { section: 'user', trackId, ordinal: ordinalAt(user, combinedIndex) }
  }
  const autoIndex = combinedIndex - user.length
  const trackId = auto[autoIndex]
  return trackId === undefined ? null : { section: 'auto', trackId, ordinal: ordinalAt(auto, autoIndex) }
}

function ordinalAt(ids: readonly string[], index: number): number {
  const trackId = ids[index]
  let ordinal = 0
  for (let i = 0; i < index; i++) if (ids[i] === trackId) ordinal++
  return ordinal
}

/** The occurrence at a combined index, as a stable entry id (null when empty). */
export function entryIdAt(user: readonly string[], auto: readonly string[], combinedIndex: number): string | null {
  const occurrence = occurrenceAt(user, auto, combinedIndex)
  return occurrence ? entryIdOf(occurrence.section, occurrence.trackId, occurrence.ordinal) : null
}

/** Per-id occurrence counts for one section (the drag-reconcile budget). */
export function occurrenceCounts(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
}

/** Bounds-checked stored anchor: an index that does not name a row becomes −1.
 *  Used by restore, where the stored index is exact because restore keeps the
 *  persisted rows verbatim (D13). */
export function clampStoredActiveIndex(stored: number, total: number): number {
  return Number.isInteger(stored) && stored >= 0 && stored < total ? stored : -1
}
