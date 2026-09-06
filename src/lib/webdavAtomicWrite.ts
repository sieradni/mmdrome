/**
 * The atomic WebDAV write — GET is NOT part of this module; it only performs
 * the PUT-temp → MOVE(-If-Match) half of Push's write, given already-fetched
 * bytes (TODO 3.8a). Extracted from `syncEngine.webdavPutAtomic` (which is now
 * a thin adapter binding `webdavFetch`) so the error-path CONTRACT is
 * unit-testable with a fake transport:
 *
 * - the temp file is deleted AT MOST ONCE on any failure — the previous
 *   structure cleaned up in BOTH the `!moveRes.ok` branch AND the catch-all,
 *   so a 412 (ConflictError) or any MOVE error produced two DELETEs (benign
 *   but observable, and asserted-as-observed in tests/e2e/pushchanges.spec.ts
 *   until this extraction);
 * - `etag` (the concurrency token from the caller's GET) is forwarded as the
 *   MOVE's `If-Match` header — absent etag = blind overwrite (the caller
 *   surfaces that; D5/TODO 3.8b);
 * - a 412 MOVE response is rethrown as `ConflictError` so the caller's single
 *   re-GET retry path (syncEngine) can distinguish it from other failures;
 * - all other MOVE statuses throw a plain Error; PUT failure throws before
 *   any temp exists to clean (no DELETE then either).
 *
 * Keep this module DOM/Dexie-free — it takes everything by parameter.
 */

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

/** Minimal async transport shape — structurally satisfied by `webdavFetch`
 *  (webdavUtils) and by the fakes in tests. */
export type WebdavFetchLike = (
  url: string,
  options: RequestInit,
  timeoutMs: number,
) => Promise<ResponseLike>

export interface ResponseLike {
  readonly ok: boolean
  readonly status: number
}

export function webdavPutAtomic(
  baseUrl: string,
  filePath: string,
  data: ArrayBuffer,
  user: string,
  token: string,
  etag: string | undefined,
  fetchImpl: WebdavFetchLike,
  timeoutMs: number,
): Promise<void> {
  return webdavPutAtomicImpl(baseUrl, filePath, data, user, token, etag, fetchImpl, timeoutMs)
}

async function webdavPutAtomicImpl(
  baseUrl: string,
  filePath: string,
  data: ArrayBuffer,
  user: string,
  token: string,
  etag: string | undefined,
  fetchImpl: WebdavFetchLike,
  timeoutMs: number,
): Promise<void> {
  const tempPath = webdavTempPath(filePath)
  const headers = authHeaders(user, token)

  // Write to temp file first — original untouched if this fails. No temp
  // exists yet, so a PUT failure deletes nothing.
  const putRes = await fetchImpl(buildWebdavUrl(baseUrl, tempPath), {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': 'application/octet-stream',
    },
    body: data,
  }, timeoutMs)
  if (!putRes.ok) throw new Error(`WebDAV PUT to temp failed (${putRes.status}) for ${filePath}`)

  // Atomically replace via MOVE with optional concurrency check
  const destUrl = buildWebdavUrl(baseUrl, filePath)
  const moveHeaders: Record<string, string> = {
    ...headers,
    Destination: destUrl,
    Overwrite: 'T',
  }
  if (etag) moveHeaders['If-Match'] = etag

  // ONE cleanup, whichever way the MOVE fails: a 412 (ConflictError), any
  // other non-ok status, a network/CORS rejection. `noCleanupNeeded` is set
  // on the success path (the MOVE consumed the temp — deleting nothing is
  // correct there) and inside cleanupTemp itself, so neither the catch-all
  // nor the finally can fire a second DELETE.
  let noCleanupNeeded = false
  const cleanupTemp = (): Promise<void> => {
    if (noCleanupNeeded) return Promise.resolve()
    noCleanupNeeded = true
    return fetchImpl(buildWebdavUrl(baseUrl, tempPath), {
      method: 'DELETE',
      headers,
    }, timeoutMs).then(() => undefined).catch(() => {})
  }

  try {
    const moveRes = await fetchImpl(buildWebdavUrl(baseUrl, tempPath), {
      method: 'MOVE',
      headers: moveHeaders,
    }, timeoutMs)

    if (!moveRes.ok) {
      await cleanupTemp()
      if (moveRes.status === 412) throw new ConflictError(`File changed since GET for ${filePath}`)
      throw new Error(`WebDAV MOVE failed (${moveRes.status}) for ${filePath}`)
    }
    // Success: the MOVE consumed the temp — there is nothing to clean.
    noCleanupNeeded = true
  } catch (err) {
    // Catch-all for rejections (network/CORS) — the `!ok` branch already ran
    // its cleanup, so this is a no-op there; it is the ONLY cleanup on the
    // rejection paths.
    await cleanupTemp()
    throw err
  } finally {
    await cleanupTemp()
  }
}

// Inlined from webdavUtils (mirrors its exports) to keep this module pure and
// Node-importable — webdavUtils imports Capacitor, which is browser-only.
// CHANGING webdavUtils' URL/auth/temp-naming helpers REQUIRES updating these
// mirrors; tests/webdavTempFile.test.ts + tests/webdavAtomicWrite.test.ts pin
// the observable behavior (temp path, If-Match header, auth header shape).
function webdavTempPath(filePath: string): string {
  return `${filePath}.mmdrome-tmp`
}

function authHeaders(user: string, token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${user}:${token}`)}` }
}

function buildWebdavUrl(baseUrl: string, filePath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}${filePath.split('/').map(encodeURIComponent).join('/')}`
}
