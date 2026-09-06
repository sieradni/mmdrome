// TODO 6.7/6.10/6.11/6.12 lifecycle harness — tests the scanner/WebDAV/Dexie
// glue that was previously [not test-pinned]. The harness injects mock
// implementations of `buildWebdavFileIndexDetailed` and `readFileMetadata` via
// `__setScannerDeps`, provides in-memory Dexie stubs so the scanner's
// persistence layer works in Node (no IndexedDB), and resets ALL scanner
// module state between tests so ordering can never mask a regression.
//
// Pure-core logic (scoring, fingerprinting, mtime) is pinned by
// `metadataCore.test.ts`; this suite covers the async state-machine glue.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import {
  library,
  metadataCache,
  metadataScanState,
  settings,
  updateMetadata,
} from '../src/stores/appState'
import type { Track } from '../src/stores/appState'
import { db } from '../src/lib/db'
import type { FileMetadata } from '../src/lib/metadataReader'
import type { WebdavFileEntry, FileTagCacheEntry } from '../src/lib/db'
import {
  __setScannerDeps,
  __resetScannerDeps,
  __resetScannerState,
  refreshIndex,
  ensureTagProbe,
  scanAll,
  setWebdavCredentials,
  cancelScan,
  wipeMetadataForRelink,
  resetMetadataAndRelink,
  tagProbeState,
  listUnresolvedMatches,
} from '../src/lib/metadataScanner'

// ── Helpers ─────────────────────────────────────────────────────────────────

function track(over: Partial<Track> = {}): Track {
  return {
    trackId: 't1',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    duration: 200,
    fileType: 'flac',
    size: 12345,
    trackNumber: 1,
    ...over,
  }
}

function entry(over: Partial<WebdavFileEntry> = {}): WebdavFileEntry {
  return {
    path: '/dav/files/user/Song.flac',
    filename: 'Song.flac',
    size: 12345,
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    ...over,
  }
}

function fileMeta(over: Partial<FileMetadata> = {}): FileMetadata {
  return {
    rating: 0,
    loved: false,
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    trackNumber: 1,
    ...over,
  }
}

// ── Mock state ──────────────────────────────────────────────────────────────

let mockEntries: WebdavFileEntry[] = []
let mockComplete = true
let mockMeta: Record<string, FileMetadata> = {}
let buildCallCount = 0
let readCallCount = 0
/** When set, the mock PROPFIND blocks until `releaseBuild` runs — used to hold
 *  a probe genuinely mid-flight while a credential swap lands. */
let buildGate: Promise<void> | null = null
let releaseBuild: (() => void) | null = null
/** When set, the mock file read blocks until `releaseRead` runs — used to hold
 *  a manual re-read mid-fetch so a dismissal can land while it is in flight. */
let readGate: Promise<void> | null = null
let releaseRead: (() => void) | null = null
/** When set, the mock PROPFIND rejects — used to pin the reset's behavior when
 *  the re-link scan cannot even build the index (wipe already happened). */
let buildFails = false

function setupMocks() {
  buildCallCount = 0
  readCallCount = 0
  mockEntries = []
  mockComplete = true
  mockMeta = {}
  buildGate = null
  releaseBuild = null
  readGate = null
  releaseRead = null
  buildFails = false
  __setScannerDeps({
    buildIndex: async () => {
      buildCallCount++
      const gate = buildGate
      if (gate) await gate
      if (buildFails) throw new Error('mock PROPFIND failure')
      return { entries: mockEntries, complete: mockComplete }
    },
    readFile: async (_baseUrl: string, filePath: string, _user: string, _token: string, _fileType: string) => {
      readCallCount++
      const gate = readGate
      if (gate) await gate
      const meta = mockMeta[filePath]
      if (!meta) throw new Error(`No mock metadata for ${filePath}`)
      return meta
    },
  })
}

function teardown() {
  __resetScannerDeps()
  __resetScannerState()
  for (const m of Object.values(memStores)) m.clear()
  library.set([])
  metadataCache.set(new Map())
  metadataScanState.set({ status: 'idle', progress: { scanned: 0, total: 0, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0 } })
}

function initWebdav() {
  settings.set({ webdavUrl: 'http://test.com', webdavUser: 'user', webdavToken: 'token' })
  setWebdavCredentials('http://test.com', 'user', 'token')
}

// ── Dexie stubs (Node has no IndexedDB) ────────────────────────────────────
// F3: all tables on a Dexie instance share ONE prototype. Patch the
// prototype methods once and dispatch on `this.name` for table-specific
// behavior. In-memory Maps back the reads/writes so the scanner's
// persistence round-trips work.

type MemEntry = Record<string, unknown>
const memStores: Record<string, Map<string, MemEntry>> = {
  webdavFileIndex: new Map(),
  webdavFileTags: new Map(),
  localMetadata: new Map(),
  playQueue: new Map(),
  songLibraryCache: new Map(),
  userSettings: new Map(),
}

// Each table's primary-key FIELD (not its name) — localMetadata rows carry
// `trackId`, not an `id`, so the original entry?.id check silently dropped
// every metadata write and made the wipe/persistence assertions vacuous.
const KEY_OF: Record<string, string> = {
  localMetadata: 'trackId',
  webdavFileIndex: 'id',
  webdavFileTags: 'id',
  playQueue: 'id',
  songLibraryCache: 'id',
  userSettings: 'key',
}

// Patch Dexie table prototype methods once (all tables share the prototype).
const tableProto = Object.getPrototypeOf(db.webdavFileIndex)

tableProto.get = async function (this: { name: string }, key: string) {
  return memStores[this.name]?.get(key) ?? undefined
}

tableProto.put = async function (this: { name: string }, entry: MemEntry) {
  const store = memStores[this.name]
  const keyOf = KEY_OF[this.name]
  const key = keyOf ? entry?.[keyOf] : entry?.id
  if (store && key != null) store.set(String(key), { ...entry })
}

tableProto.bulkPut = async function (this: { name: string }, items: MemEntry[]) {
  const store = memStores[this.name]
  const keyOf = KEY_OF[this.name]
  if (!store || !keyOf) return
  for (const item of items) {
    if (item?.[keyOf] != null) store.set(String(item[keyOf]), { ...item })
  }
}

tableProto.delete = async function (this: { name: string }, key: string) {
  memStores[this.name]?.delete(String(key))
}

tableProto.clear = async function (this: { name: string }) {
  memStores[this.name]?.clear()
}

tableProto.update = async function (this: { name: string }, key: string, changes: Record<string, unknown>) {
  const store = memStores[this.name]
  const entry = store?.get(String(key))
  if (entry) Object.assign(entry, changes)
}

tableProto.toArray = async function (this: { name: string }) {
  const store = memStores[this.name]
  return store ? [...store.values()] : []
}

tableProto.bulkDelete = async function (this: { name: string }, ids: string[]) {
  const store = memStores[this.name]
  if (store) for (const id of ids) store.delete(String(id))
}

tableProto.where = function (this: { name: string }, field: string) {
  const store = memStores[this.name]
  return {
    equals: (value: unknown) => ({
      toArray: async () => {
        if (!store) return []
        return [...store.values()].filter((e) => e[field] === value)
      },
      delete: async () => {
        if (!store) return
        for (const [k, v] of store) {
          if (v[field] === value) store.delete(k)
        }
      },
      count: async () => {
        if (!store) return 0
        return [...store.values()].filter((e) => e[field] === value).length
      },
    }),
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('overlapping ensureTagProbe() calls deduplicate (same generation)', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  const p1 = ensureTagProbe()
  const p2 = ensureTagProbe()

  // Second call chains onto the first — different reference, same underlying probe
  assert.notEqual(p1, p2, 'chained promise, not reference-equal')

  const [r1, r2] = await Promise.all([p1, p2])
  assert.ok(r1 instanceof Set, 'first call resolves')
  assert.ok(r2 instanceof Set, 'second call resolves')

  // The one underlying probe builds the index exactly once — the second call
  // must not start a competing PROPFIND.
  assert.equal(buildCallCount, 1, 'single underlying probe, single build')

  teardown()
})

test('credential swap mid-probe discards the stale build and starts a new probe', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  // Hold the first PROPFIND so the probe is genuinely mid-flight when the
  // credential swap lands.
  buildGate = new Promise((resolve) => { releaseBuild = resolve })
  const p1 = ensureTagProbe()
  await Promise.resolve() // let the probe operation start and capture the OLD session
  assert.equal(buildCallCount, 1, 'old-session probe started its build')

  // Swap credentials while the probe is blocked mid-build
  settings.set({ webdavUrl: 'http://new.com', webdavUser: 'user2', webdavToken: 'token2' })
  setWebdavCredentials('http://new.com', 'user2', 'token2')

  // A call after the swap must wait for the stale probe to settle, then start
  // a fresh probe for the new session.
  const p2 = ensureTagProbe()
  assert.notEqual(p1, p2, 'credential swap produces a different promise')

  releaseBuild!()
  await Promise.all([p1, p2])

  // The old-session build was discarded (its session no longer current) and
  // the new session rebuilt the index from scratch.
  assert.equal(buildCallCount, 2, 'stale build discarded, new session rebuilt')

  teardown()
})

test('token-only credential change invalidates live index', async () => {
  setupMocks()
  mockEntries = [entry()]
  initWebdav()

  const ok1 = await refreshIndex()
  assert.equal(ok1, true)
  assert.equal(buildCallCount, 1)

  // Change only the token (same URL + user)
  settings.set({ webdavUrl: 'http://test.com', webdavUser: 'user', webdavToken: 'newtoken' })
  setWebdavCredentials('http://test.com', 'user', 'newtoken')

  const ok2 = await refreshIndex()
  assert.equal(ok2, true)
  assert.equal(buildCallCount, 2, 'token change forces rebuild')

  teardown()
})

test('partial index allows auto-binds with tag verification', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  mockEntries = [entry()]
  mockComplete = false // partial!
  mockMeta = {
    '/dav/files/user/Song.flac': fileMeta({ title: 'Song', artist: 'Artist' }),
  }

  await scanAll('force')

  // The probe read the file's tags and auto-bound the unclaimed track.
  const bound = get(metadataCache).get('t1')
  assert.equal(bound?.webdavPath, '/dav/files/user/Song.flac', 'tag-verified auto-bind lands from a partial index')
  assert.equal(bound?.matchSource, undefined, 'auto-bind is not a manual binding')

  teardown()
})

test('probe publishes resolved count for tag auto-binds, reset per run', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  mockEntries = [entry()]
  mockComplete = true
  mockMeta = {
    '/dav/files/user/Song.flac': fileMeta({ title: 'Song', artist: 'Artist' }),
  }

  await ensureTagProbe()
  const s1 = get(tagProbeState)
  assert.equal(s1.active, false, 'probe finished')
  assert.equal(s1.resolved, 1, 'the tag-bound track is reported as resolved')
  assert.equal(get(metadataCache).get('t1')?.webdavPath, '/dav/files/user/Song.flac', 'auto-bind landed')

  // A second probe with nothing left unclaimed must not echo the previous
  // run's count — the counter is reset at probe start and only re-published.
  await ensureTagProbe()
  const s2 = get(tagProbeState)
  assert.equal(s2.active, false, 'second probe finished')
  assert.equal(s2.resolved, 0, 'resolved resets to 0 for an empty run')

  teardown()
})

test('inline probe binds are not attributed to the post-scan tail', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  mockEntries = [entry()]
  mockComplete = true
  mockMeta = {
    '/dav/files/user/Song.flac': fileMeta({ title: 'Song', artist: 'Artist' }),
  }

  await scanAll('force')

  // The inline probe bound t1 before the drain, so the drain never saw it as
  // unmatched. The drain-start reset zeroes the counter: the status line must
  // never attribute inline binds to the post-scan background probe (which, with
  // nothing left unclaimed, also publishes 0).
  assert.equal(get(tagProbeState).resolved, 0, 'inline binds are not double-counted')
  assert.equal(get(metadataCache).get('t1')?.webdavPath, '/dav/files/user/Song.flac', 'inline auto-bind landed')

  teardown()
})

test('unresolved rows carry a per-row no-match reason from the probe cache', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  // Same-size file whose tags were never read → the row must say "not probed",
  // not silently look permanent.
  mockEntries = [entry({ path: '/dav/files/user/Whatever.flac', filename: 'Whatever.flac', size: 12345, tags: undefined })]
  mockComplete = true

  await refreshIndex()
  const result = await listUnresolvedMatches()
  const row = result.rows.find((r) => r.kind === 'no-match')
  assert.ok(row, 'the unclaimed track lists as no-match')
  assert.equal(row.reason, 'not-probed', 'reason derived from missing tag evidence')
  assert.equal(row.candidates.length, 1, 'the size-only file stays a suggestion')

  teardown()
})

test('a probed-but-empty candidate reports no-identity-tags, not not-probed (2026-08-21)', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  // The file IS read (probe succeeds) but carries no identity title. The row
  // must not tell the user to rescan — rescanning cannot add identity that
  // the file does not have.
  mockEntries = [entry({ path: '/dav/files/user/Whatever.flac', filename: 'Whatever.flac', size: 12345 })]
  mockComplete = true
  mockMeta = {
    '/dav/files/user/Whatever.flac': fileMeta({ title: undefined, artist: undefined, album: undefined } as Partial<FileMetadata>),
  }

  await scanAll('force')
  const result = await listUnresolvedMatches()
  const row = result.rows.find((r) => r.kind === 'no-match')
  assert.ok(row, 'the unclaimed track lists as no-match')
  assert.equal(row.reason, 'no-identity-tags', 'probed-empty is honest, not "not read yet"')

  teardown()
})

test('hint-gated probing rotates: unhinted files are read even when hints matched (2026-08-21)', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  // One size-hinted file whose tags name a DIFFERENT song (never binds, keeps
  // the track unclaimed) plus 600 unhinted files (no size/filename signal).
  // 600 > the 500 sweep-all floor, so the probe runs hint-gated. The old
  // fallback only fired when NO hint matched, so the 600 were abandoned
  // forever; the rotation reads a bounded window of them per scan.
  const ORPHANS = 600
  mockEntries = [
    entry({ path: '/dav/files/user/Hinted.flac', filename: 'Hinted.flac', size: 12345 }),
    ...Array.from({ length: ORPHANS }, (_, i) =>
      entry({ path: `/dav/files/user/Orphan ${String(i).padStart(3, '0')}.flac`, filename: `Orphan ${String(i).padStart(3, '0')}.flac`, size: 999000 + i })),
  ]
  mockComplete = true
  mockMeta = {
    '/dav/files/user/Hinted.flac': fileMeta({ title: 'Different Song', artist: 'Someone Else' }),
    ...Object.fromEntries(
      Array.from({ length: ORPHANS }, (_, i) => [
        `/dav/files/user/Orphan ${String(i).padStart(3, '0')}.flac`,
        fileMeta({ title: `Unrelated ${i}`, artist: 'Various' }),
      ]),
    ),
  }

  await scanAll('modified')
  const firstRunReads = readCallCount
  // 1 hinted + the 100-file unhinted window — NOT all 601, NOT zero.
  assert.ok(firstRunReads >= 100 && firstRunReads < ORPHANS, `bounded unhinted window flows alongside the hinted one (got ${firstRunReads})`)

  // Second scan: probed files left the pool, so the window rotates forward.
  await scanAll('modified')
  assert.ok(readCallCount > firstRunReads, `rotation advances coverage (run1=${firstRunReads}, total=${readCallCount})`)

  // The track was never bound (its candidate contradicts) — the point is
  // coverage progress, not a bind.
  assert.equal(get(metadataCache).get('t1')?.webdavPath, undefined)

  teardown()
})

test('modified scan re-queues unmatched rows while unprobed files remain, even with stable fingerprints (2026-08-21)', async () => {
  setupMocks()
  initWebdav()

  // An ignored row is excluded from the probe's unclaimed set (probe no-ops,
  // writes nothing), so both fingerprints stay stable across scans — the old
  // gate skipped the drain entirely ("0 scanned / no changes") while the
  // files backing the row were never read.
  library.set([track()])
  updateMetadata({
    trackId: 't1',
    rating: 0,
    loved: false,
    fileType: 'flac',
    syncStatus: 'synced',
    lastModifiedLocally: Date.now(),
    ignored: true,
  })
  mockEntries = [
    entry({ path: '/dav/files/user/A.flac', filename: 'A.flac', size: 1 }),
    entry({ path: '/dav/files/user/B.flac', filename: 'B.flac', size: 2 }),
  ]
  mockComplete = true
  mockMeta = {
    '/dav/files/user/A.flac': fileMeta({ title: 'Unrelated A' }),
    '/dav/files/user/B.flac': fileMeta({ title: 'Unrelated B' }),
  }

  await scanAll('modified')
  const first = get(metadataScanState)
  assert.equal(first.status, 'complete')
  assert.equal(first.progress.total, 1, 'first scan queues the unmatched row')

  await scanAll('modified')
  const second = get(metadataScanState)
  assert.equal(second.status, 'complete')
  assert.equal(second.progress.total, 1, 'second scan still queues the row while files remain unprobed')
  assert.equal(second.progress.scanned, 1, 'not a 0/0 "no changes" short-circuit')

  teardown()
})

test('partial index blocks vanished-path clearing', async () => {
  setupMocks()
  initWebdav()

  const t = track()
  library.set([t])
  updateMetadata({
    trackId: 't1',
    rating: 80,
    loved: true,
    fileType: 'flac',
    syncStatus: 'synced',
    lastModifiedLocally: Date.now(),
    webdavPath: '/dav/files/user/Song.flac',
    webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'test.com|user',
  })

  // Partial index that doesn't include the bound path
  mockEntries = [entry({ path: '/dav/files/user/Other.flac', filename: 'Other.flac' })]
  mockComplete = false

  await scanAll('force')

  // Binding should NOT be cleared — path might be in unreadable dir
  const meta = get(metadataCache).get('t1')
  assert.equal(meta?.webdavPath, '/dav/files/user/Song.flac', 'vanished-path guard preserves binding on partial index')

  teardown()
})

test('empty complete index drains existing bindings', async () => {
  setupMocks()
  initWebdav()

  const t = track()
  library.set([t])
  updateMetadata({
    trackId: 't1',
    rating: 80,
    loved: true,
    fileType: 'flac',
    syncStatus: 'synced',
    lastModifiedLocally: Date.now(),
    webdavPath: '/dav/files/user/Song.flac',
    webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'test.com|user',
  })

  // Empty but COMPLETE index
  mockEntries = []
  mockComplete = true

  await scanAll('force')

  // Binding should be cleared — path gone from complete index
  const meta = get(metadataCache).get('t1')
  assert.equal(meta?.webdavPath, undefined, 'empty complete index clears vanished binding')
  assert.equal(meta?.rating, 80, 'rating preserved after path clear')

  teardown()
})

test('probe failure does not break scan, TTL allows retry', async () => {
  setupMocks()
  initWebdav()
  library.set([track({ trackId: 't2', title: 'Other' })])

  // File whose read will fail
  mockEntries = [entry({ path: '/dav/files/user/Bad.flac', filename: 'Bad.flac' })]
  mockComplete = true
  mockMeta = {} // no metadata → readFile throws

  await scanAll('force')

  const state = get(metadataScanState)
  assert.equal(state.status, 'complete', 'scan completes despite probe read failure')

  teardown()
})

test('refreshIndex builds index and populates live store', async () => {
  setupMocks()
  mockEntries = [entry()]
  mockComplete = true
  initWebdav()

  const ok = await refreshIndex()
  assert.equal(ok, true)
  assert.equal(buildCallCount, 1, 'buildIndex called once')

  teardown()
})

test('force scan skips pending_sync rows — binding and local edits untouched (D4)', async () => {
  setupMocks()
  initWebdav()

  const t = track()
  library.set([t])
  // A row with a pending local edit (rating changed, not yet pushed): the file
  // exists in the index and matches by size, so WITHOUT the D4 skip the drain
  // would re-read it and clobber the edit.
  updateMetadata({
    trackId: 't1',
    rating: 80,
    loved: false,
    fileType: 'flac',
    syncStatus: 'pending_sync',
    lastModifiedLocally: Date.now(),
    webdavPath: '/dav/files/user/Song.flac',
    webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })
  mockEntries = [entry()]
  mockComplete = true
  mockMeta = {
    '/dav/files/user/Song.flac': fileMeta({ rating: 90, loved: true }),
  }

  await scanAll('force')

  const row = get(metadataCache).get('t1')
  assert.equal(row?.webdavPath, '/dav/files/user/Song.flac', 'binding untouched by scan')
  assert.equal(row?.syncStatus, 'pending_sync', 'pending edit survives a force rescan')
  assert.equal(row?.rating, 80, 'local rating not clobbered by the file tag')
  assert.equal(readCallCount, 0, 'pending row never re-read')
  assert.equal(get(metadataScanState).status, 'complete', 'scan completed')

  teardown()
})

test('manual binding is re-read but never re-matched (D8 issue-1 guard)', async () => {
  setupMocks()
  initWebdav()

  const t = track()
  library.set([t])
  // The user manually bound this track to Song.flac at a rating of 40.
  updateMetadata({
    trackId: 't1',
    rating: 40,
    loved: false,
    fileType: 'flac',
    syncStatus: 'synced',
    lastModifiedLocally: Date.now(),
    webdavPath: '/dav/files/user/Song.flac',
    webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
    matchSource: 'manual',
  })
  mockEntries = [entry()]
  mockComplete = true
  // The bound file's tags changed since the bind (MusicBee edit) — a scan must
  // re-read THE BOUND FILE to propagate them.
  mockMeta = {
    '/dav/files/user/Song.flac': fileMeta({ rating: 90, loved: true }),
  }

  await scanAll('force')

  const row = get(metadataCache).get('t1')
  assert.equal(row?.webdavPath, '/dav/files/user/Song.flac', 'manual binding never re-matched')
  assert.equal(row?.matchSource, 'manual', 'manual marker preserved')
  assert.equal(row?.rating, 90, 'bound file re-read propagates MusicBee edits')
  assert.equal(row?.loved, true, 'loved propagated from the bound file')
  assert.equal(readCallCount, 1, 'exactly one read: the bound file only')

  teardown()
})

test('a dismissal landing mid manual re-read survives the full-row replace (D8)', async () => {
  setupMocks()
  initWebdav()

  const t = track()
  library.set([t])
  updateMetadata({
    trackId: 't1',
    rating: 40,
    loved: false,
    fileType: 'flac',
    syncStatus: 'synced',
    lastModifiedLocally: Date.now(),
    webdavPath: '/dav/files/user/Song.flac',
    webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
    matchSource: 'manual',
  })
  mockEntries = [entry()]
  mockComplete = true
  mockMeta = {
    '/dav/files/user/Song.flac': fileMeta({ rating: 90, loved: true }),
  }

  // Hold the bound-file read in flight, then dismiss the row while it runs.
  readGate = new Promise((resolve) => { releaseRead = resolve })
  const scanPromise = scanAll('force')
  for (let i = 0; i < 500 && readCallCount === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(readCallCount, 1, 'manual re-read is in flight')
  updateMetadata({
    trackId: 't1',
    rating: 40,
    loved: false,
    fileType: 'flac',
    syncStatus: 'synced',
    lastModifiedLocally: Date.now(),
    webdavPath: '/dav/files/user/Song.flac',
    webdavBase: 'http://test.com|user',
    matchSource: 'manual',
    ignored: true,
  })
  releaseRead!()
  await scanPromise

  const row = get(metadataCache).get('t1')
  assert.equal(row?.ignored, true, 'dismissal survives the scan')
  assert.equal(row?.rating, 40, 'file tags did not clobber the dismissed row')
  assert.equal(get(metadataScanState).status, 'complete', 'scan completed')

  teardown()
})

test('wipeMetadataForRelink clears bindings, index snapshot and tag cache only', async () => {
  setupMocks()
  initWebdav()
  // initWebdav's credential config queued a deferred clearWebdavFileIndex on
  // the scanner's persistence chain (stale-index invalidation). Let it settle
  // so the seed below is what the pre-wipe assertions actually observe.
  await new Promise((resolve) => setTimeout(resolve, 0))
  library.set([track()])

  updateMetadata({
    trackId: 't1',
    rating: 80,
    loved: true,
    fileType: 'flac',
    syncStatus: 'synced',
    lastModifiedLocally: 1,
    webdavPath: '/dav/files/user/Song.flac',
    webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
    matchSource: 'manual',
  })
  await db.webdavFileIndex.put({ id: 'main', entries: [entry()], buildTimestamp: 1, complete: true })
  await db.webdavFileTags.put({
    id: 'http://test.com|user\u0000/dav/files/user/Song.flac',
    baseKey: 'http://test.com|user',
    path: '/dav/files/user/Song.flac',
    size: 12345,
    status: 'ok',
    probedAt: 1,
  })
  // Preservation witnesses: the queue, the catalog cache and user settings
  // must survive the wipe untouched (they are outside the recovery scope).
  await db.playQueue.put({ id: 'main', userQueue: ['t1'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  await db.songLibraryCache.put({ id: 'main', tracks: [], lastScan: '2026-01-01T00:00:00Z' })
  await db.userSettings.put({ key: 'webdavUrl', value: 'http://test.com' })

  // The awaited put above flushed updateMetadata's fire-and-forget upsert, so
  // the metadata row is genuinely IN the Dexie stub — these assertions were
  // vacuous before the harness keyed localMetadata by trackId.
  assert.equal(memStores.localMetadata.size, 1, 'row round-trips through the Dexie stub (pre-wipe)')
  assert.equal(memStores.webdavFileIndex.size, 1, 'index snapshot present pre-wipe')
  assert.equal(memStores.webdavFileTags.size, 1, 'tag-cache row present pre-wipe')

  await wipeMetadataForRelink()

  assert.equal(memStores.localMetadata.size, 0, 'per-track metadata (bindings/ratings) wiped at the DB layer')
  assert.equal(memStores.webdavFileIndex.size, 0, 'persisted index snapshot wiped')
  assert.equal(memStores.webdavFileTags.size, 0, 'tag-probe cache wiped')
  assert.equal(get(metadataCache).size, 0, 'in-memory metadata cache cleared')
  assert.equal(get(metadataScanState).status, 'idle', 'scan state reset to idle')
  // Preservation: only the three metadata tables are in scope.
  assert.equal(memStores.playQueue.size, 1, 'play queue untouched')
  assert.equal(memStores.songLibraryCache.size, 1, 'song library cache untouched')
  assert.equal(memStores.userSettings.size, 1, 'user settings untouched')

  teardown()
})

test('resetMetadataAndRelink heals swapped auto bindings (wipe + full rescan)', async () => {
  setupMocks()
  initWebdav()

  const t1 = track({ trackId: 't1', title: 'Song A', artist: 'Artist', album: 'Album', size: 111 })
  const t2 = track({ trackId: 't2', title: 'Song B', artist: 'Artist', album: 'Album', size: 222 })
  library.set([t1, t2])

  // A previous bad pass SWAPPED the bindings: t1 owns B's file, t2 owns A's.
  // Both files still exist, so a plain force rescan alone can never heal this
  // (each bound path is excluded from the other track's candidate set) — only
  // wiping every binding at once makes each file claimable again.
  const pathA = '/dav/files/user/Song A.flac'
  const pathB = '/dav/files/user/Song B.flac'
  updateMetadata({
    trackId: 't1', rating: 60, loved: false, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathB, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })
  updateMetadata({
    trackId: 't2', rating: 80, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathA, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })

  mockEntries = [
    { path: pathA, filename: 'Song A.flac', size: 111, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathB, filename: 'Song B.flac', size: 222, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]
  mockComplete = true
  mockMeta = {
    [pathA]: fileMeta({ title: 'Song A', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 90, loved: true }),
    [pathB]: fileMeta({ title: 'Song B', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 60, loved: false }),
  }

  await resetMetadataAndRelink()

  const rowA = get(metadataCache).get('t1')
  const rowB = get(metadataCache).get('t2')
  assert.equal(rowA?.webdavPath, pathA, 't1 healed onto its own Song A file')
  assert.equal(rowA?.rating, 90, 't1 rating re-imported from the correct file')
  assert.equal(rowA?.loved, true, 't1 loved re-imported from the correct file')
  assert.equal(rowB?.webdavPath, pathB, 't2 healed onto its own Song B file')
  assert.equal(rowB?.rating, 60, 't2 rating re-imported from the correct file')
  assert.equal(rowB?.loved, false, 't2 loved re-imported from the correct file')
  assert.equal(get(metadataScanState).status, 'complete', 'reset scan completed')

  teardown()
})

test('resetMetadataAndRelink refuses to wipe when no library is loaded (nothing lost)', async () => {
  setupMocks()
  initWebdav()
  // Let initWebdav's queued stale-index clear settle before seeding (see the
  // wipe test for why).
  await new Promise((resolve) => setTimeout(resolve, 0))

  updateMetadata({
    trackId: 't1', rating: 80, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: '/dav/files/user/Song.flac',
    webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT', webdavBase: 'http://test.com|user',
  })
  await db.webdavFileIndex.put({ id: 'main', entries: [entry()], buildTimestamp: 1, complete: true })
  await db.webdavFileTags.put({
    id: 'http://test.com|user\u0000/dav/files/user/Song.flac',
    baseKey: 'http://test.com|user', path: '/dav/files/user/Song.flac',
    size: 12345, status: 'ok', probedAt: 1,
  })
  library.set([])

  await assert.rejects(
    resetMetadataAndRelink(),
    /No library loaded/,
    'reset refuses before wiping when the re-link scan would have nothing to match',
  )
  assert.equal(memStores.localMetadata.size, 1, 'metadata rows untouched by the refused reset')
  assert.equal(memStores.webdavFileIndex.size, 1, 'index snapshot untouched')
  assert.equal(memStores.webdavFileTags.size, 1, 'tag cache untouched')
  assert.equal(get(metadataCache).size, 1, 'in-memory cache untouched')

  teardown()
})

test('resetMetadataAndRelink throws an honest error when the re-link scan fails after the wipe', async () => {
  setupMocks()
  initWebdav()
  // Let initWebdav's queued stale-index clear settle before seeding (see the
  // wipe test for why).
  await new Promise((resolve) => setTimeout(resolve, 0))
  const t = track()
  library.set([t])

  updateMetadata({
    trackId: 't1', rating: 80, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: '/dav/files/user/Song.flac',
    webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT', webdavBase: 'http://test.com|user',
  })
  await db.webdavFileIndex.put({ id: 'main', entries: [entry()], buildTimestamp: 1, complete: true })
  await db.webdavFileTags.put({
    id: 'http://test.com|user\u0000/dav/files/user/Song.flac',
    baseKey: 'http://test.com|user', path: '/dav/files/user/Song.flac',
    size: 12345, status: 'ok', probedAt: 1,
  })

  // The WebDAV server dies between the wipe and the re-link PROPFIND. The
  // wipe already happened, so the reset must say so instead of resolving like
  // a success over a wiped library.
  buildFails = true
  await assert.rejects(resetMetadataAndRelink(), /re-link scan failed/, 'failure surfaces the post-wipe state')
  assert.equal(memStores.localMetadata.size, 0, 'wipe DID run before the scan failure')
  assert.equal(memStores.webdavFileIndex.size, 0, 'index snapshot wiped')
  assert.equal(memStores.webdavFileTags.size, 0, 'tag cache wiped')
  assert.equal(get(metadataScanState).status, 'error', 'scan error state is what the reset reacted to')

  teardown()
})

test('navidrome-mode reset: file tags never replace server ratings; the re-seed restores them', async () => {
  setupMocks()
  // ratingSource 'navidrome' → the SERVER is authoritative for rating/loved.
  settings.set({
    webdavUrl: 'http://test.com', webdavUser: 'user', webdavToken: 'token', ratingSource: 'navidrome',
  })
  setWebdavCredentials('http://test.com', 'user', 'token')

  const t1 = track({
    trackId: 'navidrome-s1', title: 'Song A', artist: 'Artist', album: 'Album', size: 111,
    userRating: 5, starred: true,
  })
  const t2 = track({
    trackId: 'navidrome-s2', title: 'Song B', artist: 'Artist', album: 'Album', size: 222,
    userRating: 2, starred: false,
  })
  library.set([t1, t2])

  // Swapped bindings (the recovery case) with stale local ratings that must
  // NOT survive: the server (5★/100, 2★/40) always wins over file tags (60/90).
  const pathA = '/dav/files/user/Song A.flac'
  const pathB = '/dav/files/user/Song B.flac'
  updateMetadata({
    trackId: 'navidrome-s1', rating: 60, loved: false, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathB, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })
  updateMetadata({
    trackId: 'navidrome-s2', rating: 90, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathA, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })

  mockEntries = [
    { path: pathA, filename: 'Song A.flac', size: 111, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathB, filename: 'Song B.flac', size: 222, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]
  mockComplete = true
  mockMeta = {
    [pathA]: fileMeta({ title: 'Song A', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 60, loved: false }),
    [pathB]: fileMeta({ title: 'Song B', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 90, loved: true }),
  }

  await resetMetadataAndRelink()

  const rowA = get(metadataCache).get('navidrome-s1')
  const rowB = get(metadataCache).get('navidrome-s2')
  assert.equal(rowA?.webdavPath, pathA, 's1 healed onto its own file')
  assert.equal(rowA?.rating, 100, 's1 server rating (5★) wins over the file tag 60')
  assert.equal(rowA?.loved, true, 's1 starred survives as loved')
  assert.equal(rowB?.webdavPath, pathB, 's2 healed onto its own file')
  assert.equal(rowB?.rating, 40, 's2 server rating (2★) wins over the file tag 90')
  assert.equal(rowB?.loved, false, 's2 unstarred stays unloved')
  assert.equal(get(metadataScanState).status, 'complete', 'reset scan completed')

  teardown()
})

// ── Heal pass: force scans release provably-wrong AUTO links (2026-09-05) ──
// A binding whose bound file's own identity tags prove it wrong (the file is
// another track, or its title is unrelated) is released BEFORE the drain, so
// the freed file becomes claimable and the same scan re-links everyone
// correctly. This is what makes a plain "Rescan All Metadata" heal swapped
// bindings — previously only the wipe-then-relink reset could. Manual,
// ignored and pending rows never reach the heal candidates.

test('force scan heals swapped auto bindings in one pass (release + re-link), no wipe needed', async () => {
  setupMocks()
  initWebdav()

  const t1 = track({ trackId: 't1', title: 'Song A', artist: 'Artist', album: 'Album', size: 111 })
  const t2 = track({ trackId: 't2', title: 'Song B', artist: 'Artist', album: 'Album', size: 222 })
  library.set([t1, t2])

  // A previous bad pass SWAPPED the bindings: t1 owns B's file, t2 owns A's.
  const pathA = '/dav/files/user/Song A.flac'
  const pathB = '/dav/files/user/Song B.flac'
  updateMetadata({
    trackId: 't1', rating: 60, loved: false, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathB, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })
  updateMetadata({
    trackId: 't2', rating: 80, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathA, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })

  mockEntries = [
    { path: pathA, filename: 'Song A.flac', size: 111, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathB, filename: 'Song B.flac', size: 222, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]
  mockComplete = true
  mockMeta = {
    [pathA]: fileMeta({ title: 'Song A', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 90, loved: true }),
    [pathB]: fileMeta({ title: 'Song B', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 60, loved: false }),
  }

  await scanAll('force')

  const rowA = get(metadataCache).get('t1')
  const rowB = get(metadataCache).get('t2')
  assert.equal(rowA?.webdavPath, pathA, 't1 healed onto its own file without a wipe')
  assert.equal(rowA?.rating, 90, 't1 rating follows the healed file (webdav mode)')
  assert.equal(rowA?.loved, true, 't1 loved follows the healed file')
  assert.equal(rowB?.webdavPath, pathB, 't2 healed onto its own file without a wipe')
  assert.equal(rowB?.rating, 60, 't2 rating follows the healed file')
  assert.equal(rowB?.loved, false, 't2 loved follows the healed file')
  assert.equal(readCallCount, 2, 'exactly the two forced heal reads; the drain reuses the probe cache')
  assert.equal(get(metadataScanState).status, 'complete', 'scan completed')
  assert.equal(get(metadataScanState).progress.released, 2, 'the scan-complete line reports the two healed links')

  // A second force scan must be stable: correct bindings with fresh tag cache
  // produce no heal reads, no releases, no churn.
  await scanAll('force')
  assert.equal(get(metadataCache).get('t1')?.webdavPath, pathA, 't1 binding stable across rescans')
  assert.equal(get(metadataCache).get('t2')?.webdavPath, pathB, 't2 binding stable across rescans')
  assert.equal(readCallCount, 2, 'second scan added no heal reads')
  assert.equal(get(metadataScanState).status, 'complete', 'second scan completed')
  assert.equal(get(metadataScanState).progress.released, undefined, 'a healthy rescan reports no healing')

  teardown()
})

test('heal pass never touches a manual binding, even when the file tags prove another owner', async () => {
  setupMocks()
  initWebdav()

  const t1 = track({ trackId: 't1', title: 'Song A', artist: 'Artist', album: 'Album', size: 111 })
  const t2 = track({ trackId: 't2', title: 'Song B', artist: 'Artist', album: 'Album', size: 222 })
  library.set([t1, t2])

  const pathA = '/dav/files/user/Song A.flac'
  const pathB = '/dav/files/user/Song B.flac'
  // BOTH links are wrong by the file tags' own testimony: t1 (Song A) is
  // MANUALLY bound to B (tags Song B), t2 (Song B) is AUTO-bound to A (tags
  // Song A). The heal pass must release ONLY the auto row — the user's manual
  // verdict is never auto-cleared anywhere, even when provably wrong.
  updateMetadata({
    trackId: 't1', rating: 40, loved: false, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathB, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user', matchSource: 'manual',
  })
  updateMetadata({
    trackId: 't2', rating: 80, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathA, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })

  mockEntries = [
    { path: pathA, filename: 'Song A.flac', size: 111, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathB, filename: 'Song B.flac', size: 222, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]
  mockComplete = true
  mockMeta = {
    [pathA]: fileMeta({ title: 'Song A', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 90, loved: true }),
    [pathB]: fileMeta({ title: 'Song B', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 60, loved: false }),
  }

  await scanAll('force')

  const rowA = get(metadataCache).get('t1')
  const rowB = get(metadataCache).get('t2')
  assert.equal(rowA?.webdavPath, pathB, 'manual binding untouched by the heal pass')
  assert.equal(rowA?.matchSource, 'manual', 'manual marker preserved')
  // D8 manual re-read semantics: the LINK is the user's verdict, but in
  // webdav mode the bound file's tags still propagate (rating 40 → 60 follows
  // the re-read file). The heal pass never ran on this row — the re-read is
  // the ordinary manual-binding scan path.
  assert.equal(rowA?.rating, 60, 'manual row re-read follows the bound file (D8)')
  assert.equal(rowB?.webdavPath, undefined, 'the provably-wrong AUTO link was released (manual protection only)')
  assert.equal(rowB?.rating, 80, 'released auto row keeps its values when nothing re-matches')
  assert.equal(rowB?.loved, true, 'released auto row keeps its loved flag')
  assert.equal(get(metadataScanState).status, 'complete')

  teardown()
})

test('heal pass never releases a pending_sync row and never re-reads its file', async () => {
  setupMocks()
  initWebdav()

  const t1 = track({ trackId: 't1', title: 'Song A', artist: 'Artist', album: 'Album', size: 111 })
  const t2 = track({ trackId: 't2', title: 'Song B', artist: 'Artist', album: 'Album', size: 222 })
  library.set([t1, t2])

  const pathA = '/dav/files/user/Song A.flac'
  const pathB = '/dav/files/user/Song B.flac'
  // t1 holds an un-pushed local edit (pending_sync) — D4 says scans must skip
  // it entirely; the heal pass inherits that protection. t2's AUTO link to A
  // is provably wrong (A's tags name t1's song) and must be released.
  updateMetadata({
    trackId: 't1', rating: 40, loved: false, fileType: 'flac', syncStatus: 'pending_sync',
    lastModifiedLocally: 1, webdavPath: pathB, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })
  updateMetadata({
    trackId: 't2', rating: 80, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathA, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })

  mockEntries = [
    { path: pathA, filename: 'Song A.flac', size: 111, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathB, filename: 'Song B.flac', size: 222, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]
  mockComplete = true
  mockMeta = {
    [pathA]: fileMeta({ title: 'Song A', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 90, loved: true }),
    [pathB]: fileMeta({ title: 'Song B', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 60, loved: false }),
  }

  await scanAll('force')

  const rowA = get(metadataCache).get('t1')
  const rowB = get(metadataCache).get('t2')
  assert.equal(rowA?.webdavPath, pathB, 'pending row keeps its link')
  assert.equal(rowA?.syncStatus, 'pending_sync', 'pending edit survives')
  assert.equal(rowA?.rating, 40, 'local rating not clobbered')
  assert.equal(rowB?.webdavPath, undefined, 'the provably-wrong auto sibling was still released')
  assert.equal(readCallCount, 1, 'only t2\'s file was heal-read (pending row never re-read)')
  assert.equal(get(metadataScanState).status, 'complete')

  teardown()
})

test('a modified scan never runs the heal pass (release is force-scan only)', async () => {
  setupMocks()
  initWebdav()

  const t1 = track({ trackId: 't1', title: 'Song A', artist: 'Artist', album: 'Album', size: 111 })
  const t2 = track({ trackId: 't2', title: 'Song B', artist: 'Artist', album: 'Album', size: 222 })
  library.set([t1, t2])

  const pathA = '/dav/files/user/Song A.flac'
  const pathB = '/dav/files/user/Song B.flac'
  updateMetadata({
    trackId: 't1', rating: 60, loved: false, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathB, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })
  updateMetadata({
    trackId: 't2', rating: 80, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathA, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })

  mockEntries = [
    { path: pathA, filename: 'Song A.flac', size: 111, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathB, filename: 'Song B.flac', size: 222, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]
  mockComplete = true
  mockMeta = {
    [pathA]: fileMeta({ title: 'Song A', artist: 'Artist', album: 'Album', trackNumber: 1 }),
    [pathB]: fileMeta({ title: 'Song B', artist: 'Artist', album: 'Album', trackNumber: 1 }),
  }

  await scanAll('modified')

  // Incremental scans are not the recovery action: unchanged stamps mean the
  // rows are not re-queued, no forced heal reads run, and the swap survives.
  assert.equal(get(metadataCache).get('t1')?.webdavPath, pathB, 'modified scan leaves bindings as-is')
  assert.equal(get(metadataCache).get('t2')?.webdavPath, pathA, 'modified scan leaves bindings as-is')
  assert.equal(readCallCount, 0, 'no heal reads on an incremental scan')
  assert.equal(get(metadataScanState).status, 'complete')

  teardown()
})

test('a released row that cannot re-match keeps its rating and surfaces unresolved', async () => {
  setupMocks()
  initWebdav()

  const t1 = track({ trackId: 't1', title: 'Song A', artist: 'Artist', album: 'Album', size: 111 })
  library.set([t1])

  // The auto binding points at a file whose tags name something unrelated and
  // no library track owns — provably wrong, so it is released; the drain then
  // cannot re-match it (the file's tags contradict the only track), so the row
  // stays unbound for File Matching with its rating preserved.
  const pathX = '/dav/files/user/Completely.flac'
  updateMetadata({
    trackId: 't1', rating: 60, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathX, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })

  mockEntries = [
    { path: pathX, filename: 'Completely.flac', size: 111, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]
  mockComplete = true
  mockMeta = {
    [pathX]: fileMeta({ title: 'A Different Song Entirely', artist: 'Someone', album: 'Elsewhere', trackNumber: 1, rating: 0, loved: false }),
  }

  await scanAll('force')

  const row = get(metadataCache).get('t1')
  assert.equal(row?.webdavPath, undefined, 'provably-wrong link released')
  assert.equal(row?.rating, 60, 'rating survives the release (no rebind, no clobber)')
  assert.equal(row?.loved, true, 'loved survives the release')
  assert.equal(row?.syncStatus, 'synced', 'row stays synced — surfaced to File Matching, not errored')
  assert.equal(get(metadataScanState).status, 'complete')

  teardown()
})

test('File Matching audits matched links from the tag cache: verified / conflict / not-read', async () => {
  setupMocks()
  initWebdav()
  // Let initWebdav's queued stale-index clear settle before refreshIndex
  // seeds the index snapshot.
  await new Promise((resolve) => setTimeout(resolve, 0))

  const t1 = track({ trackId: 't1', title: 'Song A', artist: 'Artist', size: 111 })
  const t2 = track({ trackId: 't2', title: 'Song B', artist: 'Artist', size: 222 })
  const t3 = track({ trackId: 't3', title: 'Song C', artist: 'Artist', size: 333 })
  library.set([t1, t2, t3])

  const pathA = '/dav/files/user/Song A.flac'
  const pathB = '/dav/files/user/Song B.flac'
  const pathC = '/dav/files/user/Song C.flac'
  // All three tracks are auto-bound on the CURRENT server.
  for (const [id, path] of [['t1', pathA], ['t2', pathB], ['t3', pathC]] as const) {
    updateMetadata({
      trackId: id, rating: 0, loved: false, fileType: 'flac', syncStatus: 'synced',
      lastModifiedLocally: 1, webdavPath: path, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      webdavBase: 'http://test.com|user',
    })
  }

  mockEntries = [
    { path: pathA, filename: 'Song A.flac', size: 111, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathB, filename: 'Song B.flac', size: 222, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathC, filename: 'Song C.flac', size: 333, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]
  mockComplete = true

  // Tag evidence lives in the persisted probe cache: A confirms its track, B
  // contradicts its track, C has never been read. The auditor must judge ALL
  // of them with ZERO file reads (listUnresolvedMatches never fetches).
  const base = 'http://test.com|user'
  const stamp = 'Mon, 01 Jan 2024 00:00:00 GMT'
  const mkTag = (path: string, meta: Partial<FileMetadata>): FileTagCacheEntry => ({
    id: `${base}\u0000${path}`,
    baseKey: base,
    path,
    size: path === pathA ? 111 : path === pathB ? 222 : 333,
    lastModified: stamp,
    metadata: fileMeta({ rating: 0, loved: false, ...meta }),
    status: 'ok',
    probedAt: 1,
  })
  await db.webdavFileTags.bulkPut([
    mkTag(pathA, { title: 'Song A', artist: 'Artist' }),
    mkTag(pathB, { title: 'Completely Different', artist: 'Someone' }),
  ])

  await refreshIndex()
  const result = await listUnresolvedMatches()

  const rowA = result.rows.find((r) => r.trackId === 't1')
  const rowB = result.rows.find((r) => r.trackId === 't2')
  const rowC = result.rows.find((r) => r.trackId === 't3')
  assert.equal(rowA?.kind, 'matched', 't1 stays a matched row')
  assert.equal(rowA?.verdict, 'verified', 'tags confirming the track verify the link')
  assert.equal(rowB?.verdict, 'conflict', 'contradicting tags surface as a conflict')
  assert.equal(rowB?.fileTitle, 'Completely Different', 'conflict reports the file title')
  assert.equal(rowC?.verdict, 'unknown', 'no evidence → honest unknown, never guessed')
  assert.equal(rowC?.readState, 'not-probed', 'and it says WHY: never read')
  assert.equal(result.counts.matched, 3, 'all three stay matched (audit never unlinks)')

  // Audit-worthy rows rank before the verified bulk so the display cap shows
  // the conflicts, not the healthy majority.
  const order = result.rows.map((r) => r.trackId)
  assert.ok(order.indexOf('t2') < order.indexOf('t1'), 'conflict sorts before verified')
  assert.ok(order.indexOf('t3') < order.indexOf('t1'), 'unknown sorts before verified')

  teardown()
})

test('File Matching flags exactly the conflicts a rescan will provably fix (`fixable`)', async () => {
  setupMocks()
  initWebdav()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const t1 = track({ trackId: 't1', title: 'Song A', artist: 'Artist', size: 111 })
  const t2 = track({ trackId: 't2', title: 'Song B', artist: 'Artist', size: 222 })
  const t3 = track({ trackId: 't3', title: 'Album Track', artist: 'Artist', size: 333 })
  const t4 = track({ trackId: 't4', title: 'Song D', artist: 'Artist', size: 444 })
  const t5 = track({ trackId: 't5', title: 'Song E', artist: 'Artist', size: 555 })
  library.set([t1, t2, t3, t4, t5])

  // Swapped pair: t1 holds B's file, t2 holds A's file — both auto-bound and
  // BOTH provably wrong (each file's tags name the other track).
  const pathA = '/dav/files/user/Song A.flac'
  const pathB = '/dav/files/user/Song B.flac'
  // Same-release family variant under t3: "(Live)" is plausibly the same
  // file — the heal deliberately keeps it (D8 live/feat trap).
  const pathLive = '/dav/files/user/Album Track (Live).flac'
  // t4 is a MANUAL pick bound to a file tagged as another song (t5's title) —
  // provable-looking, but manual rows are the user's verdict and never
  // auto-cleared, so it must NOT be flagged fixable.
  const pathE = '/dav/files/user/Song E.flac'
  const stamp = 'Mon, 01 Jan 2024 00:00:00 GMT'
  const base = 'http://test.com|user'
  const bindings: Array<{ id: string; path: string; source?: 'auto' | 'manual' }> = [
    { id: 't1', path: pathB },
    { id: 't2', path: pathA },
    { id: 't3', path: pathLive },
    { id: 't4', path: pathE, source: 'manual' },
  ]
  for (const { id, path, source } of bindings) {
    updateMetadata({
      trackId: id, rating: 0, loved: false, fileType: 'flac', syncStatus: 'synced',
      lastModifiedLocally: 1, webdavPath: path, webdavLastModified: stamp,
      webdavBase: base, matchSource: source,
    })
  }

  mockEntries = [
    { path: pathA, filename: 'Song A.flac', size: 111, lastModified: stamp },
    { path: pathB, filename: 'Song B.flac', size: 222, lastModified: stamp },
    { path: pathLive, filename: 'Album Track (Live).flac', size: 333, lastModified: stamp },
    { path: pathE, filename: 'Song E.flac', size: 444, lastModified: stamp },
  ]
  mockComplete = true

  const mkTag = (path: string, size: number, title: string): FileTagCacheEntry => ({
    id: `${base}\u0000${path}`,
    baseKey: base,
    path,
    size,
    lastModified: stamp,
    metadata: fileMeta({ rating: 0, loved: false, title, artist: 'Artist' }),
    status: 'ok',
    probedAt: 1,
  })
  await db.webdavFileTags.bulkPut([
    mkTag(pathA, 111, 'Song A'),
    mkTag(pathB, 222, 'Song B'),
    mkTag(pathLive, 333, 'Album Track (Live)'),
    mkTag(pathE, 444, 'Song E'),
  ])

  await refreshIndex()
  const result = await listUnresolvedMatches()
  const byId = new Map(result.rows.map((r) => [r.trackId, r]))

  // Swapped pair: both auto conflicts whose file tags name the other track —
  // the exact rows the force-scan heal releases (D16). Promise kept.
  assert.equal(byId.get('t1')?.verdict, 'conflict')
  assert.equal(byId.get('t1')?.fixable, true, 'auto + file is provably another song → fixable')
  assert.equal(byId.get('t2')?.fixable, true, 'swap is fixable from either side')
  // Family variant: conflict, but the heal keeps it → never promised.
  assert.equal(byId.get('t3')?.verdict, 'conflict')
  assert.equal(byId.get('t3')?.fixable, undefined, 'family-title conflict is not flagged fixable')
  // Manual: the user's verdict — never fixable even when the file title names
  // another library track (t5).
  assert.equal(byId.get('t4')?.matchSource, 'manual')
  assert.equal(byId.get('t4')?.verdict, 'conflict')
  assert.equal(byId.get('t4')?.fixable, undefined, 'manual conflicts are never auto-fixed')
  assert.equal(result.counts.matched, 4, 'audit still never unlinks anything')

  teardown()
})

test('ensureTagProbe completes without deadlock when index is not built', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  // This would have deadlocked before the fix (ensureTagProbe called
  // refreshIndex which called waitForCurrentTagProbe waiting for itself).
  // The state reset guarantees indexBuilt=false here — the deadlock path is
  // genuinely exercised, not skipped because an earlier test built the index.
  const result = await ensureTagProbe()
  assert.ok(result instanceof Set, 'probe completes without deadlock')
  assert.equal(buildCallCount, 1, 'probe built the missing index itself')

  teardown()
})

// ── Reset cancellation (2026-09-06) ─────────────────────────────────────────
// The wipe-then-relink reset is the longest DESTRUCTIVE operation, so it
// accepts an `isCancelled` closure checked between phases (pre-wipe, post-wipe,
// post-scan) and — for the scan phase — through the SAME cancelScan()
// machinery the scan Cancel button uses. A cancelled reset must land
// RESUMABLY: scanned files keep their fresh links, the scan state carries the
// honest "Cancelled — N of M" annotation, and a follow-up Rescan finishes the
// re-link. A scan stopped by ANY cancel source must never surface as a
// successful reset (scanAll now resolves { cancelled }).

test('resetMetadataAndRelink: cancel before the wipe runs nothing destructive', async () => {
  setupMocks()
  initWebdav()
  await new Promise((resolve) => setTimeout(resolve, 0))
  library.set([track()])

  updateMetadata({
    trackId: 't1', rating: 80, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: '/dav/files/user/Song.flac',
    webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT', webdavBase: 'http://test.com|user',
  })
  await db.webdavFileIndex.put({ id: 'main', entries: [entry()], buildTimestamp: 1, complete: true })
  await db.webdavFileTags.put({
    id: 'http://test.com|user\u0000/dav/files/user/Song.flac',
    baseKey: 'http://test.com|user', path: '/dav/files/user/Song.flac',
    size: 12345, status: 'ok', probedAt: 1,
  })

  const result = await resetMetadataAndRelink({ isCancelled: () => true })

  assert.equal(result.cancelled, true, 'reset reports the pre-wipe cancellation')
  assert.equal(buildCallCount, 0, 'no PROPFIND — the re-link scan never started')
  assert.equal(memStores.localMetadata.size, 1, 'metadata row untouched')
  assert.equal(memStores.webdavFileIndex.size, 1, 'index snapshot untouched')
  assert.equal(memStores.webdavFileTags.size, 1, 'tag cache untouched')
  assert.equal(get(metadataCache).size, 1, 'in-memory cache untouched')

  teardown()
})

test('resetMetadataAndRelink: mid-scan cancel keeps scanned links, discards in-flight work, and a follow-up scan finishes the re-link', async () => {
  setupMocks()
  initWebdav()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const t1 = track({ trackId: 't1', title: 'Song A', artist: 'Artist', album: 'Album', size: 111 })
  const t2 = track({ trackId: 't2', title: 'Song B', artist: 'Artist', album: 'Album', size: 222 })
  const t3 = track({ trackId: 't3', title: 'Song C', artist: 'Artist', album: 'Album', size: 333 })
  library.set([t1, t2, t3])

  // Stale swapped bindings for t1/t2 — exactly the recovery case the reset
  // exists for; t3 has never been linked.
  const pathA = '/dav/files/user/Song A.flac'
  const pathB = '/dav/files/user/Song B.flac'
  const pathC = '/dav/files/user/Song C.flac'
  updateMetadata({
    trackId: 't1', rating: 60, loved: false, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathB, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })
  updateMetadata({
    trackId: 't2', rating: 80, loved: true, fileType: 'flac', syncStatus: 'synced',
    lastModifiedLocally: 1, webdavPath: pathA, webdavLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    webdavBase: 'http://test.com|user',
  })

  mockEntries = [
    { path: pathA, filename: 'Song A.flac', size: 111, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathB, filename: 'Song B.flac', size: 222, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathC, filename: 'Song C.flac', size: 333, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]
  mockComplete = true
  mockMeta = {
    [pathA]: fileMeta({ title: 'Song A', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 90, loved: true }),
    [pathB]: fileMeta({ title: 'Song B', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 60, loved: false }),
    [pathC]: fileMeta({ title: 'Song C', artist: 'Artist', album: 'Album', trackNumber: 1, rating: 70, loved: false }),
  }

  // Deterministic mid-scan cancel: the FIRST file read (t1's worker) blocks
  // on a one-shot gate while the other two workers complete their rows. This
  // per-test readFile override replaces the shared harness mock so the gate
  // hits exactly one worker (the shared readGate would freeze all three).
  let releaseFirst: (() => void) | null = null
  const firstReadGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  let firstReadStarted = false
  let completedReads = 0
  __setScannerDeps({
    buildIndex: async () => ({ entries: mockEntries, complete: mockComplete }),
    readFile: async (_baseUrl: string, filePath: string) => {
      if (!firstReadStarted) {
        firstReadStarted = true
        await firstReadGate
      }
      completedReads++
      const meta = mockMeta[filePath]
      if (!meta) throw new Error(`No mock metadata for ${filePath}`)
      return meta
    },
  })

  let resetCancelled: boolean | null = null
  const resetPromise = resetMetadataAndRelink({ isCancelled: () => resetCancelled === true })
    .then((r) => { resetCancelled = r.cancelled; return r })

  // Wait for the two ungated workers to finish their re-links (the gated
  // worker holds t1's read in flight).
  for (let i = 0; i < 500 && completedReads < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(completedReads, 2, 'two workers completed their reads before the cancel')
  assert.equal(get(metadataCache).get('t2')?.webdavPath, pathB, 't2 re-linked while the scan ran')
  assert.equal(get(metadataCache).get('t3')?.webdavPath, pathC, 't3 bound while the scan ran')

  // Cancel mid-scan: the same two-step the view's Cancel button performs —
  // set the reset flag AND stop the scan via cancelScan().
  resetCancelled = true
  cancelScan()
  releaseFirst!()
  const result = await resetPromise

  assert.equal(result.cancelled, true, 'reset reports the mid-scan cancellation')
  assert.equal(get(metadataCache).get('t2')?.webdavPath, pathB, 't2 keeps its fresh link (processed rows survive)')
  assert.equal(get(metadataCache).get('t2')?.rating, 60, 't2 rating re-imported from its file before the cancel')
  assert.equal(get(metadataCache).get('t3')?.webdavPath, pathC, 't3 keeps its fresh binding')
  assert.equal(get(metadataCache).get('t1'), undefined, 'in-flight row was generation-dropped, not resurrected after the wipe')
  // The wipe-reset's scan reads files in its INLINE PROBE phase, whose
  // progress rides tagProbeState; cancelScan()'s gen bump then stops the run
  // before the drain queue is even built. So the scan-state landing is the
  // honest "0 of 0" (nothing reached the drain) while the PROBE-side  // bookkeeping (tagProbeState.done) carries the real work count.
  const scanState = get(metadataScanState)
  assert.equal(scanState.status, 'complete', 'cancelScan landed an honest complete state')
  assert.match(scanState.progress.annotation ?? '', /^Cancelled — /, 'annotation reports the cancellation')
  assert.equal(scanState.progress.total, 0, 'drain total is 0: the probe phase did the binding and the gen bump stopped the rest')
  assert.equal(get(tagProbeState).done, 2, 'probe-side bookkeeping counted the two completed file reads')
  assert.equal(scanState.progress.cancelledShape, 'force', 'the landing carries the interrupted scan shape for the Resume affordance')

  // Resumability: the follow-up ordinary scan finishes the re-link — t1's
  // file is claimable (its binding was wiped) and binds correctly.
  await scanAll('force')
  assert.equal(get(metadataCache).get('t1')?.webdavPath, pathA, 'follow-up scan re-links the cancelled track')
  assert.equal(get(metadataCache).get('t1')?.rating, 90, 't1 rating follows its healed file')
  assert.equal(get(metadataScanState).status, 'complete', 'follow-up scan completed')
  assert.equal(get(metadataScanState).progress.cancelledShape, undefined, 'a fresh scan landing clears the resume marker')

  teardown()
})

test('cancelScan stamps the landing with the scan shape; ordinary scans do not carry it', async () => {
  setupMocks()
  initWebdav()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const t1 = track({ trackId: 't1', title: 'Song A', artist: 'Artist', album: 'Album', size: 111 })
  const t2 = track({ trackId: 't2', title: 'Song B', artist: 'Artist', album: 'Album', size: 222 })
  library.set([t1, t2])

  const pathA = '/dav/files/user/Song A.flac'
  const pathB = '/dav/files/user/Song B.flac'
  mockEntries = [
    { path: pathA, filename: 'Song A.flac', size: 111, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
    { path: pathB, filename: 'Song B.flac', size: 222, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  ]
  mockComplete = true
  mockMeta = {
    [pathA]: fileMeta({ title: 'Song A', artist: 'Artist', album: 'Album', trackNumber: 1 }),
    [pathB]: fileMeta({ title: 'Song B', artist: 'Artist', album: 'Album', trackNumber: 1 }),
  }

  // A plain MODIFIED scan with nothing cached: everything is unmatched → the
  // drain runs all rows. Cancel mid-drain via a read gate, then verify the
  // landing carries the MODIFIED shape (not force).
  let releaseA: (() => void) | null = null
  const gateA = new Promise<void>((resolve) => { releaseA = resolve })
  let gatedOnce = false
  let completed = 0
  __setScannerDeps({
    buildIndex: async () => ({ entries: mockEntries, complete: mockComplete }),
    readFile: async (_b: string, filePath: string) => {
      if (!gatedOnce) {
        gatedOnce = true
        await gateA
      }
      completed++
      return mockMeta[filePath]!
    },
  })
  const scanPromise = scanAll('modified')
  for (let i = 0; i < 500 && completed < 1; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal(completed, 1, 'one row completed before the cancel')
  cancelScan()
  releaseA!()
  const res = await scanPromise
  assert.equal(res.cancelled, true, 'the modified scan reports cancelled')
  assert.equal(get(metadataScanState).progress.cancelledShape, 'modified', 'landing carries the modified shape')

  // An ordinary completed scan (no cancel) does NOT carry the marker.
  await scanAll('modified')
  assert.equal(get(metadataScanState).progress.cancelledShape, undefined, 'completed scans have no resume marker')

  teardown()
})
