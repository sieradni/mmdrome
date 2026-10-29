// Unit tests for the production WebDAV Push orchestration (`runManualWebDAVSync`)
// and the pure outcome aggregation (`pushOutcome.ts`), covering W1–W12 and
// W-01…W-10 from `docs/plans/2026-10-22-field-reliability-and-push-diagnostics.md`.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  runManualWebDAVSync,
  __setPushSyncDeps,
  __resetPushSyncDeps,
  type PushSyncDeps,
} from '../src/lib/syncEngine'
import { webdavBaseKey, WebdavTransportError, type WebdavResponse } from '../src/lib/webdavUtils'
import type { LocalMetadataStore } from '../src/lib/db'
import type { PushRunReport } from '../src/lib/pushOutcome'

/**
 * The write core reads the destination's validators from PROPFIND before it
 * touches anything (`webdavPreconditions.ts`) — that read is also the baseline
 * the pre-MOVE re-check compares against. These harnesses answer it with a
 * fixed, unchanged destination unless a case deliberately overrides it, so the
 * rows below exercise the real guarded path (rung 1, `tagged-if`).
 */
function validatorXml(etag: string): string {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>'
    + `<d:getetag>${etag}</d:getetag>`
    + '<d:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</d:getlastmodified>'
    + '</d:response></d:multistatus>'
}

const VALIDATOR_XML = validatorXml('"e1"')
/** The same destination after another writer replaced it. */
const VALIDATOR_XML_CHANGED = validatorXml('"e2"')

const BASE_URL = 'https://dav.example/remote.php/dav/files/alice/'
const USER = 'alice'
const TOKEN = 'secret'
const BASE_KEY = webdavBaseKey(BASE_URL, USER)

function makeRow(trackId: string, path: string, over: Partial<LocalMetadataStore> = {}): LocalMetadataStore {
  return {
    trackId,
    title: `Title ${trackId}`,
    artist: 'Artist',
    rating: 80,
    loved: true,
    fileType: 'mp3',
    webdavPath: path,
    webdavBase: BASE_KEY,
    syncStatus: 'pending_sync',
    lastModifiedLocally: 1000,
    ...over,
  }
}

function makeHeaders(map: Record<string, string> = {}) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    get: (name: string) => lower.get(name.toLowerCase()) ?? null,
  }
}

function makeRes(status: number, headers: Record<string, string> = {}, bodyText = ''): WebdavResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: makeHeaders(headers),
    text: async () => bodyText,
    arrayBuffer: async () => new ArrayBuffer(16),
  }
}

interface Harness {
  pending: LocalMetadataStore[]
  liveMap: Map<string, LocalMetadataStore>
  upserted: LocalMetadataStore[]
  reports: PushRunReport[]
  calls: Array<{ method: string; url: string; headers: Record<string, string>; cache?: RequestCache }>
  scanTriggered: number
  deps: Partial<PushSyncDeps>
}

function createHarness(rows: LocalMetadataStore[]): Harness {
  const liveMap = new Map(rows.map((r) => [r.trackId, { ...r }]))
  const upserted: LocalMetadataStore[] = []
  const reports: PushRunReport[] = []
  const calls: Harness['calls'] = []
  let scanTriggered = 0
  let clock = 1_700_000_000_000

  const h: Harness = {
    pending: rows.map((r) => ({ ...r })),
    liveMap,
    upserted,
    reports,
    calls,
    get scanTriggered() {
      return scanTriggered
    },
    set scanTriggered(v: number) {
      scanTriggered = v
    },
    deps: {
      getSetting: async <T = string>(key: string): Promise<T | undefined> => {
        if (key === 'webdavUrl') return BASE_URL as unknown as T
        if (key === 'webdavUser') return USER as unknown as T
        if (key === 'webdavToken') return TOKEN as unknown as T
        return undefined
      },
      getPendingSyncMetadata: async () => h.pending.map((r) => ({ ...r })),
      getLiveMetadata: (id) => h.liveMap.get(id),
      setInMemoryMetadata: (row) => {
        h.liveMap.set(row.trackId, { ...row })
      },
      upsertMetadata: async (row) => {
        upserted.push({ ...row })
      },
      getLibraryTracks: () =>
        rows.map((r) => ({
          trackId: r.trackId,
          title: r.title ?? r.trackId,
          artist: r.artist ?? 'Artist',
          album: 'Album',
          duration: 180,
          fileType: r.fileType,
        })),
      modifyMetadataBuffer: async (buf) => buf,
      triggerNavidromeScan: async () => {
        scanTriggered++
      },
      persistPushReport: async (report) => {
        reports.push(structuredClone(report))
      },
      now: () => {
        clock += 25
        return clock
      },
      isNative: () => false,
    },
  }
  return h
}

beforeEach(() => {
  __resetPushSyncDeps()
})

afterEach(() => {
  __resetPushSyncDeps()
})

test('W1 / W-01: mixed HTTP and stage failures preserve per-row stages, HTTP status, Retry-After, and grouped failure summaries', async () => {
  const rows = [
    makeRow('t-auth', 'Album/Auth.mp3'),
    makeRow('t-lock', 'Album/Locked.mp3'),
    makeRow('t-rate', 'Album/RateLimit.mp3'),
    makeRow('t-space', 'Album/DiskFull.mp3'),
    makeRow('t-ok', 'Album/Good.mp3'),
  ]
  const h = createHarness(rows)
  __setPushSyncDeps({
    ...h.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string>, cache: options.cache })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (url.includes('Auth.mp3')) {
        return makeRes(401, { 'X-Request-Id': 'req-auth-1' }, 'Unauthorized')
      }
      if (url.includes('Locked.mp3') && method === 'MOVE') {
        return makeRes(423, {}, '<d:error>Resource is locked</d:error>')
      }
      if (url.includes('RateLimit.mp3') && method === 'GET') {
        return makeRes(429, { 'Retry-After': '30', 'X-Request-Id': 'req-429' }, 'Too many requests')
      }
      if (url.includes('DiskFull.mp3') && method === 'PUT') {
        return makeRes(507, {}, 'Insufficient Storage')
      }
      return makeRes(method === 'GET' ? 200 : 201, { ETag: '"e1"' })
    },
  })

  const res = await runManualWebDAVSync()
  assert.equal(res.synced, 1)
  assert.equal(res.failed, 4)
  assert.ok(res.report)
  const byId = new Map(res.report.rows.map((r) => [r.trackId, r]))

  assert.equal(byId.get('t-auth')?.disposition, 'failed-get')
  assert.equal(byId.get('t-auth')?.error?.category, 'auth')
  assert.equal(byId.get('t-auth')?.error?.status, 401)
  assert.equal(byId.get('t-auth')?.error?.requestId, 'req-auth-1')

  // Fresh bytes and fresh validators, without an extra CORS header permission.
  for (const method of ['GET', 'PROPFIND']) {
    const call = h.calls.find((c) => c.method === method)!
    assert.equal(call.cache, 'no-store')
    assert.equal(new Headers(call.headers).has('Cache-Control'), false)
  }

  assert.equal(byId.get('t-lock')?.disposition, 'failed-move')
  assert.equal(byId.get('t-lock')?.stage, 'move')
  assert.equal(byId.get('t-lock')?.error?.status, 423)
  assert.equal(byId.get('t-lock')?.tempCleanup, 'deleted')

  assert.equal(byId.get('t-rate')?.disposition, 'failed-get')
  assert.equal(byId.get('t-rate')?.error?.status, 429)
  assert.equal(byId.get('t-rate')?.error?.retryAfter, '30')

  assert.equal(byId.get('t-space')?.disposition, 'failed-put')
  assert.equal(byId.get('t-space')?.stage, 'put-temp')
  assert.equal(byId.get('t-space')?.error?.status, 507)

  assert.equal(byId.get('t-ok')?.disposition, 'written-synced')
  assert.equal(res.report.failureGroups.length, 4)
})

test('W2 / W-02: post-MOVE local DB failure reports written-local-failed instead of masking the committed remote write', async () => {
  const row = makeRow('t-db-fail', 'Album/Song.mp3')
  const h = createHarness([row])
  __setPushSyncDeps({
    ...h.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      return makeRes(method === 'GET' ? 200 : 201, { ETag: '"e1"' })
    },
    upsertMetadata: async () => {
      throw new Error('QuotaExceededError: IndexedDB full')
    },
  })

  const res = await runManualWebDAVSync()
  assert.equal(res.synced, 1, 'remote write committed and is counted in synced')
  assert.equal(res.localFailed, 1, 'local DB reconciliation failure is reported separately')
  assert.equal(res.failed, 0, 'remote write did not fail')
  assert.equal(h.scanTriggered, 1, 'Navidrome scan still triggers because remote file changed')

  const outcome = res.report?.rows[0]
  assert.equal(outcome?.disposition, 'written-local-failed')
  assert.equal(outcome?.remoteState, 'committed')
  assert.equal(outcome?.localReconciliation, 'failed')
  assert.equal(outcome?.error?.category, 'local-db')
})

test('W3 / W-04: mid-flight live discard or path change after GET/TagLib aborts before PUT/MOVE', async () => {
  const row1 = makeRow('t-discarded-mid-get', 'Album/One.mp3')
  const row2 = makeRow('t-rebound-before-move', 'Album/Two.mp3')
  const h = createHarness([row1, row2])

  __setPushSyncDeps({
    ...h.deps,
    modifyMetadataBuffer: async (buf, _r, _l) => {
      // User discards row1 while TagLib is editing the buffer!
      const live1 = h.liveMap.get('t-discarded-mid-get')!
      h.liveMap.set('t-discarded-mid-get', { ...live1, syncStatus: 'synced' })
      return buf
    },
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (url.includes('Two.mp3.mmdrome-tmp') && method === 'PUT') {
        // User re-binds row2 to a different file while temp PUT is finishing, right before MOVE!
        const live2 = h.liveMap.get('t-rebound-before-move')!
        h.liveMap.set('t-rebound-before-move', { ...live2, webdavPath: 'Album/Other.mp3' })
      }
      return makeRes(method === 'GET' ? 200 : 201, { ETag: '"e1"' })
    },
  })

  const res = await runManualWebDAVSync()
  assert.equal(res.synced, 0)
  assert.equal(res.skipped, 2)

  // Row 1 never even issued PUT!
  assert.equal(
    h.calls.some((c) => c.url.includes('One.mp3') && c.method === 'PUT'),
    false,
    'discarded row must not PUT temp file after TagLib edit',
  )
  // Row 2 issued PUT, then aborted before MOVE and cleaned up its temp file!
  assert.equal(
    h.calls.some((c) => c.url.includes('Two.mp3') && c.method === 'MOVE'),
    false,
    'rebound row must abort before MOVE',
  )
  assert.equal(
    h.calls.some((c) => c.url.includes('Two.mp3.mmdrome-tmp') && c.method === 'DELETE'),
    true,
    'aborted pre-MOVE must clean up temp file',
  )
  const r2Outcome = res.report?.rows.find((r) => r.trackId === 't-rebound-before-move')
  assert.equal(r2Outcome?.disposition, 'skipped-live-invalidated')
  assert.equal(r2Outcome?.stage, 'pre-move-validation')
  assert.equal(r2Outcome?.tempCleanup, 'deleted')
})

test('W4 / W-05: failed first writer releases target path so second row can push; committed first writer skips duplicate target', async () => {
  // Case A: first row fails on GET; second row targeting the same path succeeds
  const rowsFailFirst = [
    makeRow('t-dup-1', 'Album/Shared.mp3'),
    makeRow('t-dup-2', 'Album/Shared.mp3', { rating: 100 }),
  ]
  const h1 = createHarness(rowsFailFirst)
  let getCalls = 0
  __setPushSyncDeps({
    ...h1.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h1.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (method === 'GET') {
        getCalls++
        if (getCalls === 1) return makeRes(503, {}, 'Temporary outage')
      }
      return makeRes(method === 'GET' ? 200 : 201, { ETag: '"e1"' })
    },
  })

  const res1 = await runManualWebDAVSync()
  assert.equal(res1.failed, 1)
  assert.equal(res1.synced, 1, 'second row targeting same path succeeded because first failed before commit')

  // Case B: first row commits; second row targeting the same path is skipped as skipped-duplicate-target
  const rowsCommitFirst = [
    makeRow('t-dup-a', 'Album/Shared.mp3'),
    makeRow('t-dup-b', 'Album/Shared.mp3', { rating: 40 }),
  ]
  const h2 = createHarness(rowsCommitFirst)
  __setPushSyncDeps({
    ...h2.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h2.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      return makeRes(method === 'GET' ? 200 : 201, { ETag: '"e1"' })
    },
  })

  const res2 = await runManualWebDAVSync()
  assert.equal(res2.synced, 1)
  assert.equal(res2.skipped, 1)
  assert.equal(res2.report?.rows[1]?.disposition, 'skipped-duplicate-target')
})

test('W6 / W-02: lost MOVE response records unknown-outcome and does not mark row synced', async () => {
  const row = makeRow('t-move-lost', 'Album/Uncertain.mp3')
  const h = createHarness([row])
  __setPushSyncDeps({
    ...h.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (method === 'MOVE') {
        throw new WebdavTransportError('Request timed out during MOVE', {
          method: 'MOVE',
          transport: 'web',
          phase: 'headers',
          elapsedMs: 30_000,
          timedOut: true,
        })
      }
      return makeRes(200, { ETag: '"e1"' })
    },
  })

  const res = await runManualWebDAVSync()
  assert.equal(res.synced, 0)
  assert.equal(res.unknownOutcomes, 1)
  assert.equal(res.failed, 1)
  assert.equal(h.upserted.length, 0, 'uncertain MOVE must never mark local row synced')
  const outcome = res.report?.rows[0]
  assert.equal(outcome?.disposition, 'unknown-outcome')
  assert.equal(outcome?.remoteState, 'unknown')
  assert.equal(outcome?.tempCleanup, 'deleted')
  // The throw site owns the stage: this MOVE fails after a successful PUT, and
  // reporting it as `put-temp` (the caller's last assigned stage) blamed the
  // wrong step. Pinned here because the browser path raises the SAME shape and
  // a mixed-outcome e2e run surfaced the mislabel.
  assert.equal(outcome?.stage, 'move')
  assert.equal(outcome?.error?.category, 'timeout')
})

test('a failed HTTP MOVE whose temp is already consumed stays unknown and reserves its target', async () => {
  const h = createHarness([makeRow('first', 'Album/Shared.mp3'), makeRow('second', 'Album/Shared.mp3')])
  __setPushSyncDeps({
    ...h.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (method === 'MOVE') return makeRes(403)
      if (method === 'DELETE') return makeRes(404)
      return makeRes(200)
    },
  })
  const res = await runManualWebDAVSync()
  assert.equal(res.unknownOutcomes, 1)
  assert.equal(res.synced, 0)
  assert.equal(h.upserted.length, 0)
  assert.equal(h.calls.filter(c => c.method === 'PUT').length, 1)
  assert.equal(h.calls.filter(c => c.method === 'MOVE').length, 1)
  assert.equal(res.report?.rows[0].disposition, 'unknown-outcome')
  assert.equal(res.report?.rows[0].tempCleanup, 'missing')
  assert.equal(res.report?.rows[0].remainsPending, true)
  assert.equal(res.report?.rows[1].disposition, 'skipped-duplicate-target')
})

test('W8 / W-08: a refused precondition escalates without a second upload; a real concurrent write still recovers', async () => {
  // The two 412 shapes side by side, which is the whole 2026-10-27 fix:
  //  - Retry.mp3's server refuses the destination-tagged `If` on EVERY MOVE
  //    while the destination is UNCHANGED — a dialect rejection, so the row
  //    escalates to the next rung and re-MOVEs the temp already uploaded.
  //  - Second.mp3 is genuinely replaced while its temp is uploading, so the
  //    pre-MOVE re-check refuses it and the caller's recovery re-reads and
  //    re-tags the OTHER writer's bytes (the only path that uploads twice).
  const row1 = makeRow('t-escalate', 'Album/Retry.mp3')
  const row2 = makeRow('t-conflict', 'Album/Second.mp3')
  const h = createHarness([row1, row2])
  let conflictReads = 0
  const progressEvents: Array<{ done: number; total: number; title: string }> = []

  __setPushSyncDeps({
    ...h.deps,
    isNative: () => true, // Native retains the conditional-header ladder.
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      const headers = (options.headers ?? {}) as Record<string, string>
      h.calls.push({ method, url, headers })
      if (method === 'PROPFIND') {
        if (url.includes('Second.mp3')) {
          conflictReads++
          return makeRes(207, {}, conflictReads >= 2 ? VALIDATOR_XML_CHANGED : VALIDATOR_XML)
        }
        return makeRes(207, {}, VALIDATOR_XML)
      }
      if (method === 'MOVE' && url.includes('Retry.mp3') && headers.If !== undefined) return makeRes(412)
      return makeRes(method === 'GET' ? 200 : 201, { ETag: '"e1"' })
    },
  })

  const res = await runManualWebDAVSync({
    onProgress: (done, total, title) => {
      progressEvents.push({ done, total, title })
    },
  })
  assert.equal(res.synced, 2)
  assert.equal(res.failed, 0)
  assert.equal(res.blindOverwrite, 0)

  const [escalated, conflicted] = res.report!.rows
  assert.equal(escalated.disposition, 'written-synced')
  assert.equal(escalated.precondition, 'if-match', 'the refused rung is replaced, not repeated')
  assert.equal(escalated.moveAttempts, 2)
  assert.equal(escalated.attempts, 1, 'no caller-level retry was needed')
  assert.equal(escalated.recoveredConflict, false)

  assert.equal(conflicted.disposition, 'written-synced')
  assert.equal(conflicted.attempts, 2)
  assert.equal(conflicted.recoveredConflict, true)

  const puts = (file: string) => h.calls.filter((c) => c.method === 'PUT' && c.url.includes(file)).length
  assert.equal(puts('Retry.mp3'), 1, 'a refused precondition costs NO second upload')
  assert.equal(puts('Second.mp3'), 2, 'a genuine concurrent write must re-upload the merged bytes')

  for (let i = 0; i < progressEvents.length; i++) {
    assert.ok(progressEvents[i].done <= progressEvents[i].total, `done (${progressEvents[i].done}) <= total (${progressEvents[i].total})`)
    if (i > 0) {
      assert.ok(progressEvents[i].done >= progressEvents[i - 1].done, 'progress done is monotonically non-decreasing')
    }
  }
})

test('W9 / W-02: newer local edit during push keeps row pending_sync and reports written-repended', async () => {
  const row = makeRow('t-repend', 'Album/Repend.mp3', { rating: 60, lastModifiedLocally: 1000 })
  const h = createHarness([row])

  __setPushSyncDeps({
    ...h.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (method === 'MOVE') {
        // User changes rating to 100 while MOVE is in flight!
        h.liveMap.set('t-repend', {
          ...row,
          rating: 100,
          lastModifiedLocally: 2000,
          syncStatus: 'pending_sync',
        })
      }
      return makeRes(method === 'GET' ? 200 : 201, { ETag: '"e1"' })
    },
  })

  const res = await runManualWebDAVSync()
  assert.equal(res.synced, 1)
  assert.equal(res.repended, 1)
  assert.equal(res.report?.rows[0]?.disposition, 'written-repended')
  assert.equal(res.report?.rows[0]?.remainsPending, true)
  assert.equal(h.liveMap.get('t-repend')?.syncStatus, 'pending_sync')
  assert.equal(h.liveMap.get('t-repend')?.rating, 100)
})

test('W10 / W-10: cancellation records unprocessed-cancelled rows and Navidrome scan failure does not fail pushed files', async () => {
  const rows = [
    makeRow('t-1', 'Album/1.mp3'),
    makeRow('t-2', 'Album/2.mp3'),
    makeRow('t-3', 'Album/3.mp3'),
  ]
  const h = createHarness(rows)
  let cancelNow = false

  __setPushSyncDeps({
    ...h.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (method === 'MOVE' && url.includes('1.mp3')) {
        cancelNow = true
      }
      return makeRes(method === 'GET' ? 200 : 201, { ETag: '"e1"' })
    },
    triggerNavidromeScan: async () => {
      throw new Error('Navidrome 502 Bad Gateway')
    },
  })

  const res = await runManualWebDAVSync({ isCancelled: () => cancelNow })
  assert.equal(res.cancelled, true)
  assert.equal(res.synced, 1)
  assert.equal(res.unprocessedCancelled, 2)
  assert.equal(res.failed, 0, 'Navidrome scan failure must not mark pushed files failed')
  assert.equal(res.catalogRefresh, 'failed')
  assert.equal(res.report?.catalogRefresh, 'failed')
  assert.match(res.report?.catalogRefreshError ?? '', /502 Bad Gateway/)
  assert.equal(res.report?.counts.unprocessedCancelled, 2)
})

// --- stage coverage beyond the mixed batch (W-01 stage taxonomy) ------------
// The register's "Required push regressions" row names representative policy
// cases rather than every numeric code; these are the ones the mixed batch
// above does NOT reach, so a stage can never collapse into a generic failure.

test('W-01: a TagLib failure is reported as failed-taglib and no PUT is ever attempted', async () => {
  const row = makeRow('t-tag', 'Album/Corrupt.mp3')
  const h = createHarness([row])
  __setPushSyncDeps({
    ...h.deps,
    modifyMetadataBuffer: async () => {
      throw new Error('TagLib: could not read file format')
    },
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      return makeRes(200, { ETag: '"e1"' })
    },
  })

  const res = await runManualWebDAVSync()
  const outcome = res.report?.rows[0]
  assert.equal(outcome?.disposition, 'failed-taglib')
  assert.equal(outcome?.stage, 'taglib-edit')
  assert.equal(outcome?.error?.category, 'tag-format')
  assert.equal(outcome?.remainsPending, true, 'a tag failure never clears the pending edit')
  assert.equal(h.calls.some((c) => c.method === 'PUT'), false, 'nothing is uploaded from an unreadable body')
  assert.equal(res.failed, 1)
})

test('W-01: a GET 404/410 is a no-write skip (file gone), not a failure', async () => {
  const row = makeRow('t-gone', 'Album/Deleted.mp3')
  const h = createHarness([row])
  __setPushSyncDeps({
    ...h.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (method === 'GET') return makeRes(404)
      return makeRes(201, { ETag: '"e1"' })
    },
  })

  const res = await runManualWebDAVSync()
  const outcome = res.report?.rows[0]
  assert.equal(outcome?.disposition, 'skipped-file-gone')
  assert.equal(outcome?.remoteState, 'not-committed')
  assert.equal(outcome?.remainsPending, true, 'the edit is preserved for a re-link, never dropped')
  assert.equal(res.skipped, 1)
  assert.equal(res.failed, 0, 'a missing target is a skip: nothing was attempted against a file')
  assert.equal(h.calls.some((c) => c.method === 'PUT'), false)
})

test('W-05: a network-level PUT rejection reports failed-put/network and uploads no temp', async () => {
  const row = makeRow('t-net', 'Album/Drop.mp3')
  const h = createHarness([row])
  __setPushSyncDeps({
    ...h.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (method === 'PUT') throw new TypeError('Failed to fetch')
      return makeRes(200, { ETag: '"e1"' })
    },
  })

  const res = await runManualWebDAVSync()
  const outcome = res.report?.rows[0]
  assert.equal(outcome?.disposition, 'failed-put')
  assert.equal(outcome?.stage, 'put-temp')
  assert.equal(outcome?.error?.category, 'network')
  assert.equal(outcome?.tempCleanup, 'not-needed', 'the helper never created a temp to clean')
  assert.equal(h.calls.some((c) => c.method === 'MOVE'), false)
})

test('W-05: a native transport rejection keeps its domain/code and its phase', async () => {
  const row = makeRow('t-native', 'Album/Native.mp3')
  const h = createHarness([row])
  __setPushSyncDeps({
    ...h.deps,
    isNative: () => true,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (method === 'GET') {
        throw new WebdavTransportError('The request timed out.', {
          method: 'GET',
          transport: 'native',
          phase: 'body',
          timedOut: true,
          code: -1001,
          domain: 'NSURLErrorDomain',
          elapsedMs: 30_000,
        })
      }
      return makeRes(201, { ETag: '"e1"' })
    },
  })

  const res = await runManualWebDAVSync()
  const outcome = res.report?.rows[0]
  assert.equal(outcome?.disposition, 'failed-get')
  assert.equal(outcome?.error?.category, 'timeout', 'a body-phase timeout is a timeout, not a decode error')
  assert.equal(outcome?.error?.code, -1001)
  assert.equal(outcome?.error?.domain, 'NSURLErrorDomain')
  assert.equal(res.report?.transport, 'native', 'the report names the transport it ran on')
})

test('W-08: a MOVE 500 exhausts the conflict path as failed-move with its temp cleaned up', async () => {
  const row = makeRow('t-move500', 'Album/Locked.mp3')
  const h = createHarness([row])
  __setPushSyncDeps({
    ...h.deps,
    webdavFetch: async (url, options) => {
      const method = String(options.method ?? 'GET')
      h.calls.push({ method, url, headers: (options.headers ?? {}) as Record<string, string> })
      if (method === 'PROPFIND') return makeRes(207, {}, VALIDATOR_XML)
      if (method === 'MOVE') return makeRes(500, {}, 'Internal Server Error')
      return makeRes(200, { ETag: '"e1"' })
    },
  })

  const res = await runManualWebDAVSync()
  const outcome = res.report?.rows[0]
  assert.equal(outcome?.disposition, 'failed-move')
  assert.equal(outcome?.stage, 'move')
  assert.equal(outcome?.error?.status, 500)
  assert.equal(outcome?.remoteState, 'not-committed', 'a rejected MOVE is not an uncertain one')
  assert.equal(outcome?.tempCleanup, 'deleted')
  assert.equal(h.calls.filter((c) => c.method === 'MOVE').length, 1, 'a 5xx is not retried as a conflict')
})
