import type { Page } from '@playwright/test'

/**
 * Route-mocked WebDAV server for the e2e specs (File Matching / rescan heal +
 * Push Changes). The app runs the REAL bundle against this fake server at the
 * network layer (Playwright fulfills, so the cross-origin fake host never
 * reaches CORS the way a real server would — same technique as the
 * route-mocked Subsonic in sync.spec.ts).
 *
 * State is MUTABLE, like a real server:
 * - `PROPFIND` (any Depth) → a flat `DAV:` multistatus listing the collection
 *   plus every non-temp file with an exact `getcontentlength` and a stable
 *   `getlastmodified` (the two values the scan's cache-freshness predicate
 *   keys on). mtime advances on MOVE so a post-push scan re-probes.
 * - `GET` (Range ignored) → the full current bytes + an `ETag`, so Push's
 *   concurrency check (GET etag → PUT temp → MOVE with `If-Match`) is real.
 * - `PUT` → stores the body under the request path (temp file), assigns a new
 *   etag, returns 201 + ETag.
 * - `MOVE` → honors `If-Match` against the destination's CURRENT etag
 *   (412 when it no longer matches), renames temp → destination, advances the
 *   destination mtime, returns 201.
 * - Conflict simulation (opt-in, `armConflict(destPath)`): BEFORE honoring
 *   If-Match, the first N MOVEs against a destination replay a concurrent
 *   writer — the stored bytes are replaced and the etag/mtime advanced — then
 *   respond 412. The arm's returned etag is what the client must have captured
 *   to eventually succeed, so a passing spec PROVES the client re-GET after
 *   412 (Push's documented single retry: re-read → re-modify → re-PUT → MOVE
 *   with the fresh etag).
 * - `DELETE` → removes the path (the app's temp cleanup on MOVE failure).
 * - `OPTIONS` → CORS preflight (the app sends Authorization/Destination/
 *   If-Match headers, making the fetches non-simple).
 *
 * Counters + inspectors let specs assert the write path happened exactly once,
 * left no `.mmdrome-tmp` orphan, and physically changed the stored bytes.
 */

const MTIME = 'Mon, 01 Jan 2024 00:00:00 GMT'
const MTIME_AFTER_WRITE = 'Tue, 02 Jan 2024 00:00:00 GMT'

// Mirrors src/lib/webdavUtils: <file>.mmdrome-tmp is the atomic-write temp
// name; it must never appear in PROPFIND listings and must not survive a
// successful push.
const MMDROME_TMP_SUFFIX = '.mmdrome-tmp'

export interface MockedFile {
  /** Relative path against the WebDAV base (e.g. "Song One.mp3"). */
  path: string
  bytes: Buffer
}

interface StoredFile {
  bytes: Buffer
  etag: string
  mtime: string
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'PROPFIND, GET, PUT, MOVE, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  // ETag is NOT a CORS-safelisted response header — without this the browser
  // hides it from res.headers.get('ETag'), Push loses its concurrency token,
  // and every If-Match assertion in these specs becomes vacuous.
  'Access-Control-Expose-Headers': 'ETag',
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function multistatusXml(baseUrl: string, files: Array<{ path: string; size: number; mtime: string }>): string {
  const responses = [
    // The collection itself (so Depth:1 crawls never trigger).
    `<d:response><d:href>${escapeXml(baseUrl)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
    ...files.map((f) => (
      `<d:response><d:href>${escapeXml(`${baseUrl}${f.path}`)}</d:href>`
      + `<d:propstat><d:prop>`
      + `<d:getcontentlength>${f.size}</d:getcontentlength>`
      + `<d:getlastmodified>${f.mtime}</d:getlastmodified>`
      + `<d:resourcetype/>`
      + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
    )),
  ]
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`
}

export interface WebdavMockStats {
  getReadCount: () => number
  getPropfindCount: () => number
  getPutCount: () => number
  getMoveCount: () => number
  getDeleteCount: () => number
  /** Current bytes of a stored file (after any PUT/MOVE). */
  bytesOf: (path: string) => Buffer | undefined
  /** All stored relative paths — lets specs assert no temp orphan remains. */
  storedPaths: () => string[]
  /** Opt-in: the first `times` MOVEs on `destPath` mutate the stored file
   *  (concurrent-writer replay: new bytes + etag + mtime) and return 412.
   *  `bytes` should be VALID parseable audio (a realistic concurrent writer —
   *  e.g. MusicBee — leaves a playable file, and Push's retry re-modifies
   *  whatever it re-GETs). Returns the etag the concurrent writer leaves
   *  behind — the etag a correct client must re-GET to eventually succeed. */
  armConflict: (destPath: string, times?: number, bytes?: Buffer) => string
  /** Delay every GET by `ms` (slow-server simulation); pass 0 to restore. */
  setGetDelay: (ms: number) => void
  /** How many 412s the mock actually served (spec asserts the arm fired). */
  getConflictCount: () => number
}

export async function installWebdavMock(
  page: Page,
  opts: { baseUrl: string; files: MockedFile[] },
): Promise<WebdavMockStats> {
  let reads = 0
  let propfinds = 0
  let puts = 0
  let moves = 0
  let deletes = 0
  let conflictsServed = 0
  let etagCounter = 0
  /** When set, GET responses are delayed by this many ms (a slow server), so
   *  specs can interact with the app WHILE a push row is in flight. */
  let getDelayMs = 0

  // Conflict arms, keyed by the DESTINATION relative path. Two entries: how
  // many 412s remain, and the etag the concurrent writer leaves behind — the
  // etag a correct client MUST capture via re-GET to eventually succeed.
  const conflictArms = new Map<string, { remaining: number; newEtag: string; newBytes: Buffer }>()

  const store = new Map<string, StoredFile>()
  for (const f of opts.files) {
    store.set(f.path, { bytes: f.bytes, etag: `"etag-${++etagCounter}"`, mtime: MTIME })
  }
  const baseUrl = opts.baseUrl
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '')
  const toRel = (fullUrl: string): string | null => {
    try {
      const pathname = decodeURIComponent(new URL(fullUrl).pathname)
      if (!pathname.toLowerCase().startsWith(basePath.toLowerCase())) return null
      return pathname.slice(basePath.length).replace(/^\/+/, '')
    } catch {
      return null
    }
  }

  // Scoped to the dav ORIGIN so this handler never shadows the Subsonic mock
  // or the app's own asset requests (no fallback chaining needed).
  await page.route(`${new URL(baseUrl).origin}/**`, async (route) => {
    const req = route.request()
    const url = req.url()
    if (!url.startsWith(baseUrl.replace(/\/$/, ''))) return route.fallback()
    const method = req.method().toUpperCase()
    const rel = toRel(url)

    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    if (method === 'PROPFIND') {
      propfinds++
      const listing = [...store.entries()]
        .filter(([path]) => !path.endsWith(MMDROME_TMP_SUFFIX))
        .map(([path, f]) => ({ path, size: f.bytes.length, mtime: f.mtime }))
      await route.fulfill({
        status: 207,
        headers: { ...CORS, 'Content-Type': 'application/xml; charset=utf-8' },
        body: multistatusXml(baseUrl, listing),
      })
      return
    }
    if (method === 'GET') {
      if (!rel) {
        await route.fulfill({ status: 404, headers: CORS, body: 'not found' })
        return
      }
      const file = store.get(rel)
      if (!file) {
        await route.fulfill({ status: 404, headers: CORS, body: 'not found' })
        return
      }
      reads++
      if (getDelayMs > 0) await new Promise((r) => setTimeout(r, getDelayMs))
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', ETag: file.etag },
        body: file.bytes,
      })
      return
    }
    if (method === 'PUT') {
      if (!rel) {
        await route.fulfill({ status: 400, headers: CORS, body: 'bad path' })
        return
      }
      const body = req.postDataBuffer()
      if (!body) {
        await route.fulfill({ status: 400, headers: CORS, body: 'no body' })
        return
      }
      puts++
      const etag = `"etag-${++etagCounter}"`
      store.set(rel, { bytes: body, etag, mtime: MTIME })
      await route.fulfill({ status: 201, headers: { ...CORS, ETag: etag }, body: '' })
      return
    }
    if (method === 'MOVE') {
      if (!rel) {
        await route.fulfill({ status: 400, headers: CORS, body: 'bad source' })
        return
      }
      moves++
      const destHeader = req.headers().destination
      const destRel = destHeader ? toRel(destHeader) : null
      if (!destRel) {
        await route.fulfill({ status: 400, headers: CORS, body: 'bad destination' })
        return
      }
      const source = store.get(rel)
      if (!source) {
        await route.fulfill({ status: 404, headers: CORS, body: 'no temp file' })
        return
      }
      // Concurrency check: the app sends the etag it got from its GET; honor
      // it against the DESTINATION's CURRENT state (a real server would).
      // The conflict arm mutates that state FIRST — the concurrent write
      // landed between the client's GET and this MOVE — so the precondition
      // must be evaluated against the POST-mutation etag (capturing the
      // snapshot before the mutation would wrongly let the stale etag match).
      const arm = conflictArms.get(destRel)
      if (arm && arm.remaining > 0) {
        arm.remaining--
        conflictsServed++
        store.set(destRel, { bytes: arm.newBytes, etag: arm.newEtag, mtime: MTIME_AFTER_WRITE })
      }
      const dest = store.get(destRel)
      const ifMatch = req.headers()['if-match']
      if (ifMatch && dest && dest.etag !== ifMatch) {
        await route.fulfill({ status: 412, headers: CORS, body: 'precondition failed' })
        return
      }
      const etag = `"etag-${++etagCounter}"`
      store.delete(rel) // the temp is gone after a successful MOVE
      store.set(destRel, { bytes: source.bytes, etag, mtime: MTIME_AFTER_WRITE })
      await route.fulfill({ status: 201, headers: { ...CORS, ETag: etag }, body: '' })
      return
    }
    if (method === 'DELETE') {
      deletes++
      if (rel) store.delete(rel)
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    await route.fulfill({ status: 405, headers: CORS, body: 'unsupported' })
  })

  return {
    getReadCount: () => reads,
    getPropfindCount: () => propfinds,
    getPutCount: () => puts,
    getMoveCount: () => moves,
    getDeleteCount: () => deletes,
    getConflictCount: () => conflictsServed,
    bytesOf: (path: string) => store.get(path)?.bytes,
    storedPaths: () => [...store.keys()],
    armConflict: (destPath: string, times = 1, bytes = Buffer.from('conflict-write')) => {
      const newEtag = `"etag-${++etagCounter}"`
      conflictArms.set(destPath, { remaining: times, newEtag, newBytes: bytes })
      return newEtag
    },
    /** Delay every GET by `ms` (slow-server simulation); pass 0 to restore. */
    setGetDelay: (ms: number) => {
      getDelayMs = ms
    },
  }
}
