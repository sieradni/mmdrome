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
import type { WebdavFileEntry } from '../src/lib/db'
import {
  __setScannerDeps,
  __resetScannerDeps,
  __resetScannerState,
  refreshIndex,
  ensureTagProbe,
  scanAll,
  setWebdavCredentials,
  tagProbeState,
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
  __setScannerDeps({
    buildIndex: async () => {
      buildCallCount++
      const gate = buildGate
      if (gate) await gate
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
}

// Patch Dexie table prototype methods once (all tables share the prototype).
const tableProto = Object.getPrototypeOf(db.webdavFileIndex)

tableProto.get = async function (this: { name: string }, key: string) {
  return memStores[this.name]?.get(key) ?? undefined
}

tableProto.put = async function (this: { name: string }, entry: MemEntry) {
  const store = memStores[this.name]
  if (store && entry?.id != null) store.set(String(entry.id), { ...entry })
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
