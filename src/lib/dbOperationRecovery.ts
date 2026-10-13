/**
 * Transparent recovery for a DEAD IndexedDB connection at the OPERATION level
 * (2026-10-13).
 *
 * C9 fixed the boot: `initStores` reopens the connection and retries its read
 * phase. But a WebKit handle invalidation can land at ANY moment of a long
 * session, and every store read/write after it fails the same way —
 * `UnknownError: Attempt to get a record from database without an in-progress
 * transaction` (see `storageHealth.ts` for the full root cause). This module
 * makes that invisible: a wrapped operation that fails with a dead-connection
 * signature reopens the connection and runs again, so callers keep seeing a
 * value instead of an exception.
 *
 * WHERE the interception sits, and why (verified against Dexie 4.4.4):
 *  - Dexie assigns every table's `core` at open time from the dbcore middleware
 *    stack, and every public read/write funnels through `table.core` — so the
 *    DB-core layer sees the whole surface. It is still the WRONG layer to retry
 *    at: `Table._trans` hands its callback the RAW IDBTransaction
 *    (`fn(trans.idbtrans, trans)`) and the table method forwards it as
 *    `req.trans` (`core.get({ trans, … })`, which the core then calls
 *    `trans.objectStore(...)` on). A retry there re-sends a request bound to a
 *    transaction created on the dead connection, behind a Dexie transaction
 *    that is already aborted — it cannot succeed.
 *  - The `Table`/`Collection` API layer is the one place a retry naturally
 *    creates a NEW transaction, which is exactly what a recovered connection
 *    needs. An IDB transaction is atomic, so a failed one cannot have left a
 *    partial write: re-running the operation is safe for reads AND writes.
 *  - `db.Table.prototype` / `db.Collection.prototype` are per-INSTANCE (Dexie
 *    subclasses the shared internal classes per db) — the same seam the test
 *    harness already patches (F3), so this is the project's established hook.
 *  - The success path returns the ORIGINAL promise with one extra `.then`
 *    attached, so Dexie's own promise class (and the zone/PSD bookkeeping it
 *    carries) is preserved for Dexie-internal callers; only the recovery path
 *    produces a plain promise, which is fine because its transaction is dead
 *    either way.
 *
 * Deliberate boundaries (documented, not accidental):
 *  - A callback-iterating read (`each*`) hands rows over DURING iteration, so a
 *    retry can only be safe while the callback was never invoked. Those are
 *    wrapped, but with an instrumented callback whose delivery count GATES the
 *    retry: the dominant dead-handle shape (the transaction never starts at
 *    all) delivers nothing and recovers, while a failure after a row was
 *    handed over surfaces unchanged.
 *  - An explicit `db.transaction(...)` scope retries only its individual
 *    operations; the scope itself is not re-run (that would repeat the user's
 *    JS side effects). Nothing in `src/` uses one today.
 *  - A FAILED recovery is not retried immediately (`RECOVERY_FAILURE_BACKOFF_MS`),
 *    so a connection that stays broken degrades to the pre-recovery behavior —
 *    errors surface — instead of a reopen loop with a log line per operation.
 *  - Non-thenable returns (chain builders like `where`/`limit`) pass through
 *    untouched, and a non-classified error is rethrown exactly as before.
 */

import { dbg, dbgAlways, dbgDanger } from './debugLog'
import {
  describeStorageError,
  planOperationRetry,
  RECOVERY_COOLDOWN_MS,
  RECOVERY_FAILURE_BACKOFF_MS,
  type OperationRetryPlan,
} from './storageHealth'

/**
 * Reads that hand rows to a caller callback DURING iteration. They are wrapped,
 * but their retry is gated on the callback never having run (see
 * `installOperationRecovery`): without that gate a retry would re-deliver rows
 * the caller has already processed.
 */
export const CALLBACK_ITERATING_METHODS: readonly string[] = ['each', 'eachKey', 'eachUniqueKey', 'eachPrimaryKey']

export interface OperationRecoveryOptions {
  /** Discards the dead handle and opens a fresh connection (throws on failure). */
  recover: () => Promise<void>
  /** `db.isOpen()` — a dead WebKit handle still reports `true`. */
  isOpen: () => boolean
  /** Injectable clock (tests); defaults to `Date.now`. */
  now?: () => number
  /** Override the reopen cooldown (tests). */
  cooldownMs?: number
  /** Override the failed-recovery backoff (tests). */
  failureBackoffMs?: number
}

/** Prototypes already processed — installing twice never double-wraps. */
const installedPrototypes = new WeakSet<object>()

function isThenable(value: unknown): value is Promise<unknown> {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * The wrappable method names reachable from `proto`: the CLOSEST descriptor for
 * each name wins (an accessor or a non-writable property is never shadowed by
 * a deeper method), and Dexie-private members (`_`-prefixed, e.g. `_trans`) are
 * skipped so the interception stays on the public surface.
 */
export function collectWrappableMethods(proto: object): string[] {
  const closest = new Map<string, PropertyDescriptor>()
  let cursor: object | null = proto
  while (cursor && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (closest.has(name)) continue
      const desc = Object.getOwnPropertyDescriptor(cursor, name)
      if (desc) closest.set(name, desc)
    }
    cursor = Object.getPrototypeOf(cursor) as object | null
  }
  const names: string[] = []
  for (const [name, desc] of closest) {
    if (name === 'constructor' || name.startsWith('_')) continue
    if (!('value' in desc) || typeof desc.value !== 'function') continue
    if (desc.writable === false || desc.configurable === false) continue
    names.push(name)
  }
  return names
}

/**
 * Wraps each prototype's promise-returning methods so a dead-connection
 * failure recovers and re-runs instead of surfacing. Returns the wrapped names
 * (diagnostics/tests). Each operation retries AT MOST ONCE — the retry is a
 * fresh, unwrapped call, so a second failure propagates.
 */
export function installOperationRecovery(
  prototypes: readonly (object | undefined)[],
  opts: OperationRecoveryOptions,
): string[] {
  const now = opts.now ?? (() => Date.now())
  const cooldownMs = opts.cooldownMs ?? RECOVERY_COOLDOWN_MS
  const failureBackoffMs = opts.failureBackoffMs ?? RECOVERY_FAILURE_BACKOFF_MS
  let lastReopenAt = Number.NEGATIVE_INFINITY
  let lastFailedRecoveryAt = Number.NEGATIVE_INFINITY
  let recoveryInFlight: Promise<boolean> | null = null
  const wrapped: string[] = []

  /** Single-flight: a burst of simultaneous failures shares ONE reopen. */
  function recoverOnce(): Promise<boolean> {
    if (recoveryInFlight) return recoveryInFlight
    recoveryInFlight = (async () => {
      try {
        await opts.recover()
        lastReopenAt = now()
        dbgAlways('storage', 'reopened the local database connection after a dead-handle failure')
        return true
      } catch (err) {
        // Arms the backoff: the connection is not coming back by itself, and
        // every further operation would otherwise re-run this failed attempt.
        lastFailedRecoveryAt = now()
        dbgDanger('storage', `storage connection reopen failed: ${describeStorageError(err)}`)
        return false
      } finally {
        recoveryInFlight = null
      }
    })()
    return recoveryInFlight
  }

  /**
   * Records the verdict. A plan that ACTS is always logged (it changes what the
   * caller sees); a failure left to the caller is verbose-domain only, because
   * the caller's own reporting (C9's boot banner, A3's persist warning) is what
   * the default dump carries.
   */
  function logVerdict(methodName: string, err: unknown, plan: OperationRetryPlan): void {
    const line = `${methodName}: ${describeStorageError(err)} → ${plan}`
    if (plan === 'surface') dbg('storage', line)
    else dbgAlways('storage', line)
  }

  /** The single retry path: recover (or don't) and re-run the SAME call. */
  function retryAfterFailure(
    call: () => unknown,
    plan: OperationRetryPlan,
    originalErr: unknown,
    methodName: string,
  ): Promise<unknown> {
    logVerdict(methodName, originalErr, plan)
    const proceed = plan === 'reopen-and-retry' ? recoverOnce() : Promise.resolve(true)
    return proceed.then((ok) => {
      // A failed recovery cannot help: surface the ORIGINAL failure (the
      // recovery's own error is already logged) and do not retry.
      if (!ok) throw originalErr
      return call()
    })
  }

  for (const proto of prototypes) {
    if (!proto || typeof proto !== 'object') continue
    if (installedPrototypes.has(proto)) continue
    installedPrototypes.add(proto)
    for (const name of collectWrappableMethods(proto)) {
      const original = (proto as Record<string, unknown>)[name] as (...args: unknown[]) => unknown
      const descriptor = Object.getOwnPropertyDescriptor(proto, name)
      const callbackIterating = CALLBACK_ITERATING_METHODS.includes(name)
      const wrapper = function (this: unknown, ...args: unknown[]) {
        const self = this
        // A countable callback is the precondition for retrying an iterating
        // read at all (Dexie's `each*` take the row consumer as arg 0).
        const cb = callbackIterating && typeof args[0] === 'function' ? (args[0] as (...a: unknown[]) => unknown) : null
        /** Rows already handed to the caller's callback by THIS operation. */
        let delivered = 0
        const call = () => {
          if (!cb) return original.apply(self, args)
          const counted = function (this: unknown, ...cbArgs: unknown[]) {
            delivered++
            return cb.apply(this, cbArgs)
          }
          return original.apply(self, [counted, ...args.slice(1)])
        }
        const decide = (err: unknown): OperationRetryPlan => {
          // Re-running a partially-delivered iteration would re-deliver rows
          // the caller already processed; without a countable callback there is
          // no proof that nothing was delivered, so surface instead.
          if (callbackIterating && (delivered > 0 || !cb)) return 'surface'
          return planOperationRetry(
            err,
            {
              connectionOpen: opts.isOpen(),
              msSinceReopen: now() - lastReopenAt,
              msSinceFailedRecovery: now() - lastFailedRecoveryAt,
            },
            { cooldownMs, failureBackoffMs },
          )
        }
        /** Throws for `surface` (synchronously, as the original call did). */
        const handleFailure = (err: unknown) => {
          const plan = decide(err)
          if (plan === 'surface') {
            logVerdict(name, err, plan)
            throw err
          }
          return retryAfterFailure(call, plan, err, name)
        }

        let result: unknown
        try {
          result = call()
        } catch (err) {
          // Dexie's argument validators throw synchronously. Preserve that
          // behavior unless it is a dead connection we can actually recover.
          return handleFailure(err)
        }
        if (!isThenable(result)) return result
        const reject = (err: unknown) => handleFailure(err) as never
        return typeof (result as { catch?: unknown }).catch === 'function'
          ? (result as Promise<unknown>).catch(reject)
          : Promise.resolve(result).then(undefined, reject)
      }
      Object.defineProperty(proto, name, {
        value: wrapper,
        writable: descriptor?.writable ?? true,
        configurable: true,
        enumerable: descriptor?.enumerable ?? false,
      })
      wrapped.push(name)
    }
  }
  return wrapped
}
