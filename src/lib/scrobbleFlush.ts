import { writable } from 'svelte/store'
import { get } from 'svelte/store'
import { settings } from '../stores/appState'
import {
  enqueuePendingScrobble,
  readOldestPending,
  deletePendingBySeq,
  putPendingScrobble,
  countPendingScrobbles,
  type PendingScrobbleRow,
} from './db'
import {
  isHeartKind,
  LFM_SCROBBLE_BATCH_MAX,
  planFlush,
  type ScrobbleKind,
  type ScrobbleMeta,
} from './lastfmCore'
import { lfmScrobbleBatch, lfmSetLoved, LastfmError } from './lastfmApi'
import { lbSubmitListen, lbLookupRecordingMbid, lbSubmitFeedback, ListenBrainzError } from './listenbrainzApi'
import { effectiveLfmCreds, getCachedLfmSession } from './lastfmAuth'

/**
 * Durable outbound queue + flush engine for the direct scrobbler destinations
 * (Last.fm / ListenBrainz). Producers only ever enqueue; delivery is retried
 * across restarts until it succeeds, expires (time-sensitive listens past the
 * acceptance window) or turns poison (attempt cap).
 *
 * The store and the submit functions are injectable so the whole lifecycle is
 * pinned in Node without Dexie/network; the default wiring reads credentials
 * and session LAZILY at submit time (F2b: construction reads no bindings).
 */

export interface FlushStore {
  enqueue(row: Omit<PendingScrobbleRow, 'seq'>): Promise<boolean>
  oldest(limit: number): Promise<PendingScrobbleRow[]>
  remove(seqs: number[]): Promise<void>
  markFailed(rows: PendingScrobbleRow[]): Promise<void>
  count(): Promise<number>
}

const dexieStore: FlushStore = {
  enqueue: enqueuePendingScrobble,
  async oldest(limit) {
    return readOldestPending(limit)
  },
  remove(seqs) {
    return deletePendingBySeq(seqs)
  },
  async markFailed(rows) {
    for (const row of rows) {
      if (row.seq === undefined) continue
      await putPendingScrobble({ ...row, attempts: row.attempts + 1 })
    }
  },
  count: countPendingScrobbles,
}

/** Per-cycle submission cap for one-by-one kinds (loves, LB listens). */
const SINGLE_KIND_CYCLE_CAP = 25
const FLUSH_TICK_MS = 60000
const BASE_BACKOFF_MS = 30000
const MAX_BACKOFF_MS = 8 * 60 * 1000
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000

export interface SubmitDeps {
  /** Batch size for the array-capable calls (web JSONP stays under URL limits). */
  batchSize(): number
  lfmScrobble(metas: ScrobbleMeta[]): Promise<void>
  lfmLove(artist: string, track: string, loved: boolean): Promise<void>
  lbListen(entry: PendingScrobbleRow, playingNow: boolean): Promise<void>
  lbFeedback(artist: string, track: string, score: 1 | 0 | -1): Promise<void>
}

function defaultDeps(): SubmitDeps {
  return {
    // POST bodies have no URL-length constraint (the old JSONP/GET 20-cap is
    // gone) — both platforms take full batches up to Last.fm's hard limit.
    batchSize: () => LFM_SCROBBLE_BATCH_MAX,
    lfmScrobble: (metas) => {
      const session = getCachedLfmSession()
      if (!session) throw new LastfmError(9)
      return lfmScrobbleBatch(effectiveLfmCreds(), session.key, metas)
    },
    lfmLove: (artist, track, loved) => {
      const session = getCachedLfmSession()
      if (!session) throw new LastfmError(9)
      return lfmSetLoved(effectiveLfmCreds(), session.key, artist, track, loved)
    },
    lbListen: (entry, playingNow) =>
      lbSubmitListen(lbToken(), { artist: entry.artist, track: entry.track, album: entry.album, duration: entry.duration }, playingNow ? { playingNow: true } : { listenedAtSec: entry.timestamp }),
    lbFeedback: async (artist, track, score) => {
      const token = lbToken()
      const mbid = await lbLookupRecordingMbid(token, artist, track)
      if (!mbid) throw new NoMbidMatchError()
      await lbSubmitFeedback(token, mbid, score)
    },
  }
}

export class NoMbidMatchError extends Error {
  constructor() {
    super('No ListenBrainz MBID match')
    this.name = 'NoMbidMatchError'
  }
}

function lbToken(): string {
  const token = get(settings).listenbrainzToken
  if (!token) throw new Error('ListenBrainz not connected')
  return token
}

interface SubmitOutcome {
  /** Still queued for a retry. */
  failed: PendingScrobbleRow[]
  /** Removed for good — the destination has no representation for them. */
  discarded: PendingScrobbleRow[]
}

export interface FlushStatus {
  pending: number
  dropped: number
  skippedNoMbid: number
  /** Human-facing reason for the most recent failed cycle; cleared on success. */
  lastError?: string
}

export const scrobbleFlushStatus = writable<FlushStatus>({ pending: 0, dropped: 0, skippedNoMbid: 0 })

export interface EngineOptions {
  /** Overrides the computed backoff delay (tests pass 0 to avoid dangling timers). */
  backoffMs?: number
  /** Set false in tests to drive drains explicitly via `runNow`. */
  autoKick?: boolean
}

export class ScrobbleFlushEngine {
  private submitting = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private lastFailureWasRateLimit = false
  private lastErrorMessage: string | null = null
  /** Low data mode: the automatic flush ticks/kicks are suspended. Rows stay
   *  in the durable queue — nothing is lost; `runNow` (and the kick on the
   *  LDM lift edge) still work for explicit delivery. */
  private autoFlushEnabled = true

  private store: FlushStore
  private deps: SubmitDeps
  private opts: EngineOptions

  constructor(store: FlushStore = dexieStore, deps: SubmitDeps = defaultDeps(), opts: EngineOptions = {}) {
    // No constructor parameter properties (F3: erasableSyntaxOnly — Node's
    // strip-only TS loader rejects them).
    this.store = store
    this.deps = deps
    this.opts = opts
  }

  /** App-init wiring: pending count restore + immediate drain, online kick, slow periodic tick. */
  init(): void {
    void this.store.count().then((pending) => {
      scrobbleFlushStatus.update((s) => ({ ...s, pending }))
      if (pending > 0) this.kick()
    })
    window.addEventListener('online', () => this.kick())
    setInterval(() => {
      if (!this.autoFlushEnabled) return
      let pending = 0
      scrobbleFlushStatus.subscribe((s) => { pending = s.pending })()
      if (pending > 0) this.kick()
    }, FLUSH_TICK_MS)
  }

  /** Low data mode gate (PR-B): suspended = the periodic tick and the
   *  enqueue/online `kick()`s no-op. Explicit `runNow` is unaffected, and the
   *  LDM lift edge kicks once via `setAutoFlushEnabled(true)`. */
  setAutoFlushEnabled(enabled: boolean): void {
    this.autoFlushEnabled = enabled
  }

  /**
   * Records an outbound event. Returns false when the unique index already
   * holds it (a re-evaluated play or a double-toggled heart) — a no-op by design.
   */
  async enqueue(
    kind: ScrobbleKind,
    artist: string,
    track: string,
    opts?: Partial<Pick<PendingScrobbleRow, 'album' | 'albumArtist' | 'duration' | 'timestamp'>>,
  ): Promise<boolean> {
    const nowMs = Date.now()
    const added = await this.store.enqueue({
      kind,
      artist,
      track,
      album: opts?.album,
      albumArtist: opts?.albumArtist,
      duration: opts?.duration,
      timestamp: opts?.timestamp ?? Math.floor(nowMs / 1000),
      queuedAt: nowMs,
      attempts: 0,
    })
    if (added) {
      scrobbleFlushStatus.update((s) => ({ ...s, pending: s.pending + 1 }))
      if (this.opts.autoKick !== false) this.kick()
    }
    return added
  }

  kick(): void {
    if (!this.autoFlushEnabled) return
    void this.flushCycle()
  }

  private scheduleRetry(rateLimited: boolean): void {
    if (this.retryTimer) return
    const delay = this.opts.backoffMs ?? (rateLimited ? RATE_LIMIT_BACKOFF_MS : Math.min(BASE_BACKOFF_MS * 2 ** this.failures, MAX_BACKOFF_MS))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.kick()
    }, delay)
  }

  /** Deterministic drain attempt — the test/await-facing form of `kick`. */
  runNow(): Promise<void> {
    if (this.submitting) return Promise.resolve()
    this.submitting = true
    return (async () => {
      try {
        while (await this.cycleOnce()) { /* drain */ }
      } finally {
        this.submitting = false
      }
    })()
  }

  private async flushCycle(): Promise<void> {
    await this.runNow()
  }

  /** Processes ONE unit of work. True = more work may remain; false = stop. */
  private async cycleOnce(): Promise<boolean> {
    const rows = await this.store.oldest(LFM_SCROBBLE_BATCH_MAX * 2)
    if (rows.length === 0) {
      scrobbleFlushStatus.update((s) => ({ ...s, pending: 0 }))
      return false
    }

    // The planner supplies the expiry/poison partition only — request shaping
    // is per-kind (done below), so planner-level batching would be dead work.
    const plan = planFlush(rows, { nowMs: Date.now() })
    const goneIdx = [...plan.expiredIdx, ...plan.droppedIdx]
    if (goneIdx.length > 0) {
      await this.store.remove(goneIdx.map((i) => rows[i].seq!).filter((seq) => seq !== undefined))
      scrobbleFlushStatus.update((s) => ({ ...s, pending: s.pending - goneIdx.length, dropped: s.dropped + goneIdx.length }))
    }
    const deliverable = rows.filter((_, i) => !goneIdx.includes(i))
    if (deliverable.length === 0) return true

    // Listens first (their value decays server-side), then ALL heart kinds as
    // ONE group in queue order. Grouping hearts by kind name would replay a
    // ♥ off → on toggle as (on, off) and leave the services unloved while the
    // UI says loved; the row's `seq` order IS the state transition order, and
    // `deliverable` already carries it.
    let group: PendingScrobbleRow[]
    if (deliverable.some((r) => r.kind === 'lfm-scrobble')) {
      group = deliverable.filter((r) => r.kind === 'lfm-scrobble').slice(0, this.deps.batchSize())
    } else if (deliverable.some((r) => r.kind === 'lb-listen')) {
      group = deliverable.filter((r) => r.kind === 'lb-listen').slice(0, SINGLE_KIND_CYCLE_CAP)
    } else {
      group = deliverable.filter((r) => isHeartKind(r.kind)).slice(0, SINGLE_KIND_CYCLE_CAP)
    }
    if (group.length === 0) return false

    try {
      const { failed, discarded } = await this.submitGroup(group)
      // Book-keeping happens ONCE here. A discarded row (LB: no MBID match) is
      // gone from the durable queue, so counting it as delivered as well used
      // to decrement `pending` twice — the store drifted negative and a
      // negative count silences the periodic auto-flush until the next boot.
      const settled = group.filter((r) => !failed.includes(r) && !discarded.includes(r))
      const removable = [...settled, ...discarded].map((r) => r.seq!).filter((seq) => seq !== undefined)
      if (removable.length > 0) await this.store.remove(removable)
      if (settled.length > 0) {
        scrobbleFlushStatus.update((s) => ({ ...s, pending: s.pending - settled.length }))
      }
      if (discarded.length > 0) {
        scrobbleFlushStatus.update((s) => ({
          ...s,
          pending: s.pending - discarded.length,
          skippedNoMbid: s.skippedNoMbid + discarded.length,
        }))
      }
      if (failed.length > 0) {
        await this.store.markFailed(failed)
        this.failures++
        this.scheduleRetry(this.lastFailureWasRateLimit)
        scrobbleFlushStatus.update((s) => ({ ...s, lastError: this.lastErrorMessage ?? 'Submission failed' }))
        return false
      }
      this.failures = 0
      scrobbleFlushStatus.update((s) => ({ ...s, lastError: undefined }))
      return true
    } catch (err) {
      // Whole-group failure (e.g. batch request rejected).
      await this.store.markFailed(group)
      this.failures++
      this.scheduleRetry(this.isRateLimit(err))
      scrobbleFlushStatus.update((s) => ({ ...s, lastError: describeErr(err) }))
      return false
    }
  }

  /** Submits the group; reports FAILED rows and permanently DISCARDED ones (no
   *  MBID match). Throws nothing (per-row errors are collected). */
  private async submitGroup(group: PendingScrobbleRow[]): Promise<SubmitOutcome> {
    this.lastFailureWasRateLimit = false
    this.lastErrorMessage = null
    // Only lfm-scrobble batches; every other kind is one call per row, and a
    // heart group may mix kinds (queue order is preserved).
    if (group[0]?.kind === 'lfm-scrobble') {
      await this.deps.lfmScrobble(group.map(toMeta))
      return { failed: [], discarded: [] }
    }
    const failed: PendingScrobbleRow[] = []
    const discarded: PendingScrobbleRow[] = []
    for (let i = 0; i < group.length; i++) {
      const row = group[i]
      try {
        if (row.kind === 'lfm-love' || row.kind === 'lfm-unlove') {
          await this.deps.lfmLove(row.artist, row.track, row.kind === 'lfm-love')
        } else if (row.kind === 'lb-listen') {
          await this.deps.lbListen(row, false)
        } else if (row.kind === 'lb-love' || row.kind === 'lb-unlove') {
          // Heart polarity lives in the kind: love → score 1, unlove → 0
          // (0 removes the feedback server-side).
          await this.deps.lbFeedback(row.artist, row.track, row.kind === 'lb-love' ? 1 : 0)
        }
      } catch (err) {
        if (err instanceof NoMbidMatchError) {
          // Nothing to map to — cycleOnce drops it permanently and surfaces the
          // `skippedNoMbid` counter.
          discarded.push(row)
          continue
        }
        failed.push(row)
        if (!this.lastErrorMessage) this.lastErrorMessage = describeErr(err)
        if (this.isRateLimit(err)) {
          this.lastFailureWasRateLimit = true
          // A rate limited row aborts the rest of the group. Those rows were
          // NEVER attempted — leaving them out of `failed` made cycleOnce count
          // them as delivered and delete them (up to 24 hearts silently lost).
          failed.push(...group.slice(i + 1))
          break
        }
      }
    }
    return { failed, discarded }
  }

  private isRateLimit(err: unknown): boolean {
    return (err instanceof LastfmError && err.code === 29) || (err instanceof ListenBrainzError && err.status === 429)
  }
}

function describeErr(err: unknown): string {
  if (err instanceof LastfmError || err instanceof ListenBrainzError) return err.message
  return err instanceof Error ? err.message : String(err)
}

function toMeta(row: PendingScrobbleRow): ScrobbleMeta {
  return {
    artist: row.artist,
    track: row.track,
    album: row.album,
    albumArtist: row.albumArtist,
    duration: row.duration,
    timestamp: row.timestamp,
  }
}

export const scrobbleFlushEngine = new ScrobbleFlushEngine()
