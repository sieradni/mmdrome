/**
 * Atomic WebDAV write (PUT-temp → conditional MOVE) over an injected transport.
 *
 * - Temp file (`<path>.mmdrome-tmp`) is deleted at most once on any MOVE failure
 *   (status error or network rejection); PUT failure throws before any temp exists.
 * - The destination ETag from the caller's GET rides in a destination-tagged
 *   WebDAV `If` header (`<dest-url> (["etag"])`), never `If-Match` (which targets
 *   the `.mmdrome-tmp` request URI under RFC 7232 §3.1 and sabre/dav).
 * - HTTP 412 or 404 on MOVE throws `ConflictError` so `syncEngine` retries with a
 *   fresh GET (sabre/dav throws uncaught `NotFound` 404 when resolving a tagged
 *   `If` URI whose destination vanished between GET and MOVE).
 */

import { authHeaders, buildWebdavUrl, webdavIfHeader, webdavTempPath } from './webdavPaths'

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export type WebdavFetchLike = (
  url: string,
  options: RequestInit,
  timeoutMs: number,
) => Promise<ResponseLike>

export interface ResponseLike {
  readonly ok: boolean
  readonly status: number
}

export interface AtomicWriteOutcome {
  /** False when no destination precondition was sent (blind overwrite). */
  guarded: boolean
}

export async function webdavPutAtomic(
  baseUrl: string,
  filePath: string,
  data: ArrayBuffer,
  user: string,
  token: string,
  etag: string | undefined,
  fetchImpl: WebdavFetchLike,
  timeoutMs: number,
): Promise<AtomicWriteOutcome> {
  const tempUrl = buildWebdavUrl(baseUrl, webdavTempPath(filePath))
  const headers = authHeaders(user, token)

  const putRes = await fetchImpl(tempUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: data,
  }, timeoutMs)
  if (!putRes.ok) throw new Error(`WebDAV PUT to temp failed (${putRes.status}) for ${filePath}`)

  const destUrl = buildWebdavUrl(baseUrl, filePath)
  const ifHeader = webdavIfHeader(destUrl, etag)
  const moveHeaders: Record<string, string> = {
    ...headers,
    Destination: destUrl,
    Overwrite: 'T',
  }
  if (ifHeader) moveHeaders['If'] = ifHeader

  const discardTemp = (): Promise<void> =>
    fetchImpl(tempUrl, { method: 'DELETE', headers }, timeoutMs).then(() => undefined, () => undefined)

  let moveRes: ResponseLike
  try {
    moveRes = await fetchImpl(tempUrl, { method: 'MOVE', headers: moveHeaders }, timeoutMs)
  } catch (err) {
    await discardTemp()
    throw err
  }

  if (!moveRes.ok) {
    await discardTemp()
    if (moveRes.status === 412 || moveRes.status === 404) {
      throw new ConflictError(`File changed since GET for ${filePath} (HTTP ${moveRes.status})`)
    }
    throw new Error(`WebDAV MOVE failed (${moveRes.status}) for ${filePath}`)
  }

  return { guarded: ifHeader !== null }
}
