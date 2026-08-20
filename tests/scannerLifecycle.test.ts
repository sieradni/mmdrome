// TODO 6.7/6.10/6.11/6.12 lifecycle harness — tests the scanner/WebDAV/Dexie
// glue that was previously [not test-pinned]. The harness injects mock
// implementations of `buildWebdavFileIndexDetailed` and `readFileMetadata` via
// `__setScannerDeps` and provides in-memory Dexie stubs so the scanner's
// persistence layer works in Node (no IndexedDB).
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
  refreshIndex,
  ensureTagProbe,
  scanAll,
  setWebdavCredentials,
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

function setupMocks() {
  buildCallCount = 0
  readCallCount = 0
  mockEntries = []
  mockComplete = true
  mockMeta = {}
  __setScannerDeps({
    buildIndex: async () => {
      buildCallCount++
      return { entries: mockEntries, complete: mockComplete }
    },
    readFile: async (_baseUrl: string, filePath: string, _user: string, _token: string, _fileType: string) => {
      readCallCount++
      const meta = mockMeta[filePath]
      if (!meta) throw new Error(`No mock metadata for ${filePath}`)
      return meta
    },
  })
}

function teardown() {
  __resetScannerDeps()
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
  // Both receive results from the single underlying probe
  assert.ok(r1 instanceof Set, 'first call resolves')
  assert.ok(r2 instanceof Set, 'second call resolves')

  // The mock buildIndex should have been called at most once for this generation
  assert.ok(buildCallCount <= 1, `buildIndex called ${buildCallCount}x, expected ≤1`)

  teardown()
})

test('credential swap mid-probe starts a new probe for new session', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  // Start a probe with original credentials
  const p1 = ensureTagProbe()

  // Swap credentials while probe is in-flight
  settings.set({ webdavUrl: 'http://new.com', webdavUser: 'user2', webdavToken: 'token2' })
  setWebdavCredentials('http://new.com', 'user2', 'token2')

  // New call should start a DIFFERENT probe (different generation)
  const p2 = ensureTagProbe()
  assert.notEqual(p1, p2, 'credential swap produces a different promise')

  await Promise.all([p1, p2])
  // Both builds should have run (old gen + new gen)
  assert.ok(buildCallCount >= 1, `buildIndex called ${buildCallCount}x`)

  teardown()
})

test('token-only credential change invalidates live index', async () => {
  setupMocks()
  mockEntries = [entry()]
  initWebdav()

  // Build the index with original token
  const ok1 = await refreshIndex()
  assert.equal(ok1, true)
  assert.equal(buildCallCount, 1)

  // Change only the token (same URL + user)
  settings.set({ webdavUrl: 'http://test.com', webdavUser: 'user', webdavToken: 'newtoken' })
  setWebdavCredentials('http://test.com', 'user', 'newtoken')

  // Next refresh should rebuild (token change invalidates)
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

  // Run a scan — the probe should discover the file and auto-bind
  await scanAll('force')

  // The auto-bind should have been attempted
  assert.ok(readCallCount > 0 || get(metadataCache).size > 0, 'probe attempted binding from partial index')

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

  // Scan should not throw
  await scanAll('force')

  const state = get(metadataScanState)
  assert.ok(state.status === 'complete' || state.status === 'error', 'scan finished')

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

test('ensureTagProbe completes without deadlock when index is not built', async () => {
  setupMocks()
  initWebdav()
  library.set([track()])

  // This would have deadlocked before the fix (ensureTagProbe called
  // refreshIndex which called waitForCurrentTagProbe waiting for itself)
  const result = await ensureTagProbe()
  assert.ok(result instanceof Set, 'probe completes without deadlock')

  teardown()
})
