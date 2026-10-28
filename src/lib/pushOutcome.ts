/**
 * Pure WebDAV Push outcome reducer, stage taxonomy, and durable report schema
 * (W-01, W-02, W-03, W-04, W-07, W-09, W-10).
 *
 * Keeps remote write state, local DB/cache reconciliation, and pending user
 * intent strictly separate so a committed remote write followed by a local DB
 * error or a newer in-flight rating edit is never misreported as a failed
 * upload or a clean sync.
 */

import {
  classifyRowForPush,
  shouldKeepPushPending,
  shouldSkipBeforePut,
  type PushRowBucket,
} from './pushReconcile'
import type { TempCleanupStatus } from './webdavAtomicWrite'
import type { PreconditionKind } from './webdavPreconditions'

export type PushStage =
  | 'classify'
  | 'live-validation'
  | 'get-headers'
  | 'get-body'
  | 'taglib-edit'
  | 'put-temp'
  | 'pre-move-validation'
  | 'move'
  | 'local-reconcile'
  | 'catalog-refresh'
  | 'cleanup'

export type PushRemoteState = 'not-attempted' | 'not-committed' | 'committed' | 'unknown'
export type PushLocalReconcileState = 'not-needed' | 'complete' | 'failed'

export type PushRowDisposition =
  | 'written-synced'
  | 'written-repended'
  | 'written-local-failed'
  | 'skipped-no-path'
  | 'skipped-ignored'
  | 'skipped-no-base'
  | 'skipped-wrong-server'
  | 'skipped-duplicate-target'
  | 'skipped-live-invalidated'
  | 'skipped-file-gone'
  | 'conflict-exhausted'
  | 'failed-get'
  | 'failed-taglib'
  | 'failed-put'
  | 'failed-move'
  | 'unknown-outcome'
  | 'unprocessed-cancelled'

export type PushErrorCategory =
  | 'timeout'
  | 'abort'
  | 'network'
  | 'auth'
  | 'http'
  | 'body-decode'
  | 'tag-format'
  | 'conflict'
  | 'local-db'
  | 'unknown'

export interface PushErrorDetail {
  category: PushErrorCategory
  stage: PushStage
  status?: number
  code?: string | number
  domain?: string
  retryAfter?: string
  requestId?: string
  davError?: string
  message: string
}

export interface PushRowOutcome {
  trackId: string
  title: string
  targetPath?: string
  initialBucket: PushRowBucket
  disposition: PushRowDisposition
  stage: PushStage
  attempts: number
  /** MOVEs the guard ladder needed (1 = the first rung was accepted). */
  moveAttempts?: number
  recoveredConflict: boolean
  precondition?: PreconditionKind
  remoteState: PushRemoteState
  localReconciliation: PushLocalReconcileState
  remainsPending: boolean
  tempCleanup?: TempCleanupStatus
  startedAtMs: number
  durationMs: number
  error?: PushErrorDetail
}

export type CatalogRefreshStatus = 'not-needed' | 'triggered' | 'failed'

export interface PushRunCounts {
  totalInput: number
  /** Rows whose remote MOVE succeeded (`remoteState === 'committed'`). */
  remoteCommitted: number
  /** Rows written remotely AND flattened to `synced` locally. */
  writtenSynced: number
  /** Rows written remotely AND kept `pending_sync` because a newer live edit landed during the push. */
  writtenRepended: number
  /** Rows written remotely whose local DB/cache update failed. */
  writtenLocalFailed: number
  /** Total skipped without failure (no-path + ignored + no-base + file-gone + live-invalidated + duplicate-target). */
  skipped: number
  skippedNoPath: number
  skippedIgnored: number
  skippedNoBase: number
  skippedWrongServer: number
  skippedDuplicateTarget: number
  skippedLiveInvalidated: number
  skippedFileGone: number
  /** Rows that recovered from a 412/404 conflict on retry. */
  conflictsRecovered: number
  /** Rows that failed because a 412/404 conflict persisted on retry. */
  conflictsExhausted: number
  /** Rows whose MOVE response was lost/aborted, leaving remote state uncertain. */
  unknownOutcomes: number
  /** Rows that failed before remote commit (GET, TagLib, PUT, MOVE, or conflict exhausted) or had local/unknown errors. */
  failed: number
  /** Rows not processed because the user cancelled between rows. */
  unprocessedCancelled: number
  /** Rows committed with no collision check at all (`precondition: 'blind'`). */
  blindOverwrite: number
  /** Rows committed with only the pre-MOVE destination re-check
   *  (`precondition: 'revalidated'`) — no server-enforced guard. */
  revalidatedCount: number
  /** Rows the SERVER guarded against a concurrent write (any ladder rung). */
  guardedWriteCount: number
  /** Total rows from this batch that remain `pending_sync` after the run. */
  remainingPending: number
}

export interface PushFailureGroup {
  key: string
  stage: PushStage
  category: PushErrorCategory
  status?: number
  disposition: PushRowDisposition
  headline: string
  nextAction: string
  count: number
  tracks: Array<{ trackId: string; title: string; targetPath?: string; message?: string }>
}

export interface PushRunReport {
  runId: string
  startedAt: string
  completedAt?: string
  durationMs: number
  status: 'running' | 'completed' | 'cancelled' | 'interrupted'
  transport: 'web' | 'native'
  baseKeyHashed: string
  cancelled: boolean
  catalogRefresh: CatalogRefreshStatus
  catalogRefreshError?: string
  counts: PushRunCounts
  failureGroups: PushFailureGroup[]
  rows: PushRowOutcome[]
  rowsTruncated: number
  firstFailureReason?: string
}

export const MAX_RETAINED_REPORT_ROWS = 200

/**
 * Computes exhaustive, non-overlapping aggregate counts from row outcomes.
 * Every input row has exactly one disposition, so the terminal buckets sum
 * to `rows.length`.
 */
export function summarizePushOutcomes(rows: readonly PushRowOutcome[]): PushRunCounts {
  const counts: PushRunCounts = {
    totalInput: rows.length,
    remoteCommitted: 0,
    writtenSynced: 0,
    writtenRepended: 0,
    writtenLocalFailed: 0,
    skipped: 0,
    skippedNoPath: 0,
    skippedIgnored: 0,
    skippedNoBase: 0,
    skippedWrongServer: 0,
    skippedDuplicateTarget: 0,
    skippedLiveInvalidated: 0,
    skippedFileGone: 0,
    conflictsRecovered: 0,
    conflictsExhausted: 0,
    unknownOutcomes: 0,
    failed: 0,
    unprocessedCancelled: 0,
    blindOverwrite: 0,
    revalidatedCount: 0,
    guardedWriteCount: 0,
    remainingPending: 0,
  }

  for (const r of rows) {
    if (r.remoteState === 'committed') {
      counts.remoteCommitted++
      if (r.precondition === 'blind') counts.blindOverwrite++
      else if (r.precondition === 'revalidated') counts.revalidatedCount++
      else if (r.precondition) counts.guardedWriteCount++
    }
    if (r.recoveredConflict) counts.conflictsRecovered++
    if (r.remainsPending) counts.remainingPending++

    switch (r.disposition) {
      case 'written-synced':
        counts.writtenSynced++
        break
      case 'written-repended':
        counts.writtenRepended++
        break
      case 'written-local-failed':
        counts.writtenLocalFailed++
        break
      case 'skipped-no-path':
        counts.skippedNoPath++
        counts.skipped++
        break
      case 'skipped-ignored':
        counts.skippedIgnored++
        counts.skipped++
        break
      case 'skipped-no-base':
        counts.skippedNoBase++
        counts.skipped++
        break
      case 'skipped-wrong-server':
        counts.skippedWrongServer++
        break
      case 'skipped-duplicate-target':
        counts.skippedDuplicateTarget++
        counts.skipped++
        break
      case 'skipped-live-invalidated':
        counts.skippedLiveInvalidated++
        counts.skipped++
        break
      case 'skipped-file-gone':
        counts.skippedFileGone++
        counts.skipped++
        break
      case 'conflict-exhausted':
        counts.conflictsExhausted++
        counts.failed++
        break
      case 'failed-get':
      case 'failed-taglib':
      case 'failed-put':
      case 'failed-move':
        counts.failed++
        break
      case 'unknown-outcome':
        counts.unknownOutcomes++
        counts.failed++
        break
      case 'unprocessed-cancelled':
        counts.unprocessedCancelled++
        break
    }
  }

  return counts
}

function nextActionForDisposition(
  disposition: PushRowDisposition,
  category: PushErrorCategory,
  status?: number,
): string {
  if (disposition === 'conflict-exhausted') {
    return 'Run Scan for changes to refresh file tags, then Push Changes again.'
  }
  if (disposition === 'unknown-outcome') {
    return 'Run Scan for changes before retrying so a completed remote write is not repeated blindly.'
  }
  if (disposition === 'written-local-failed') {
    return 'The WebDAV file was updated; run Scan for changes to reconcile local state without rewriting.'
  }
  if (category === 'auth' || status === 401 || status === 403) {
    return 'Check WebDAV username, token/password, and write/rename permissions on the target folder.'
  }
  if (status === 423) {
    return 'The target file is locked on the WebDAV server; wait for the lock to clear and retry.'
  }
  if (status === 507) {
    return 'The WebDAV server reported insufficient storage; free space on the server and retry.'
  }
  if (disposition === 'failed-taglib' || category === 'tag-format') {
    return 'Verify the audio file is intact and matches its format in File Matching.'
  }
  return 'Retry Push Changes when the WebDAV server is reachable.'
}

function headlineForGroup(
  disposition: PushRowDisposition,
  stage: PushStage,
  category: PushErrorCategory,
  status?: number,
  sampleMessage?: string,
): string {
  if (sampleMessage) return sampleMessage
  if (disposition === 'conflict-exhausted') return `File kept changing during write (${status ?? 412})`
  if (disposition === 'unknown-outcome') return 'Connection dropped during final MOVE — remote state uncertain'
  if (disposition === 'written-local-failed') return 'Remote file updated, but local database update failed'
  if (status) return `Stage ${stage} failed (HTTP ${status})`
  return `Stage ${stage} failed (${category})`
}

/**
 * Groups failed/conflict/unknown row outcomes by cause so the UI can show
 * concise, actionable recovery groups instead of either swallowing mixed
 * errors or flooding the screen with 27 identical lines.
 */
export function buildPushFailureGroups(rows: readonly PushRowOutcome[]): PushFailureGroup[] {
  const map = new Map<string, PushFailureGroup>()
  for (const r of rows) {
    const isFailure =
      r.disposition === 'conflict-exhausted' ||
      r.disposition === 'failed-get' ||
      r.disposition === 'failed-taglib' ||
      r.disposition === 'failed-put' ||
      r.disposition === 'failed-move' ||
      r.disposition === 'unknown-outcome' ||
      r.disposition === 'written-local-failed'
    if (!isFailure) continue

    const category: PushErrorCategory = r.error?.category ?? 'unknown'
    const status = r.error?.status
    const key = `${r.disposition}|${r.stage}|${category}|${status ?? ''}`
    let group = map.get(key)
    if (!group) {
      group = {
        key,
        stage: r.stage,
        category,
        status,
        disposition: r.disposition,
        headline: headlineForGroup(r.disposition, r.stage, category, status, r.error?.message),
        nextAction: nextActionForDisposition(r.disposition, category, status),
        count: 0,
        tracks: [],
      }
      map.set(key, group)
    }
    group.count++
    if (group.tracks.length < 25) {
      group.tracks.push({
        trackId: r.trackId,
        title: r.title,
        ...(r.targetPath ? { targetPath: r.targetPath } : {}),
        ...(r.error?.message ? { message: r.error.message } : {}),
      })
    }
  }
  return [...map.values()]
}

/**
 * Classifies aninitial non-pushable bucket into its PushRowOutcome.
 */
export function outcomeForInitialSkip(
  trackId: string,
  title: string,
  targetPath: string | undefined,
  bucket: Exclude<PushRowBucket, 'pushable'>,
  nowMs: number,
): PushRowOutcome {
  const disposition: PushRowDisposition =
    bucket === 'no-path'
      ? 'skipped-no-path'
      : bucket === 'ignored'
        ? 'skipped-ignored'
        : bucket === 'no-base'
          ? 'skipped-no-base'
          : 'skipped-wrong-server'
  return {
    trackId,
    title,
    ...(targetPath ? { targetPath } : {}),
    initialBucket: bucket,
    disposition,
    stage: 'classify',
    attempts: 0,
    recoveredConflict: false,
    remoteState: 'not-attempted',
    localReconciliation: 'not-needed',
    remainsPending: true,
    startedAtMs: nowMs,
    durationMs: 0,
  }
}

/**
 * Re-export the shared classifiers so callers can import the full push policy
 * from one place when desired.
 */
export { classifyRowForPush, shouldKeepPushPending, shouldSkipBeforePut }
