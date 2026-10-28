/**
 * Atomic WebDAV write (PUT-temp → guarded MOVE) over an injected transport.
 *
 * - Temp file (`<path>.mmdrome-tmp` or `<path>.<runToken>.mmdrome-tmp`) is deleted
 *   at most once on any MOVE failure (status error, conflict, or network
 *   rejection); PUT network rejection (uncertain whether server created a
 *   partial temp) can opt-in to cleanup or track cleanup outcome without
 *   masking the original failure.
 * - Optional `beforeMove()` hook runs after PUT succeeds and before MOVE is
 *   sent: if it returns `false` (e.g., live row was unlinked, dismissed, or
 *   credentials changed while PUT was in flight), this run's temp is deleted
 *   and `AbortedBeforeMoveError` is thrown so the destination is never replaced.
 * - The destination is guarded by the precondition LADDER in
 *   `webdavPreconditions.ts` and RE-READ (`PROPFIND Depth: 0`) immediately
 *   before the MOVE. That re-check is what makes the collision guarantee
 *   portable — it refuses a destination that changed while the temp was being
 *   written even on a server that evaluates no precondition at all, and it is
 *   what tells a rejected rung apart from a real concurrent write. So
 *   `ConflictError` means one thing — the destination genuinely changed — and
 *   only the caller's recovery re-uploads a file. The `precondition` this
 *   returns is the rung that held.
 * - `validators` are the caller's baseline for BOTH of those, and they MUST be
 *   read BEFORE the caller reads the bytes it hands in. The guard is then at
 *   least as old as the payload: a writer landing in the gap makes the guard
 *   refuse the write (the caller retries), whereas a baseline taken after the
 *   bytes describes a state our payload predates and the guard would happily
 *   overwrite the writer's change. `readDestinationValidators` is exported so
 *   the caller does exactly that.
 * - HTTP 404 on MOVE throws `ConflictError` too: sabre/dav resolves a tagged
 *   `If` node with an uncaught `NotFound`, so a destination that vanished
 *   between the read and the rename reports 404, and the caller's retry turns
 *   that into the ordinary missing-file skip.
 */

import { authHeaders, buildWebdavUrl, webdavTempPath } from './webdavPaths'
import {
  movePreconditionHeaders,
  parseDestinationValidators,
  planPreconditionLadder,
  propfindValidatorsBody,
  revalidationResult,
  type DestinationValidators,
  type PreconditionKind,
  type RevalidationResult,
} from './webdavPreconditions'

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
export type AtomicWriteStage = 'put-temp' | 'pre-move-validation' | 'move'

export class AtomicWriteError extends Error {
  readonly stage: AtomicWriteStage
  readonly status?: number
  readonly remoteState: 'not-committed' | 'unknown'
  readonly cleanup: TempCleanupStatus
  readonly precondition?: PreconditionKind

  constructor(
    message: string,
    opts: {
      stage: AtomicWriteStage
      status?: number
      remoteState: 'not-committed' | 'unknown'
      cleanup: TempCleanupStatus
      precondition?: PreconditionKind
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
  /** Required only for the validator read (PROPFIND); status-only fakes omit it. */
  text?(): Promise<string>
}

export interface AtomicWriteOptions {
  /** Optional unique run/attempt token embedded before `.mmdrome-tmp` so
   *  overlapping runs never delete or overwrite each other's temp file. */
  runToken?: string
  /** Optional pre-MOVE live validation check after PUT completes. Returning
   *  `false` deletes this run's temp and throws `AbortedBeforeMoveError`
   *  before sending MOVE. */
  beforeMove?: () => boolean | Promise<boolean>
  /** Rung to resume the ladder at — the one this server accepted earlier in
   *  the same run. Omitted on the first row, which discovers it. */
  startAt?: PreconditionKind
}

export interface AtomicWriteOutcome {
  /** The guard that held the destination for this write. */
  precondition: PreconditionKind
  /** MOVEs spent on the ladder (1 = the first rung was accepted). */
  moveAttempts: number
  /** Relative temp path used by this write (also the MOVE source). */
  tempPath: string
}

/**
 * Outcome of reading the destination's validators: the values, the destination
 * being gone, or nothing usable (a server that publishes none, or a read that
 * failed — never a reason to fail the row itself).
 */
export type ValidatorRead =
  | { kind: 'ok'; validators: DestinationValidators }
  | { kind: 'vanished' }
  | { kind: 'unknown' }

/**
 * Read the destination's validators (`PROPFIND Depth: 0`). Called by the
 * caller BEFORE it reads the bytes it will write (see the module doc), and by
 * this core for the pre-MOVE re-check.
 */
export async function readDestinationValidators(
  fetchImpl: WebdavFetchLike,
  destinationUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<ValidatorRead> {
  let res: ResponseLike
  try {
    res = await fetchImpl(
      destinationUrl,
      {
        method: 'PROPFIND',
        // `no-cache` = revalidate before use: a CACHED multistatus would hand
        // this read a validator for a state the destination has left, and the
        // guard built on it would then let an older payload through.
        headers: {
          ...headers,
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
        body: propfindValidatorsBody(),
      },
      timeoutMs,
    )
  } catch {
    return { kind: 'unknown' }
  }
  if (res.status === 404 || res.status === 410) return { kind: 'vanished' }
  if (!res.ok) return { kind: 'unknown' }
  let xml: string
  try {
    xml = res.text ? await res.text() : ''
  } catch {
    return { kind: 'unknown' }
  }
  const validators = parseDestinationValidators(xml)
  return validators ? { kind: 'ok', validators } : { kind: 'unknown' }
}

export async function webdavPutAtomic(
  baseUrl: string,
  filePath: string,
  data: ArrayBuffer,
  user: string,
  token: string,
  validators: DestinationValidators | undefined,
  fetchImpl: WebdavFetchLike,
  timeoutMs: number,
  opts?: AtomicWriteOptions,
): Promise<AtomicWriteOutcome> {
  const tempRelPath = webdavTempPath(filePath, opts?.runToken)
  const tempUrl = buildWebdavUrl(baseUrl, tempRelPath)
  const destUrl = buildWebdavUrl(baseUrl, filePath)
  const headers = authHeaders(user, token)

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

  /** Clean this write's temp (at most once) and build the conflict to throw. */
  const conflict = async (
    message: string,
    stage: AtomicWriteStage,
    opts2?: { status?: number; precondition?: PreconditionKind },
  ): Promise<ConflictError> => {
    const cleanup = await discardTemp()
    const err = new ConflictError(message, opts2?.status)
    Object.assign(err, {
      stage,
      remoteState: 'not-committed' as const,
      cleanup,
      ...(opts2?.precondition ? { precondition: opts2.precondition } : {}),
    })
    return err
  }

  const readForRevalidation = async (before: DestinationValidators): Promise<RevalidationResult | 'vanished'> => {
    const read = await readDestinationValidators(fetchImpl, destUrl, headers, timeoutMs)
    if (read.kind === 'vanished') return 'vanished'
    return revalidationResult(before, read.kind === 'ok' ? read.validators : null)
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
      })
    }
    throw err
  }
  if (!putRes.ok) {
    throw new AtomicWriteError(`WebDAV PUT to temp failed (${putRes.status}) for ${filePath}`, {
      stage: 'put-temp',
      status: putRes.status,
      remoteState: 'not-committed',
      cleanup: 'not-needed',
    })
  }

  if (opts?.beforeMove) {
    const proceed = await opts.beforeMove()
    if (!proceed) {
      const cleanup = await discardTemp()
      throw new AbortedBeforeMoveError(`Aborted before MOVE for ${filePath}`, cleanup)
    }
  }

  // ── 1. The portable collision check: as late as possible before the rename,
  // so the unprotected window is the re-check→MOVE gap and not the upload.
  let checked: RevalidationResult = 'unknown'
  if (validators) {
    const verdict = await readForRevalidation(validators)
    if (verdict === 'vanished') {
      throw await conflict(`Destination removed since it was read for ${filePath}`, 'move')
    }
    if (verdict === 'changed') {
      throw await conflict(`Destination changed since it was read for ${filePath}`, 'move')
    }
    checked = verdict
  }

  // ── 2. The MOVE, guarded by the first rung this server accepts.
  const ladder = planPreconditionLadder(validators, opts?.startAt)
  let moveAttempts = 0
  for (const rung of ladder) {
    moveAttempts++
    const moveHeaders: Record<string, string> = {
      ...headers,
      Destination: destUrl,
      Overwrite: 'T',
      ...movePreconditionHeaders(rung, destUrl, validators),
    }

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
          precondition: rung,
        })
      }
      throw err
    }

    if (moveRes.ok) {
      return {
        // A bottom-rung MOVE that nothing could verify is reported as blind:
        // "no server guard" and "no check either" are different facts.
        precondition: rung === 'revalidated' && checked !== 'unchanged' ? 'blind' : rung,
        moveAttempts,
        tempPath: tempRelPath,
      }
    }

    if (moveRes.status === 404) {
      throw await conflict(`Destination no longer exists for ${filePath}`, 'move', {
        status: 404,
        precondition: rung,
      })
    }

    if (moveRes.status === 412 && rung !== 'revalidated') {
      // Either a writer won the race after the re-check, or this server
      // refuses the rung. The destination itself is the only thing that can
      // tell them apart — and if it cannot, the write refuses rather than
      // weakening.
      const verdict = validators ? await readForRevalidation(validators) : 'unknown'
      if (verdict === 'vanished') {
        throw await conflict(`Destination removed since it was read for ${filePath}`, 'move', {
          status: 412,
          precondition: rung,
        })
      }
      if (verdict !== 'unchanged') {
        throw await conflict(`File changed since it was read for ${filePath} (HTTP 412)`, 'move', {
          status: 412,
          precondition: rung,
        })
      }
      continue // dialect rejection: keep the temp, try the next rung
    }

    const cleanup = await discardTemp()
    throw new AtomicWriteError(`WebDAV MOVE failed (${moveRes.status}) for ${filePath}`, {
      stage: 'move',
      status: moveRes.status,
      remoteState: 'not-committed',
      cleanup,
      precondition: rung,
    })
  }

  // `planPreconditionLadder` always ends at `revalidated`, so the loop either
  // returned or threw. This only completes the type.
  throw new AtomicWriteError(`No precondition rung is available for ${filePath}`, {
    stage: 'pre-move-validation',
    remoteState: 'not-committed',
    cleanup: await discardTemp(),
  })
}
