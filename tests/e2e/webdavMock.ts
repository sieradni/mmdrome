import type { Page } from '@playwright/test'

/**
 * Which MOVE precondition forms this fake server honours. See the module doc.
 */
export type WebdavPreconditionDialect = 'tagged-if' | 'ignored'

/**
 * Route-mocked WebDAV server for the e2e specs (File Matching / rescan heal +
 * Push Changes). The app runs the REAL bundle against this fake server at the
 * network layer (Playwright fulfills, so the cross-origin fake host never
 * reaches CORS the way a real server would — same technique as the
 * route-mocked Subsonic in sync.spec.ts).
 *
 * State is MUTABLE, like a real server:
 * - `PROPFIND Depth: 0` → ONE response for the requested resource with its
 *   `getetag` + `getlastmodified` (404 when it is gone). This is what the write
 *   core reads: the destination's validators, from where the server itself
 *   publishes them, immediately before it replaces the file.
 * - `PROPFIND` (other Depth) → a flat `DAV:` multistatus listing the collection
 *   plus every non-temp file with an exact `getcontentlength`, a
 *   `getlastmodified` and a `getetag` (the scan's cache-freshness predicate
 *   keys on the first two). mtime advances on MOVE so a post-push scan
 *   re-probes.
 * - `GET` (Range ignored) → the full current bytes + an `ETag`.
 * - `setPreconditionDialect(mode)` selects which MOVE precondition forms the
 *   server honours: `tagged-if` (the default, RFC 4918 — the tagged list
 *   guards the destination while `If-Match` is scoped to the SOURCE, as
 *   sabre/dav does) or `ignored` (no precondition is evaluated at all, so only
 *   the client's own pre-MOVE re-check can refuse a concurrent write; the
 *   ladder's behaviour against a server that REFUSES the tagged dialect is
 *   covered on a real socket in `realservers.spec.ts`).
 * - `PUT` → stores the body under the request path (temp file), assigns a new
 *   etag, returns 201 + ETag.
 * - `MOVE` → evaluates preconditions the way RFC 7232 / RFC 4918 and the real
 *   servers do it (this mock used to be WRONG in the client's favour — see
 *   below):
 *     * `If-Match` is scoped to the REQUEST URI, i.e. the temp SOURCE. sabre/dav
 *       (Nextcloud) implements it with `$request->getPath()` in
 *       `Server::checkPreconditions`, so a destination etag sent there always
 *       mismatches → 412. This mock models that, which means a client that
 *       guards the MOVE with `If-Match: <destination etag>` fails every row
 *       here — exactly as it does against a real server.
 *     * the WebDAV `If` header's tagged list (`If: <dest-url> (["etag"])`) is
 *       scoped to the URI it names, so it is the ONLY thing that can guard the
 *       destination. 412 when that node's current etag differs.
 *   Then it renames temp → destination, advances the destination mtime and
 *   returns 201.
 * - Conflict simulation (opt-in, `armConflict(destPath)`): BEFORE evaluating
 *   the MOVE preconditions, the first N MOVEs against a destination replay a
 *   concurrent writer — the stored bytes are replaced and the etag/mtime advanced — then
 *   respond 412. The arm's returned etag is what the client must have captured
 *   to eventually succeed, so a passing spec PROVES the client re-GET after
 *   412 (Push's documented single retry: re-read → re-modify → re-PUT → MOVE
 *   with the fresh etag).
 * - `DELETE` → removes the path (the app's temp cleanup on MOVE failure).
 * - `OPTIONS` → CORS preflight (the app sends Authorization/Destination/`If`
 *   headers, making the fetches non-simple).
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
  // and every precondition assertion in these specs becomes vacuous.
  'Access-Control-Expose-Headers': 'ETag',
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function multistatusXml(
  baseUrl: string,
  files: Array<{ path: string; size: number; mtime: string; etag?: string }>,
  opts: { withCollection?: boolean } = {},
): string {
  const responses = [
    // The collection itself (so Depth:1 crawls never trigger).
    ...(opts.withCollection === false
      ? []
      : [`<d:response><d:href>${escapeXml(baseUrl)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`]),
    ...files.map((f) => (
      `<d:response><d:href>${escapeXml(`${baseUrl}${f.path}`)}</d:href>`
      + `<d:propstat><d:prop>`
      + `<d:getcontentlength>${f.size}</d:getcontentlength>`
      + `<d:getlastmodified>${f.mtime}</d:getlastmodified>`
      + (f.etag ? `<d:getetag>${escapeXml(f.etag)}</d:getetag>` : '')
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
  /** Opt-in: the first `times` writers on `destPath` mutate the stored file
   *  (concurrent-writer replay: new bytes + etag + mtime). `when: 'move'` (the
   *  default) replays it inside the MOVE — the writer lands between the client's
   *  read and the rename — and answers 412. `when: 'put'` replays it when the
   *  client's TEMP upload lands, i.e. while the client is still working: the
   *  case only the pre-MOVE re-check can catch, which is what makes the
   *  collision check portable to a server that honours no precondition at all.
   *  `bytes` should be VALID parseable audio (a realistic concurrent writer —
   *  e.g. MusicBee — leaves a playable file, and Push's recovery re-modifies
   *  whatever it re-GETs). Returns the etag the concurrent writer leaves
   *  behind — the etag a correct client must re-GET to eventually succeed. */
  armConflict: (destPath: string, times?: number, bytes?: Buffer, when?: 'move' | 'put') => string
  /** Selects which precondition forms the server honours (see the module doc).
   *  Default: `tagged-if`. */
  setPreconditionDialect: (mode: WebdavPreconditionDialect) => void
  /** Delay every GET by `ms` (slow-server simulation); pass 0 to restore. */
  setGetDelay: (ms: number) => void
  /** How many simulated concurrent writes actually fired. */
  getConflictCount: () => number
  /** Headers of the last MOVE request received (wire-level assertions). */
  lastMoveHeaders: () => Record<string, string> | null
  /** Opt-in: the next `times` MOVEs on `destPath` fail with `status` (a server
   *  refusing the rename AFTER the temp was written) so the push result line
   *  has to surface a real cause, not just a count. */
  armMoveFailure: (destPath: string, status: number, times?: number) => void
  /** Opt-in: delete `destPath` during the next `times` temp uploads, so the
   *  pre-MOVE destination read detects a concurrent deletion. */
  armVanish: (destPath: string, times?: number) => void
  /** Opt-in: drop the connection instead of answering the next `times` MOVEs
   *  on `destPath` (a response lost after the rename may have happened). The
   *  client must report an UNCERTAIN remote state, not a failure and not a
   *  success. */
  armMoveAbort: (destPath: string, times?: number) => void
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
  const conflictArms = new Map<string, { remaining: number; newEtag: string; newBytes: Buffer; when: 'move' | 'put' }>()
  let dialect: WebdavPreconditionDialect = 'tagged-if'
  /** The destination a temp path belongs to (run token and suffix stripped). */
  const destKeyOfTemp = (rel: string): string => {
    const base = rel.endsWith(MMDROME_TMP_SUFFIX) ? rel.slice(0, -MMDROME_TMP_SUFFIX.length) : rel
    const withoutToken = base.replace(/\.[A-Za-z0-9_-]+$/, '')
    return conflictArms.has(withoutToken) && !conflictArms.has(base) ? withoutToken : base
  }
  /** Forced MOVE failures, keyed by destination relative path. */
  const moveFailureArms = new Map<string, { remaining: number; status: number }>()
  /** Concurrent-deleter arms, keyed by destination relative path. */
  const vanishArms = new Map<string, number>()
  /** Lost-MOVE-response arms, keyed by destination relative path. */
  const moveAbortArms = new Map<string, number>()
  let lastMoveHeaders: Record<string, string> | null = null

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
      const depth = (req.headers()['depth'] ?? '').trim().toLowerCase()
      if (depth === '0') {
        // The write core's validator read: the resource itself, nothing else.
        const file = rel ? store.get(rel) : undefined
        if (!file) {
          await route.fulfill({ status: 404, headers: CORS, body: 'not found' })
          return
        }
        await route.fulfill({
          status: 207,
          headers: { ...CORS, 'Content-Type': 'application/xml; charset=utf-8' },
          body: multistatusXml(baseUrl, [{ path: rel!, size: file.bytes.length, mtime: file.mtime, etag: file.etag }], { withCollection: false }),
        })
        return
      }
      const listing = [...store.entries()]
        .filter(([path]) => !path.endsWith(MMDROME_TMP_SUFFIX))
        .map(([path, f]) => ({ path, size: f.bytes.length, mtime: f.mtime, etag: f.etag }))
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
        headers: {
          ...CORS,
          'Content-Type': 'audio/mpeg',
          'Accept-Ranges': 'bytes',
          ETag: file.etag,
        },
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
      // A writer landing WHILE the client uploads its temp: the destination is
      // replaced behind the client's back, before it ever sends a MOVE. The
      // arm keys on the destination, so derive it from the temp path.
      const armedPut = conflictArms.get(destKeyOfTemp(rel))
      if (armedPut && armedPut.when === 'put' && armedPut.remaining > 0) {
        armedPut.remaining--
        conflictsServed++
        store.set(destKeyOfTemp(rel), { bytes: armedPut.newBytes, etag: armedPut.newEtag, mtime: MTIME_AFTER_WRITE })
      }
      const vanishedDest = destKeyOfTemp(rel)
      const vanishing = vanishArms.get(vanishedDest) ?? 0
      if (vanishing > 0) {
        vanishArms.set(vanishedDest, vanishing - 1)
        store.delete(vanishedDest)
      }
      await route.fulfill({ status: 201, headers: { ...CORS, ETag: etag }, body: '' })
      return
    }
    if (method === 'MOVE') {
      if (!rel) {
        await route.fulfill({ status: 400, headers: CORS, body: 'bad source' })
        return
      }
      moves++
      const requestHeaders = req.headers()
      lastMoveHeaders = requestHeaders
      const destHeader = requestHeaders.destination
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
      // The conflict arm mutates the destination FIRST — the concurrent write
      // landed between the client's GET and this MOVE — so every precondition
      // below is evaluated against the POST-mutation state (capturing the
      // snapshot before the mutation would wrongly let the stale etag match).
      const arm = conflictArms.get(destRel)
      if (arm && arm.when === 'move' && arm.remaining > 0) {
        arm.remaining--
        conflictsServed++
        store.set(destRel, { bytes: arm.newBytes, etag: arm.newEtag, mtime: MTIME_AFTER_WRITE })
      }
      const aborting = moveAbortArms.get(destRel) ?? 0
      if (aborting > 0) {
        // Connection reset instead of a response: the server may or may not
        // have completed the rename, which is exactly the ambiguity the client
        // must report as `unknown-outcome`.
        moveAbortArms.set(destRel, aborting - 1)
        await route.abort('connectionreset')
        return
      }
      const forced = moveFailureArms.get(destRel)
      if (forced && forced.remaining > 0) {
        forced.remaining--
        await route.fulfill({ status: forced.status, headers: CORS, body: 'move refused' })
        return
      }
      // `ignored`: a server that evaluates no precondition at all — every MOVE
      // succeeds whatever guard the client sent, so the only thing protecting
      // the destination is the client's own pre-MOVE re-check.
      const ifHeader = requestHeaders['if']
      if (dialect !== 'ignored') {
        const ifMatch = requestHeaders['if-match']
        if (ifMatch) {
          // RFC 7232 §3.1: If-Match is evaluated against the TARGET RESOURCE =
          // the request URI — for a temp-file MOVE that is the SOURCE, never the
          // destination (sabre/dav: Server::checkPreconditions →
          // getNodeForPath($request->getPath())). Comparing the destination
          // etag here — which this mock used to do — let a broken client pass.
          const node = store.get(rel)
          if (!node || node.etag !== ifMatch.trim()) {
            await route.fulfill({ status: 412, headers: CORS, body: 'If-Match failed' })
            return
          }
        }
        const ifUnmodified = requestHeaders['if-unmodified-since']
        if (ifUnmodified) {
          const node = store.get(destRel)
          const modifiedAt = node ? Date.parse(node.mtime) : Number.NaN
          if (!node || !(modifiedAt <= Date.parse(ifUnmodified))) {
            await route.fulfill({ status: 412, headers: CORS, body: 'If-Unmodified-Since failed' })
            return
          }
        }
      }
      // RFC 4918 §10.4.1: a TAGGED If list names the resource it applies to.
      // This is the destination guard; an untagged list would be the source.
      for (const condition of parseIfHeader(ifHeader ?? '', rel, toRel)) {
        // A condition must be a state-token or a BRACKETED etag (RFC 4918
        // List/Condition). A bare parenthesized string is not a condition:
        // servers either reject the header or parse no condition and run the
        // MOVE unguarded — so the client must never emit one.
        if (condition.etag === null && !condition.token) {
          await route.fulfill({ status: 400, headers: CORS, body: 'malformed If condition' })
          return
        }
        const node = condition.rel ? store.get(condition.rel) : undefined
        if (!condition.rel || !node) {
          // sabre/dav resolves the tagged node with tree->getNodeForPath and
          // does NOT catch NotFound there, so a vanished destination answers
          // 404 — not 412 — even though the client sees it as a precondition
          // failure. Modelling this is what proves the client treats both
          // statuses as "re-read the destination" instead of a hard failure.
          await route.fulfill({ status: 404, headers: CORS, body: 'If condition node missing' })
          return
        }
        if (condition.etag !== null && node.etag !== condition.etag) {
          await route.fulfill({ status: 412, headers: CORS, body: 'If condition failed' })
          return
        }
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
    armConflict: (destPath: string, times = 1, bytes = Buffer.from('conflict-write'), when: 'move' | 'put' = 'move') => {
      const newEtag = `"etag-${++etagCounter}"`
      conflictArms.set(destPath, { remaining: times, newEtag, newBytes: bytes, when })
      return newEtag
    },
    setPreconditionDialect: (mode: WebdavPreconditionDialect) => {
      dialect = mode
    },
    /** Delay every GET by `ms` (slow-server simulation); pass 0 to restore. */
    setGetDelay: (ms: number) => {
      getDelayMs = ms
    },
    lastMoveHeaders: () => lastMoveHeaders,
    armMoveFailure: (destPath: string, status: number, times = 1) => {
      moveFailureArms.set(destPath, { remaining: times, status })
    },
    armVanish: (destPath: string, times = 1) => {
      vanishArms.set(destPath, times)
    },
    armMoveAbort: (destPath: string, times = 1) => {
      moveAbortArms.set(destPath, times)
    },
  }
}

/** Parses the WebDAV `If` header into conditions. An UNTAGGED list applies to
 *  the request URI; a tagged list applies to the URI it names (RFC 4918
 *  §10.4.1). Only the ETag form is modelled — this client sends no lock
 *  tokens. A tagged URI outside the collection yields `rel: null`, which the
 *  caller treats as a failed condition. */
function parseIfHeader(
  header: string,
  requestRel: string,
  toRel: (fullUrl: string) => string | null,
): Array<{ rel: string | null; etag: string | null; token: string | null }> {
  const conditions: Array<{ rel: string | null; etag: string | null; token: string | null }> = []
  const re = /(?:<(?<uri>[^>]*)>\s*)?\((?<body>[^)]*)\)/g
  for (const match of header.matchAll(re)) {
    const body = match.groups?.body ?? ''
    const etagMatch = /\[\s*("[^"]*")\s*\]/.exec(body)
    const tokenMatch = /<(?!http)[^>]*>/.exec(body)
    conditions.push({
      rel: match.groups?.uri ? toRel(match.groups.uri) : requestRel,
      etag: etagMatch ? etagMatch[1] : null,
      token: tokenMatch ? tokenMatch[0] : null,
    })
  }
  return conditions
}
