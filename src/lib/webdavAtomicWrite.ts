/**
 * Atomic WebDAV write (PUT-temp → conditional MOVE) over an injected transport.
 *
 * - Temp file (`<path>.mmdrome-tmp` or `<path>.<runToken>.mmdrome-tmp`) is deleted
 *   at most once on any MOVE failure (status error or network rejection); PUT
 *   network rejection (uncertain whether server created a partial temp) can opt-in
 *   to cleanup or track cleanup outcome without masking the original failure.
 * - Optional `beforeMove()` hook runs after PUT succeeds and before MOVE is sent:
 *   if it returns `false` (e.g., live row was unlinked, dismissed, or credentials
 *   changed while PUT was in flight), this run's temp is deleted and `AbortedBeforeMoveError`
 *   is thrown so the destination is never replaced.
 * - The destination ETag from the caller's GET rides in a destination-tagged
 *   WebDAV `If` header (`<dest-url> (["etag"])`), never `If-Match` (which targets
 *   the `.mmdrome-tmp` request URI under RFC 7232 §3.1 and sabre/dav).
 * - HTTP 412 or 404 on MOVE throws `ConflictError` so `syncEngine` retries with a
 *   fresh GET (sabre/dav throws uncaught `NotFound` 404 when resolving a tagged
 *   `If` URI whose destination vanished between GET and MOVE).
 */

import { authHeaders, buildWebdavUrl, webdavIfHeader, webdavTempPath } from './webdavPaths'

export class ConflictError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ConflictError'
    this.status = status
  }
}

export class AbortedBeforeMoveError extends Error {
  readonly cleanup: TempCleanupStatus
  constructor(message: string, cleanup: TempCleanupStatus = 'deleted') {
    super(message)
    this.name = 'AbortedBeforeMoveError'
    this.cleanup = cleanup
  }
}

export type TempCleanupStatus = 'not-needed' | 'deleted' | 'missing' | 'failed'
export type PreconditionKind = 'guarded' | 'absent-etag' | 'unsafe-etag'
export type AtomicWriteStage = 'put-temp' | 'pre-move-validation' | 'move'

export class AtomicWriteError extends Error {
  readonly stage: AtomicWriteStage
  readonly status?: number
  readonly remoteState: 'not-committed' | 'unknown'
  readonly cleanup: TempCleanupStatus
  readonly precondition: PreconditionKind

  constructor(
    message: string,
    opts: {
      stage: AtomicWriteStage
      status?: number
      remoteState: 'not-committed' | 'unknown'
      cleanup: TempCleanupStatus
      precondition: PreconditionKind
      cause?: unknown
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'AtomicWriteError'
    this.stage = opts.stage
    this.status = opts.status
    this.remoteState = opts.remoteState
    this.cleanup = opts.cleanup
    this.precondition = opts.precondition
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

export interface AtomicWriteOptions {
  /** Optional unique run/attempt token embedded before `.mmdrome-tmp` so
   *  overlapping runs never delete or overwrite each other's temp file. */
  runToken?: string
  /** Optional pre-MOVE live validation check after PUT completes. Returning
   *  `false` deletes this run's temp and throws `AbortedBeforeMoveError`
   *  before sending MOVE. */
  beforeMove?: () => boolean | Promise<boolean>
}

export interface AtomicWriteOutcome {
  /** False when no destination precondition was sent (blind overwrite). */
  guarded: boolean
  /** Detailed precondition disposition when `opts` is supplied. */
  precondition?: PreconditionKind
  /** Relative temp path used by this write when `opts.runToken` is supplied. */
  tempPath?: string
}

export function classifyPrecondition(destinationUrl: string, etag: string | undefined): {
  ifHeader: string | null
  precondition: PreconditionKind
} {
  if (!etag) return { ifHeader: null, precondition: 'absent-etag' }
  const ifHeader = webdavIfHeader(destinationUrl, etag)
  return {
    ifHeader,
    precondition: ifHeader !== null ? 'guarded' : 'unsafe-etag',
  }
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
  opts?: AtomicWriteOptions,
): Promise<AtomicWriteOutcome> {
  const tempRelPath = webdavTempPath(filePath, opts?.runToken)
  const tempUrl = buildWebdavUrl(baseUrl, tempRelPath)
  const destUrl = buildWebdavUrl(baseUrl, filePath)
  const headers = authHeaders(user, token)
  const { ifHeader, precondition } = classifyPrecondition(destUrl, etag)

  const discardTemp = async (): Promise<TempCleanupStatus> => {
    try {
      const delRes = await fetchImpl(tempUrl, { method: 'DELETE', headers }, timeoutMs)
      if (delRes.ok) return 'deleted'
      if (delRes.status === 404 || delRes.status === 410) return 'missing'
      return 'failed'
    } catch {
      return 'failed'
    }
  }

  let putRes: ResponseLike
  try {
    putRes = await fetchImpl(tempUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: data,
    }, timeoutMs)
  } catch (err) {
    if (err instanceof Error) {
      Object.assign(err, {
        stage: 'put-temp' as AtomicWriteStage,
        remoteState: 'not-committed' as const,
        cleanup: 'not-needed' as TempCleanupStatus,
        precondition,
      })
    }
    throw err
  }
  if (!putRes.ok) {
    const err = new AtomicWriteError(`WebDAV PUT to temp failed (${putRes.status}) for ${filePath}`, {
      stage: 'put-temp',
      status: putRes.status,
      remoteState: 'not-committed',
      cleanup: 'not-needed',
      precondition,
    })
    throw err
  }

  if (opts?.beforeMove) {
    const proceed = await opts.beforeMove()
    if (!proceed) {
      const cleanup = await discardTemp()
      throw new AbortedBeforeMoveError(`Aborted before MOVE for ${filePath}`, cleanup)
    }
  }

  const moveHeaders: Record<string, string> = {
    ...headers,
    Destination: destUrl,
    Overwrite: 'T',
  }
  if (ifHeader) moveHeaders['If'] = ifHeader

  let moveRes: ResponseLike
  try {
    moveRes = await fetchImpl(tempUrl, { method: 'MOVE', headers: moveHeaders }, timeoutMs)
  } catch (err) {
    const cleanup = await discardTemp()
    // A lost/aborted MOVE response may mean the server already renamed the temp
    // over the destination (`cleanup === 'missing'` is a strong hint, and any
    // network error after MOVE was sent leaves remote state uncertain).
    if (err instanceof Error) {
      Object.assign(err, {
        stage: 'move' as AtomicWriteStage,
        remoteState: 'unknown' as const,
        cleanup,
        precondition,
      })
    }
    throw err
  }

  if (!moveRes.ok) {
    const cleanup = await discardTemp()
    if (moveRes.status === 412 || moveRes.status === 404) {
      const conflict = new ConflictError(`File changed since GET for ${filePath} (HTTP ${moveRes.status})`, moveRes.status)
      Object.assign(conflict, {
        stage: 'move' as AtomicWriteStage,
        remoteState: 'not-committed' as const,
        cleanup,
        precondition,
      })
      throw conflict
    }
    throw new AtomicWriteError(`WebDAV MOVE failed (${moveRes.status}) for ${filePath}`, {
      stage: 'move',
      status: moveRes.status,
      remoteState: 'not-committed',
      cleanup,
      precondition,
    })
  }

  if (opts) {
    return {
      guarded: ifHeader !== null,
      precondition,
      tempPath: tempRelPath,
    }
  }
  return { guarded: ifHeader !== null }
}
