import { writable } from 'svelte/store'
import { get } from 'svelte/store'
import { Capacitor } from '@capacitor/core'
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
    batchSize: () => webBatchSize(),
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
      const mbid = await lbLookupRecordingMbid(artist, track)
      if (!mbid) throw new NoMbidMatchError()
      await lbSubmitFeedback(lbToken(), mbid, score)
    },
  }
}

export class NoMbidMatchError extends Error {
  constructor() {
    super('No ListenBrainz MBID match')
    this.name = 'NoMbidMatchError'
  }
}

function webBatchSize(): number {
  // JSONP GET URLs must stay under conservative middlebox limits; native POSTs take full batches.
  return Capacitor.isNativePlatform() ? LFM_SCROBBLE_BATCH_MAX : 20
}

function lbToken(): string {
  const token = get(settings).listenbrainzToken
  if (!token) throw new Error('ListenBrainz not connected')
  return token
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

  /** App-init wiring: pending count restore, online kick, slow periodic tick. */
  init(): void {
    void this.store.count().then((pending) => scrobbleFlushStatus.update((s) => ({ ...s, pending })))
    window.addEventListener('online', () => this.kick())
    setInterval(() => {
      let pending = 0
      scrobbleFlushStatus.subscribe((s) => { pending = s.pending })()
      if (pending > 0) this.kick()
    }, FLUSH_TICK_MS)
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

    // One kind per cycle — each destination has its own call shape.
    const kindOrder: ScrobbleKind[] = ['lfm-scrobble', 'lb-listen', 'lfm-love', 'lfm-unlove', 'lb-love', 'lb-unlove']
    const kind = kindOrder.find((k) => deliverable.some((r) => r.kind === k))
    if (!kind) return false

    const group = deliverable.filter((r) => r.kind === kind).slice(0, kind === 'lfm-scrobble' ? this.deps.batchSize() : SINGLE_KIND_CYCLE_CAP)
    try {
      const failed = await this.submitGroup(kind, group)
      const okRows = group.filter((r) => !failed.includes(r))
      if (okRows.length > 0) {
        await this.store.remove(okRows.map((r) => r.seq!).filter((seq) => seq !== undefined))
        scrobbleFlushStatus.update((s) => ({ ...s, pending: s.pending - okRows.length }))
      }
      if (failed.length > 0) {
        await this.store.markFailed(group.filter((r) => failed.includes(r)))
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

  /** Submits the group; returns the FAILED rows. Throws nothing (per-row errors collected). */
  private async submitGroup(kind: ScrobbleKind, group: PendingScrobbleRow[]): Promise<PendingScrobbleRow[]> {
    this.lastFailureWasRateLimit = false
    this.lastErrorMessage = null
    if (kind === 'lfm-scrobble') {
      await this.deps.lfmScrobble(group.map(toMeta))
      return []
    }
    const failed: PendingScrobbleRow[] = []
    for (const row of group) {
      try {
        if (kind === 'lfm-love' || kind === 'lfm-unlove') {
          await this.deps.lfmLove(row.artist, row.track, kind === 'lfm-love')
        } else if (kind === 'lb-listen') {
          await this.deps.lbListen(row, false)
        } else if (kind === 'lb-love' || kind === 'lb-unlove') {
          // Heart polarity lives in the kind: love → score 1, unlove → 0
          // (0 removes the feedback server-side).
          await this.deps.lbFeedback(row.artist, row.track, kind === 'lb-love' ? 1 : 0)
        }
      } catch (err) {
        if (err instanceof NoMbidMatchError) {
          // Nothing to map to — drop permanently with a surfaced counter.
          await this.store.remove(row.seq !== undefined ? [row.seq] : [])
          scrobbleFlushStatus.update((s) => ({ ...s, pending: s.pending - 1, skippedNoMbid: s.skippedNoMbid + 1 }))
          continue
        }
        failed.push(row)
        if (!this.lastErrorMessage) this.lastErrorMessage = describeErr(err)
        if (this.isRateLimit(err)) {
          this.lastFailureWasRateLimit = true
          break
        }
      }
    }
    return failed
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
