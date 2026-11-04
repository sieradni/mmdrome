import { writable, get, derived } from 'svelte/store'
import type { LocalMetadataStore } from '$lib/db'
import type { NoMatchReason } from '$lib/metadataCore'
import type { PushRunReport } from '$lib/pushOutcome'
import { getSetting, setSetting, getQueue, getAllMetadata, upsertMetadata, bulkUpsertMetadata, bulkDeleteMetadata, reopenDatabase } from '$lib/db'
import { clampStoredActiveIndex } from '$lib/queueOccurrence'
import { describeStorageError, planStorageInitAttempt, STORAGE_INIT_MAX_ATTEMPTS } from '$lib/storageHealth'
import { persistQueue } from '$lib/queuePersistence'
import { persisted, type PersistedValue } from '$lib/persistedStore'
import { sanitizeRecent } from '$lib/recentWindow'
import {
  EMPTY_SORT,
  isRandomSort,
  normalizeSort,
  planRandomToggle,
  type SortState,
} from '$lib/sortCore'
import { clampRecentLimit, RECENT_LIMIT, RECENT_LIMIT_MAX, RECENT_LIMIT_MIN } from '$lib/recentWindow'
import { planPendingRelink } from '$lib/pendingRelink'
import { dbgAlways, dbgDanger } from '$lib/debugLog'
import { DEFAULT_LOVE_POLICY } from '$lib/scrobbleLove'
import { decodeFilterPresets, type FilterPreset } from '$lib/filterPresets'
import { decodeFilterRuleSet, emptyFilterRuleSet, type FilterRuleSet } from '$lib/filterCore'
import type { ConnectFailure } from '$lib/authHealth'

export type PlaybackState = 'playing' | 'paused' | 'stopped' | 'buffering'

export interface Track {
  trackId: string
  title: string
  artist: string
  album: string
  albumId?: string
  year?: number
  duration: number
  fileType: "mp3" | "flac" | "m4a" | "ogg" | "opus" | "wav" | "aac" | "aiff" | "wma"
  composer?: string
  bitrate?: number
  size?: number
  createdAt?: number
  navidromePath?: string
  /** Navidrome's hash-suffixed artwork id (`mf-<id>_<16hex>`, from the Subsonic
   *  `coverArt` attribute — captured verbatim at sync). Requesting covers with
   *  it unlocks the server's `immutable` year-long cache (no revalidation
   *  round trip on re-entry after an unlatch); absent on other servers, where
   *  URL construction falls back to the plain id. Sanitization lives in
   *  `requestableCoverArtId` — consumers never regex the raw field. */
  coverArtId?: string
  replayGain?: number
  albumReplayGain?: number
  albumArtist?: string
  trackNumber?: number
  comments?: string
  genre?: string
  starred?: boolean
  userRating?: number
}

export interface TrackWithMeta extends Track {
  rating: number
  loved: boolean
}

export interface QueueState {
  userQueue: string[]
  autoQueue: string[]
  /** Bounded LRU anti-repeat window (played/skipped/removed tracks), newest last. Owned by queueManager. */
  recentTrackIds: string[]
  activeIndex: number
}

export interface MetadataScanProgress {
  scanned: number
  total: number
  failed: number
  /** Rows with no confident WebDAV candidate after matching. */
  notFound: number
  /** Rows whose previously-matched WebDAV file vanished (path cleared, re-matchable). */
  missing: number
  /** Rows with multiple equally-scored candidates — left untouched. */
  duplicateMatches: number
  /** Tracks auto-bound by the scan's tag-probe phase (in-file identity tags
   *  matched before the drain ran). These rows never enter the drain queue,
   *  so without this count a probe-heavy scan reads as "0 scanned". Set only
   *  when > 0. */
  probeMatched?: number
  /** NoMatchReason → count over the scan's no-safe-match rows — the WHY
   *  breakdown behind `notFound` (tags-contradict / not-probed / weak-evidence
   *  / …), the same taxonomy the File Matching rows show. Set only when
   *  non-empty. */
  noMatchReasons?: Partial<Record<NoMatchReason, number>>
  /** AUTO links a FORCE scan released because the bound file's own tags proved
   *  them wrong (D16 heal), then re-matched by the same scan. Set only when > 0. */
  released?: number
  /** Human label of the active scan ("Scanning all files..."/"Scanning changed files..."). */
  annotation?: string
  /** Set on a CANCELLED scan's landing (cancelScan). Holds the interrupted
   *  scan's shape so the UI can offer a one-click "Resume scan" that re-runs
   *  the SAME shape — a cancelled force scan must resume as force (its heal
   *  pass only runs there), a cancelled modified scan as modified. Absence
   *  = the scan was not cancelled. Cleared by the next scan state write. */
  cancelledShape?: 'modified' | 'force'
}

export interface MetadataScanState {
  status: 'idle' | 'scanning' | 'complete' | 'error'
  progress: MetadataScanProgress
  error?: string
}

export interface SettingsMap {
  preloadTracks?: number
  crossfadeDuration?: number
  webdavUrl?: string
  webdavUser?: string
  webdavToken?: string
  navidromeUrl?: string
  navidromeUser?: string
  navidromePassword?: string
  replayGainMode?: 'off' | 'track' | 'album'
  scrobbling?: boolean
  ratingSource?: 'webdav' | 'navidrome'
  syncToNavidrome?: boolean
  writeTagsInNavidromeMode?: boolean
  /** Direct-scrobbler toggles — govern ALL outbound activity of that service (plays + hearts). */
  lastfmScrobbling?: boolean
  listenbrainzScrobbling?: boolean
  listenbrainzToken?: string
  /** Love-scrobbling policy (2026-10-21): WHICH local signal marks a track as
   *  loved for Last.fm/ListenBrainz. Independent flags — ♥ only (the historical
   *  behavior), rating only, either, or neither. Read through
   *  `scrobbleLove.ts` `resolveLovePolicy`; never gate hearts on a raw flag. */
  scrobbleLoveFromLoved?: boolean
  scrobbleLoveFromRating?: boolean
  /** Inclusive 0–100 rating cutoff for `scrobbleLoveFromRating`. */
  scrobbleLoveRatingThreshold?: number
  /** BYO Last.fm API credentials override the compiled defaults. */
  lastfmApiKey?: string
  lastfmApiSecret?: string
  /** Low data mode: suppress ALL automatic network work (scans, probes,
   *  auto-preload, scrobble flush, Navidrome scrobbles). Explicit user
   *  actions, streaming, and thumbnails are never gated. */
  lowDataMode?: boolean
  /** Auto-engage low data mode when the connection is cellular/metered
   *  (native: exact via NWPathMonitor; web: Network Information API hint,
   *  never engages on Safari). */
  lowDataOnCellular?: boolean
  /** Server-side transcoding: 'off' | 'lowData' | 'always' (default off). */
  transcodeMode?: 'off' | 'lowData' | 'always'
  /** Target format — free string: the built-ins (opus/mp3/aac/flac) plus any
   *  custom ffmpeg format the server admin defines. Default opus. */
  transcodeFormat?: string
  /** Bitrate cap in kbps for transcoded streams (default 128). */
  transcodeBitrate?: number
  /** Per-format capability-probe verdicts ('ok' | 'unsupported'), persisted
   *  because the probe DOM element never survives a reload. */
  transcodeProbe?: Record<string, 'ok' | 'unsupported'>
  /** iOS native audio-session sharing: 'exclusive' (default — other audio
   *  pauses while mmdrome plays) or 'mix' (plays alongside other apps).
   *  Native only — the PWA has no audio-session API, so Safari owns mixing
   *  there and this key is never read on web. */
  iosAudioMixing?: 'exclusive' | 'mix'
  /** Seek-epoch kill switch (2026-10-07, plan §8): 'auto' (default) lets a
   *  far seek open a server-offset epoch; 'off' reproduces Phase-1 behavior
   *  exactly (position-preserving wait, no extra requests) — the field
   *  rollback for Phases 2-3 without a release. Native only; the web lane
   *  never opens an epoch. */
  seekEpochs?: 'auto' | 'off'
}

export const currentTrack = writable<Track | null>(null)
export const playbackState = writable<PlaybackState>('stopped')
/** Native audio engine surfaced as UNAVAILABLE (2026-10-04): the recovery
 *  ladder retried, rebuilt the graph, and still could not start the engine
 *  (an invalidated AVAudioSession that never recovered). The UI shows a
 *  persistent restart affordance; a successful recovery or an explicit
 *  restart clears it. Always false on web (the PWA engine cannot enter this
 *  state). */
export const engineUnavailable = writable<boolean>(false)
export const queue = writable<QueueState>({ userQueue: [], autoQueue: [], recentTrackIds: [], activeIndex: -1 })
export const settings = writable<SettingsMap>({})
export const metadataCache = writable<Map<string, LocalMetadataStore>>(new Map())
export const library = writable<Track[]>([])
export const webdavConnection = writable<{ connected: boolean; error?: string; checking: boolean; failure?: ConnectFailure }>({ connected: false, checking: false })
export const navidromeConnection = writable<{ connected: boolean; error?: string; checking: boolean; serverVersion?: string; failure?: ConnectFailure }>({ connected: false, checking: false })
export const navidromeLoadStatus = writable<{ loading: boolean; loaded: number; failed: number; error?: string; cached?: boolean; cancelled?: boolean; failure?: ConnectFailure }>({ loading: false, loaded: 0, failed: 0 })
// Engine-bound scalar settings: store-layer persistence via `persisted`, and
// the engine push lives in playbackManager (`_applyPlaybackParams` at restore,
// `_subscribeShared` reactions for the live edges). Restored once in
// `initStores`; the value is only trusted after `restore()` runs.
const _playbackSpeed = persisted<number>('playbackSpeed', 1)
const _pitchOctaves = persisted<number>('pitchOctaves', 0)
const _tapeMode = persisted<boolean>('tapeMode', false)
const _snapTolerance = persisted<number>('snapTolerance', 0.15)
const _masterGain = persisted<number>('masterGain', 1)
const _loopMode = persisted<LoopMode>('loopMode', 'none')
export const currentTime = writable<number>(0)
export const playbackSpeed = _playbackSpeed.store
export const tapeMode = _tapeMode.store
export const snapTolerance = _snapTolerance.store
export const masterGain = _masterGain.store
export const loopMode = _loopMode.store
export const effectiveDuration = derived(
  [currentTrack],
  ([$ct]) => {
    return $ct?.duration ?? 0
  }
)
export const pitchOctaves = _pitchOctaves.store
export const metadataScanState = writable<MetadataScanState>({ status: 'idle', progress: { scanned: 0, total: 0, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0 } })

/** Live progress of the Push run (the confirmation dialog shows it in place
 *  of the confirm/cancel buttons once the run starts). `current` is the
 *  row-level phase: `row N of M — <track title>` while a row is in flight.
 *  `done` counts rows fully settled (pushed, skipped, or failed). */
export interface PushProgress {
  active: boolean
  done: number
  total: number
  current: string
  /** Set by the UI's Cancel; the run's isCancelled polls it and the loop
   *  exits between rows. Cleared when the run settles. */
  cancelRequested?: boolean
}
export const pushState = writable<PushProgress>({ active: false, done: 0, total: 0, current: '' })
/** Durable last completed (or interrupted) WebDAV Push report (W-09). Lives
 *  outside view lifetime and the 1000-entry event ring so navigation and
 *  restarts preserve the batch outcome, stage breakdown, and recovery groups. */
export const lastPushReport = writable<PushRunReport | null>(null)

/**
 * Fields the user edits in the Queue filter panel — persisted via `persisted`.
 * The shared filter RULE SET (rating range + loved + elemental AND clauses,
 * see `filterCore`) plus the auto-only full-text query. Album/artist scopes
 * are session-only and live in `autoQueueScope` (never in this row).
 */
export interface AutoQueueFilterFields extends FilterRuleSet {
  searchQuery?: string
}

/** Session-only auto-queue scoping (B5) — NEVER persisted. */
export interface AutoQueueScope {
  albumScope?: string
  artistScope?: string
}

/**
 * The auto-queue SORT setting: which shared sort key the auto-queue fill
 * follows and in which direction. Persisted via the `persisted()` layer
 * (Dexie userSettings row `autoQueueSort`, restored in initStores).
 *
 * 2026-09-29 decoupling: the fill previously read the SHARED library sort
 * (`libraryFilters.sortBy/sortAsc`) directly — the Songs view's sort silently
 * re-ranked the auto queue. Now the auto queue carries its OWN sort; the
 * library sort is purely a view concern. No migration seeds it from the
 * library sort: existing installs start at library order (user decision), so
 * the apply button appears the moment the two diverge.
 */
export type AutoQueueSort = SortState

/** Initial value: library order, no tiers. */
export const AUTO_QUEUE_SORT_DEFAULT: AutoQueueSort = { ...EMPTY_SORT, tiers: [] }

/**
 * Shape-validating decode for the persisted `autoQueueSort` row. Also migrates
 * the legacy `{sortBy, sortAsc}` pair (and the pre-2026-11-01 `shuffleEnabled`
 * row, see `initStores`) through the shared rules. Always answers a valid state:
 * corrupt rows degrade to "library order", never to junk in the fill planner.
 */
export function decodeAutoQueueSort(raw: unknown): AutoQueueSort {
  return normalizeSort(raw)
}

export type AutoQueueFilters = AutoQueueFilterFields & AutoQueueScope

export type LoopMode = 'none' | 'one' | 'all'

export interface SleepTimerState {
  active: boolean
  mode: 'minutes' | 'endOfTrack'
  minutes: number
  /** Wall-clock timestamp at which the timer fires (minutes mode only). */
  endsAt: number
  /** Current-seconds label used by the now-playing overlay progress ring. */
  remainingSeconds: number
}

export const sleepTimer = writable<SleepTimerState>({
  active: false,
  mode: 'minutes',
  minutes: 30,
  endsAt: 0,
  remainingSeconds: 0,
})

const AUTO_QUEUE_FILTER_DEFAULTS: AutoQueueFilterFields = {
  ...emptyFilterRuleSet(),
  searchQuery: '',
}

/**
 * Coerces a saved `autoQueueFilters` row into the fields shape. Older app
 * versions stored a JSON string under the key; the persisted store now holds
 * the object itself. Returns `undefined` (keep initial) on corrupt input.
 */
export function decodeAutoQueueFilters(raw: PersistedValue | undefined): AutoQueueFilterFields | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' && typeof raw !== 'string') return undefined
  let p: Partial<AutoQueueFilterFields> | null = null
  if (typeof raw === 'string') {
    try {
      p = JSON.parse(raw) as Partial<AutoQueueFilterFields>
    } catch {
      return undefined
    }
  } else {
    p = raw as Partial<AutoQueueFilterFields> | null
  }
  // `null` is typeof 'object' and JSON.parse can return null/arrays/primitives
  // from a corrupt row — any of those must fall back to the initial, not crash
  // (`p.minRating` on null) or spread junk keys (a string/array).
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return undefined
  // The shared decoder also migrates a pre-2026-11-03 row (scalar `genre` /
  // `fromYear` / `toYear` / `minLength` / `maxLength`) into clauses.
  const rules = decodeFilterRuleSet(p)
  return {
    ...rules,
    searchQuery: typeof p.searchQuery === 'string' ? p.searchQuery : undefined,
  }
}

const _autoQueueFilterFields = persisted<AutoQueueFilterFields>('autoQueueFilters', AUTO_QUEUE_FILTER_DEFAULTS, {
  decode: decodeAutoQueueFilters,
})

export const autoQueueFilterFields = _autoQueueFilterFields.store

/** The auto queue's OWN sort (2026-09-29 decoupling): the fill no longer
 *  follows the shared library sort. Persisted, restored in initStores. The
 *  UI hides the sort editor while shuffle is on (shuffle permutes the pool
 *  anyway), but the setting keeps persisting underneath. */
const _autoQueueSort = persisted<AutoQueueSort>('autoQueueSort', AUTO_QUEUE_SORT_DEFAULT, {
  decode: decodeAutoQueueSort,
})

export const autoQueueSort = _autoQueueSort.store

/**
 * Shuffle (2026-11-01): a DERIVED VIEW of the auto-queue sort, not its own
 * setting. "Shuffle on" means the auto queue sorts by random; there is one
 * source of truth, so the button, the sort editor and the fill can never
 * disagree. Turning it on remembers the previous tiers inside the same sort
 * object (`SortState.restore`), which is what makes turning it off return to
 * what it was — across sessions too.
 */
export const shuffleEnabled = derived(autoQueueSort, (s) => isRandomSort(s))

/** How many recent plays the auto queue holds back (2026-11-01). The window is
 *  STORED up to `RECENT_LIMIT_MAX` and this horizon is applied at read time, so
 *  shrinking it and raising it again recovers the history. `0` disables the
 *  cool-down. Read by the manager's fill snapshot; a change rebuilds the tail
 *  WITHOUT resetting the window (a horizon edit, not a new rule set). */
const _autoQueueRecentLimit = persisted<number>('autoQueueRecentLimit', RECENT_LIMIT, {
  decode: (raw) => (typeof raw === 'number' ? clampRecentLimit(raw) : undefined),
})

export const autoQueueRecentLimit = _autoQueueRecentLimit.store

export const AUTO_QUEUE_RECENT_LIMIT_MIN = RECENT_LIMIT_MIN
export const AUTO_QUEUE_RECENT_LIMIT_MAX = RECENT_LIMIT_MAX

/**
 * How many suggestion rows the auto queue holds (2026-11-04). One persisted
 * number, read by the manager at EVERY fill site (`_targetLength`) — a
 * constant here would silently disagree with the setting after the first
 * change. The bounds are enforced by the decoder as well as the writer, so a
 * corrupt or out-of-range IndexedDB row degrades to the nearest usable value
 * instead of a zero-length tail or a 10 000-row fill.
 *
 * Changing it resizes the tail in ONE write (`queueManager.resizeAutoQueue`:
 * trims, never dropping the audible row; otherwise replenishes). It is NOT a
 * rule change — the anti-repeat window survives, like the horizon edit.
 */
export const AUTO_QUEUE_LENGTH_DEFAULT = 50
export const AUTO_QUEUE_LENGTH_MIN = 5
export const AUTO_QUEUE_LENGTH_MAX = 200

export function clampAutoQueueLength(value: number): number {
  if (!Number.isFinite(value)) return AUTO_QUEUE_LENGTH_DEFAULT
  return Math.min(AUTO_QUEUE_LENGTH_MAX, Math.max(AUTO_QUEUE_LENGTH_MIN, Math.round(value)))
}

const _autoQueueLength = persisted<number>('autoQueueLength', AUTO_QUEUE_LENGTH_DEFAULT, {
  decode: (raw) => (typeof raw === 'number' ? clampAutoQueueLength(raw) : undefined),
})

export const autoQueueLength = _autoQueueLength.store

/**
 * Auto-queue on/off (D9, QUEUE-DESIGN §2). Persisted like the other queue
 * settings and restored in `initStores`. OFF means the suggestion source is
 * empty: the manager clears the auto section in one write, suppresses every
 * fill, and never shows the "nothing matches the filters" warning. Auto-off is
 * deliberately the direct form of "the filter matches nothing" so repeat-all
 * has ONE definition (D8). Toggling back on rebuilds through D7's fresh-context
 * write. Read by the manager (the gate) and the queue view (the toggle and the
 * quiet off-state copy); never mirrored into a second store.
 */
const _autoQueueEnabled = persisted<boolean>('autoQueueEnabled', true)

export const autoQueueEnabled = _autoQueueEnabled.store

/**
 * Saved library filter/sort presets (Phase 3A, 2026-10-26). A preset is a
 * NAME plus a snapshot of the shared library view; it is persisted like the
 * other settings and restored in `initStores`. It is deliberately separate
 * from the two queue rule sets: applying a preset only ever writes
 * `libraryFilters`, so a saved view can never re-rank or refill the queue
 * behind the user's back. Every saved row passes `decodeFilterPresets` on the
 * way in — IndexedDB is the trust boundary, not the writer.
 */
const _filterPresets = persisted<FilterPreset[]>('filterPresets', [], {
  decode: decodeFilterPresets,
})

export const filterPresets = _filterPresets.store

/** Session-only auto-queue scoping (B5): set on play from album/artist views,
 *  cleared on shuffle toggle / plain TrackRow play. By construction the scopes
 *  live in their own writable, so they can never leak into the persisted row. */
export const autoQueueScope = writable<AutoQueueScope>({})

/** Combined view for queueManager / playbackManager (fields + session scope). */
export const autoQueueFilters = derived([autoQueueFilterFields, autoQueueScope], ([f, s]) => ({ ...f, ...s }))

/** Set when the non-shuffle auto queue wrapped back to the top of the sort order. */
export const queueWrapNotice = writable<boolean>(false)

/** Set when a fill could not add anything (filters exhausted or inverted) —
 *  cleared by any successful fill. Session-only; the queue view explains why
 *  the auto queue is empty instead of showing nothing at all. */
export const autoQueueEmptyNotice = writable<boolean>(false)

/**
 * D10 skip fact (2026-10-21e): the track id an advance (or a positional pick)
 * moved the anchor onto while the audio is still on the PREVIOUS row. A load
 * takes time, so for a moment `combined[activeIndex] !== currentTrack.trackId`
 * is not "the active row was removed" — it is "the anchor is ahead of the
 * audio". `advanceTargetIndex` reads this to keep a second press advancing
 * instead of re-targeting the row already loading. Cleared as soon as
 * `setCurrentTrack` names that row (the anchor and the audio agree again).
 */
export const pendingAdvanceTrackId = writable<string | null>(null)

export function setLibrary(tracks: Track[], complete = true): void {
  // A full (error-free) library load replaces the source of truth — reconcile
  // the queue and metadata cache against it so stale ids can't stall playback
  // or linger (pending rows are kept: they surface in Push Changes instead of
  // being silently lost).
  if (complete) {
    reconcileQueueWithLibrary(tracks)
    pruneStaleMetadata(tracks)
  }
  library.set(tracks)
}

function reconcileQueueWithLibrary(tracks: Track[]): void {
  const ids = new Set(tracks.map((t) => t.trackId))
  queue.update((q) => {
    const oldCombined = [...q.userQueue, ...q.autoQueue]
    const oldActiveId = q.activeIndex >= 0 && q.activeIndex < oldCombined.length ? oldCombined[q.activeIndex] : undefined

    // Occurrence-preserving prune: filtering by membership keeps EVERY copy of
    // a surviving id (duplicates are legal, D3).
    const userQueue = q.userQueue.filter((id) => ids.has(id))
    const autoQueue = q.autoQueue.filter((id) => ids.has(id))
    const recentTrackIds = q.recentTrackIds.filter((id) => ids.has(id))
    const newCombined = [...userQueue, ...autoQueue]

    // Re-anchor BY COUNT (D13): the audible OCCURRENCE keeps its identity, so
    // subtract exactly the rows removed above it. `indexOf(id)` would land on
    // an earlier copy once the queue holds duplicates — the wrong row.
    let activeIndex = -1
    if (oldActiveId !== undefined && ids.has(oldActiveId)) {
      let removedAbove = 0
      for (let i = 0; i < q.activeIndex; i++) if (!ids.has(oldCombined[i])) removedAbove++
      const candidate = q.activeIndex - removedAbove
      activeIndex = candidate >= 0 && candidate < newCombined.length && newCombined[candidate] === oldActiveId
        ? candidate
        : -1
    }

    // Dump-visible drops: a server ID migration (Navidrome 0.64 re-encoding)
    // zeroes every match at once — a "my queue lost songs" report must be
    // answerable with counts, not silence.
    const droppedUser = q.userQueue.length - userQueue.length
    const droppedAuto = q.autoQueue.length - autoQueue.length
    const droppedRecent = q.recentTrackIds.length - recentTrackIds.length
    if (droppedUser + droppedAuto + droppedRecent > 0) {
      dbgAlways('sync', `queue reconcile: dropped ${droppedUser} user + ${droppedAuto} auto + ${droppedRecent} recent stale ids; activeIndex ${q.activeIndex} → ${activeIndex}`)
    }

    const updated = { userQueue, autoQueue, recentTrackIds, activeIndex }
    persistQueue('initReconcile', updated)
    return updated
  })
}

function pruneStaleMetadata(tracks: Track[]): void {
  const ids = new Set(tracks.map((t) => t.trackId))
  const cache = get(metadataCache)
  const toDelete: string[] = []
  let keptPending = 0
  const remaining = new Map(cache)
  for (const [id, meta] of cache) {
    if (ids.has(id)) continue
    if (meta.syncStatus === 'pending_sync') {
      keptPending += 1
      continue
    }
    remaining.delete(id)
    toDelete.push(id)
  }
  if (toDelete.length > 0) {
    dbgAlways('sync', `metadata GC: pruned ${toDelete.length} orphaned rows${keptPending > 0 ? `, kept ${keptPending} pending_sync (Push Changes)` : ''}`)
    metadataCache.set(remaining)
    void bulkDeleteMetadata(toDelete)
  }
  // The kept pending orphans' RE-LINK attempt is owned by the full-load
  // pipeline (loadLibraryFromNavidrome → relinkPendingMetadata, which knows
  // the CURRENT webdavBaseKey for the path-evidence proof). Kept orphans
  // survive the prune untouched — they surface in Push Changes either way.
}

/**
 * Re-links PENDING orphaned edits onto the track ids the same songs carry
 * after an id migration (the Navidrome 0.64 re-encode): `pruneStaleMetadata`
 * deliberately KEEPS pending orphans (an unpushed edit is never silently
 * destroyed), but a kept orphan is unpushable AND unnameable — the exact
 * raw-id rows the Push dialog showed. Before they reach the dialog, the pure
 * `planPendingRelink` tries to move each one onto its surviving song:
 * PATH evidence first — the orphan's stamped `webdavPath` (the file never
 * changed, only the id) must name a UNIQUE current-server row binding — then
 * title+artist fold evidence. The move NEVER demotes the edit (it stays
 * `pending_sync` — Push still owns it) and never overwrites a live pending
 * row (that conflict stays as an orphan for the dialog's discard ×).
 * `currentBaseKey` (the caller's `webdavBaseKey(url, user)`) confines path
 * evidence to the CURRENT server — stale bindings from an old server can
 * neither claim nor suppress ownership. The moved rows land in Dexie + the
 * in-memory map with the old id's deletion, so a crash between the two legs
 * strands an edit at worst as a pending orphan again (the same state the
 * keep-rule already covers).
 */
export async function relinkPendingMetadata(tracks: Track[], currentBaseKey: string): Promise<{ moved: number; unmatched: number }> {
  const cache = get(metadataCache)
  const ids = new Set(tracks.map((t) => t.trackId))
  const orphanIds = [...cache.keys()].filter((id) => !ids.has(id) && cache.get(id)?.syncStatus === 'pending_sync')
  if (orphanIds.length === 0) return { moved: 0, unmatched: 0 }

  const liveRows = new Map<string, LocalMetadataStore>()
  for (const t of tracks) {
    const row = cache.get(t.trackId)
    if (row) liveRows.set(t.trackId, row)
  }
  const orphanRowsById = new Map(cache)
  const decision = planPendingRelink(
    orphanIds,
    tracks.map((t) => ({ trackId: t.trackId, title: t.title, artist: t.artist, album: t.album })),
    liveRows,
    (id) => orphanRowsById.get(id),
    currentBaseKey,
  )
  if (decision.moves.length === 0) {
    if (decision.unmatchedTrackIds.length > 0) {
      dbgAlways('sync', `pending relink: ${decision.unmatchedTrackIds.length} orphaned edit(s) could not be re-linked — they surface in Push Changes (discard × available)`)
    }
    return { moved: 0, unmatched: decision.unmatchedTrackIds.length }
  }

  const movedIds: string[] = []
  const updatedRows: LocalMetadataStore[] = []
  const next = new Map(cache)
  for (const move of decision.moves) {
    const orphan = cache.get(move.fromTrackId)
    if (!orphan) continue
    // The target must be a LIVE, synced, non-ignored row. On a FIRST
    // post-migration load the new-id rows may not exist yet (no scan has run
    // — but then the orphan's path evidence could not have matched either;
    // metadata-only evidence can). Such orphans stay residue until the scan
    // binds their song and pushChanges re-runs this relink.
    const live = next.get(move.toTrackId)
    if (!live || live.syncStatus === 'pending_sync' || live.ignored) continue
    // File evidence carries the binding over: the same file IS the same
    // song's bytes, so the orphan's path/base/mtime stamps apply to the new
    // id unchanged (Push will write the tags to exactly that file). The
    // guard above (a live row must exist and be synced) keeps the edit
    // pending — the move NEVER demotes or silently merges two edits.
    updatedRows.push({
      ...live,
      rating: orphan.rating,
      loved: orphan.loved,
      comments: orphan.comments ?? live.comments,
      // Path evidence carries the binding over; METADATA evidence must
      // PRESERVE the live row's binding (a title fold never re-stamps or
      // clears a path — `??` keeps the live stamps when the orphan has
      // none; caught by the metadata-lane applier pin).
      webdavPath: orphan.webdavPath ?? live.webdavPath,
      webdavBase: orphan.webdavBase ?? live.webdavBase,
      webdavLastModified: orphan.webdavLastModified ?? live.webdavLastModified,
      matchSource: orphan.matchSource ?? live.matchSource,
      // Keep the identity snapshot current: the moved edit was justified by
      // THIS evidence, so the surviving row carries it forward (the next
      // commit re-stamps from the live track anyway).
      title: orphan.title ?? live.title,
      artist: orphan.artist ?? live.artist,
      syncStatus: 'pending_sync',
      lastModifiedLocally: Date.now(),
    })
    next.set(move.toTrackId, updatedRows[updatedRows.length - 1])
    next.delete(move.fromTrackId)
    movedIds.push(move.fromTrackId)
  }
  if (movedIds.length === 0) return { moved: 0, unmatched: decision.unmatchedTrackIds.length }

  metadataCache.set(next)
  // AWAITED, not fire-and-forget: the pushChanges trigger reads Dexie
  // (getPendingSyncMetadata) immediately after the relink — a fire-and-forget
  // write would let that read observe the PRE-relink rows (the race the
  // migration e2e caught).
  await bulkUpsertMetadata(updatedRows)
  await bulkDeleteMetadata(movedIds)
  const unmatched = decision.unmatchedTrackIds.length
  dbgAlways('sync', `pending relink: moved ${movedIds.length} orphaned edit(s) onto their re-encoded ids (${movedIds.map((id) => `${id} →`).join(' ')} via path/identity evidence)${unmatched > 0 ? `; ${unmatched} left as discard candidates` : ''}`)
  return { moved: movedIds.length, unmatched }
}

let initialized = false

/**
 * The init READ phase, extracted so `initStores` can retry it after a
 * connection recovery (2026-10-13). Safe to re-run: every leg is a read or an
 * idempotent `restore()` (`persistedStore` keeps `restored` false when its
 * read throws, so a retry re-reads instead of trusting a default), and
 * nothing is written before the phase completes.
 */
async function restoreLocalState(): Promise<void> {
  const [q, allMeta] = await Promise.all([
    getQueue(),
    getAllMetadata(),
  ])
  await loadSettings()
  applyDefaultSettings()

  if (q) {
    // `?? q.historyQueue` tolerates rows persisted by app versions that still
    // used the old field name — the first saveQueue overwrites the row.
    //
    // RAW PASS-THROUGH (D13, 2026-10-21): restore keeps the persisted rows
    // verbatim, duplicates included. Rows are occurrences now (QueueView keys
    // `u-<id>#<n>`), so a legacy duplicate is legal — deduping "for safety"
    // would silently delete the listening history this queue exists to keep.
    // With no dedupe the stored index is EXACT: it only needs bounds checking.
    const userQueue = Array.isArray(q.userQueue) ? [...q.userQueue] : []
    const autoQueue = Array.isArray(q.autoQueue) ? [...q.autoQueue] : []
    queue.set({
      userQueue,
      autoQueue,
      recentTrackIds: sanitizeRecent(q.recentTrackIds ?? (q as { historyQueue?: string[] }).historyQueue),
      activeIndex: clampStoredActiveIndex(q.activeIndex, userQueue.length + autoQueue.length),
    })
  }

  const map = new Map<string, LocalMetadataStore>()
  for (const m of allMeta) {
    map.set(m.trackId, m)
  }
  metadataCache.set(map)

  // Restore the engine-bound scalar settings (order-independent here — the
  // playback manager applies them to the engine in snap-before-pitch order).
  await Promise.all([
    _playbackSpeed.restore(),
    _pitchOctaves.restore(),
    _tapeMode.restore(),
    _snapTolerance.restore(),
    _masterGain.restore(),
    _loopMode.restore(),
    _autoQueueFilterFields.restore(),
    _autoQueueSort.restore(),
    _autoQueueEnabled.restore(),
    _autoQueueRecentLimit.restore(),
    _autoQueueLength.restore(),
    _filterPresets.restore(),
    getSetting<PushRunReport>('lastPushReport')
      .then((saved) => {
        if (saved && typeof saved === 'object' && typeof saved.runId === 'string') {
          const normalized: PushRunReport =
            saved.status === 'running' ? { ...saved, status: 'interrupted' } : saved
          lastPushReport.set(normalized)
        }
      })
      .catch(() => {}),
  ])

  await migrateLegacyShuffle()
}

/**
 * Boots the local stores. A DEAD IndexedDB connection (iOS WebKit invalidating
 * the handle under memory pressure — `UnknownError: Attempt to get a record
 * from database without an in-progress transaction`) must not brick the whole
 * session: the first read failure earns a bounded reopen-and-retry through the
 * pure `planStorageInitAttempt` (`storageHealth.ts`) before the error is
 * surfaced. Every attempt is logged at danger level — without it a recovery is
 * invisible in a field dump (`jsEvents` stayed empty in the 2026-10-13 report).
 * On a permanent failure `initialized` stays false, so a later retry (a reload,
 * or a future in-place retry) can still complete the boot.
 */
export async function initStores(): Promise<void> {
  if (initialized) return
  for (let attempt = 1; ; attempt++) {
    try {
      await restoreLocalState()
      initialized = true
      return
    } catch (err) {
      const action = planStorageInitAttempt(err, attempt, STORAGE_INIT_MAX_ATTEMPTS)
      dbgDanger(
        'storage',
        `local storage init failed on attempt ${attempt}/${STORAGE_INIT_MAX_ATTEMPTS}: ${describeStorageError(err)} → ${action}`,
      )
      if (action === 'abort') throw err
      try {
        await reopenDatabase()
        dbgAlways('storage', `reopened the local database connection after the attempt-${attempt} failure`)
      } catch (reopenErr) {
        // Surface the ORIGINAL failure — the reopen's error is a consequence,
        // and it is not the shape the user's report is about.
        dbgDanger('storage', `storage connection reopen failed: ${describeStorageError(reopenErr)}`)
        throw err
      }
    }
  }
}

async function loadSettings(): Promise<void> {
  const keys: (keyof SettingsMap)[] = ['preloadTracks', 'crossfadeDuration', 'webdavUrl', 'webdavUser', 'webdavToken', 'navidromeUrl', 'navidromeUser', 'navidromePassword', 'replayGainMode', 'scrobbling', 'ratingSource', 'syncToNavidrome', 'writeTagsInNavidromeMode', 'lastfmScrobbling', 'listenbrainzScrobbling', 'listenbrainzToken', 'scrobbleLoveFromLoved', 'scrobbleLoveFromRating', 'scrobbleLoveRatingThreshold', 'lastfmApiKey', 'lastfmApiSecret', 'lowDataMode', 'lowDataOnCellular', 'transcodeMode', 'transcodeFormat', 'transcodeBitrate', 'transcodeProbe', 'iosAudioMixing', 'seekEpochs']
  const entries = await Promise.all(keys.map(async (key) => {
    const value = await getSetting(key)
    return [key, value] as [typeof key, unknown]
  }))
  const s = Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as SettingsMap
  settings.set(s)
}

export function setCurrentTrack(track: Track | null): void {
  currentTrack.set(track)
  // The audio caught up with the anchor: the skip-in-flight fact is spent.
  // (A same-id load — duplicates — is equally spent: id equality already makes
  // the normal advance rule apply.)
  if (track && get(pendingAdvanceTrackId) === track.trackId) pendingAdvanceTrackId.set(null)
}

export function setPlaybackState(state: PlaybackState): void {
  playbackState.set(state)
}

export function setActiveQueueIndex(index: number): void {
  queue.update((q) => {
    persistQueue('setActiveQueueIndex', { ...q, activeIndex: index })
    return { ...q, activeIndex: index }
  })
}

export function updateSetting<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]): void {
  settings.update((s) => {
    setSetting(key, value as string | number | boolean | object)
    return { ...s, [key]: value }
  })
}

/** Defaults for settings rows that were never persisted. Written back into
 *  the store once at boot (after loadSettings) so EVERY reader sees one
 *  consistent value without spreading `?? fallback` expressions further.
 *  2026-09-08 user tuning: replay gain track mode, 6 s crossfade.
 *  `[not test-pinned]` */
export function applyDefaultSettings(): void {
  settings.update((s) => ({
    replayGainMode: s.replayGainMode ?? 'track',
    crossfadeDuration: s.crossfadeDuration ?? 6,
    // Love scrobbling (2026-10-21): defaults preserve the historical "♥ flag
    // only" behavior for an install that never set the keys.
    scrobbleLoveFromLoved: s.scrobbleLoveFromLoved ?? DEFAULT_LOVE_POLICY.fromLovedFlag,
    scrobbleLoveFromRating: s.scrobbleLoveFromRating ?? DEFAULT_LOVE_POLICY.fromRating,
    scrobbleLoveRatingThreshold: s.scrobbleLoveRatingThreshold ?? DEFAULT_LOVE_POLICY.ratingThreshold,
    iosAudioMixing: s.iosAudioMixing ?? 'exclusive',
    // Phase 2 (2026-10-07): the seek-epoch kill switch defaults to 'auto' —
    // an absent key must mean the feature is ON, never undefined-mode.
    seekEpochs: s.seekEpochs ?? 'auto',
    ...s,
  }))
}

export function updateMetadata(meta: LocalMetadataStore): void {
  metadataCache.update((map) => {
    const next = new Map(map)
    next.set(meta.trackId, meta)
    return next
  })
  upsertMetadata(meta)
}

/**
 * The shuffle button's single write (2026-11-01): toggling shuffle sets the
 * auto sort to random (remembering the previous tiers) or restores them. One
 * store update = one Dexie row write and one subscriber fire, so the queue
 * cannot observe a half-applied toggle.
 */
export function toggleShuffle(): void {
  autoQueueSort.update((s) => planRandomToggle(s, !isRandomSort(s)))
  autoQueueScope.set({})
}

/**
 * One-time migration (2026-11-01): `shuffleEnabled` used to be its own persisted
 * row. It is a derived view of the auto sort now, so an install that had
 * shuffle ON must turn that fact into sort=random ONCE — and the old row is
 * cleared, or every boot would re-apply it after the user turned shuffle off.
 */
async function migrateLegacyShuffle(): Promise<void> {
  try {
    const legacy = await getSetting<boolean>('shuffleEnabled')
    if (legacy !== true) return
    autoQueueSort.update((s) => planRandomToggle(s, true))
    await setSetting('shuffleEnabled', false)
  } catch {
    /* a failed migration must not block boot */
  }
}

export function initMetadataForTracks(tracks: Track[]): void {
  const cache = get(metadataCache)
  const toInit: LocalMetadataStore[] = []
  for (const t of tracks) {
    if (!cache.has(t.trackId)) {
      toInit.push({
        trackId: t.trackId,
        rating: 0,
        loved: false,
        fileType: t.fileType,
        syncStatus: 'synced',
        lastModifiedLocally: Date.now(),
        comments: t.comments,
      })
    }
  }
  if (toInit.length === 0) return
  bulkUpsertMetadata(toInit)
  metadataCache.update((map) => {
    const next = new Map(map)
    for (const m of toInit) next.set(m.trackId, m)
    return next
  })
}

/**
 * Seeds rating/loved values carried by Navidrome songs (starred/userRating) into
 * the metadata cache so the UI shows server state without a full re-merge. Only
 * overwrites entries that were not locally modified (`syncStatus: 'synced'`).
 * In 'webdav' mode, existing WebDAV ratings take precedence over Navidrome's
 * integer-rounded star ratings.
 */
export function seedNavidromeFeedback(tracks: Track[]): void {
  const cache = get(metadataCache)
  const source = get(settings).ratingSource ?? 'webdav'
  const updates: LocalMetadataStore[] = []
  for (const t of tracks) {
    if (!t.trackId.startsWith('navidrome-')) continue
    const { starred, userRating } = t
    if (starred === undefined && userRating === undefined) continue
    const existing = cache.get(t.trackId)
    if (existing && existing.syncStatus === 'pending_sync') continue

    let rating = existing?.rating ?? 0
    if (source === 'navidrome' || !existing || (!existing.webdavPath && rating === 0)) {
      if (userRating !== undefined) {
        rating = Math.min(100, Math.round(userRating * 20))
      }
    }

    let loved = existing?.loved ?? false
    if (source === 'navidrome' || !existing || (!existing.webdavPath && !loved)) {
      if (starred !== undefined) {
        loved = starred === true
      }
    }

    const next: LocalMetadataStore = {
      trackId: t.trackId,
      rating,
      loved,
      fileType: t.fileType,
      syncStatus: existing?.syncStatus ?? 'synced',
      lastModifiedLocally: existing?.lastModifiedLocally ?? Date.now(),
      comments: existing?.comments ?? t.comments,
      webdavPath: existing?.webdavPath,
      webdavLastModified: existing?.webdavLastModified,
      webdavBase: existing?.webdavBase,
      // The bulk replace must not drop matching intent (a seeded dismissed /
      // manually-bound row would otherwise be re-matched on the next scan, D8).
      matchSource: existing?.matchSource,
      ignored: existing?.ignored,
      // Identity snapshot: pending rows keep theirs; synced rows restamp so
      // a later orphan never carries a stale identity.
      title: existing?.syncStatus === 'pending_sync' ? existing.title : t.title,
      artist: existing?.syncStatus === 'pending_sync' ? existing.artist : t.artist,
    }
    updates.push(next)
  }
  if (updates.length === 0) return
  bulkUpsertMetadata(updates)
  metadataCache.update((map) => {
    const next = new Map(map)
    for (const u of updates) next.set(u.trackId, u)
    return next
  })
}
