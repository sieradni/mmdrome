// Pins the local-storage boot-recovery policy (2026-10-13): only a provably
// DEAD IndexedDB connection earns a reopen-and-retry. The field report showed
// iOS WebKit invalidating the IDBDatabase handle and every later request
// failing with `UnknownError: Attempt to get a record from database without an
// in-progress transaction` — the app then booted with an empty library and no
// recovery path. The classifier is deliberately tight so an ordinary transient
// abort (A3's AbortError) never turns into a blind retry loop.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeStorageError,
  isBrokenIdbConnection,
  planOperationRetry,
  planStorageInitAttempt,
  RECOVERY_COOLDOWN_MS,
  RECOVERY_FAILURE_BACKOFF_MS,
  STORAGE_INIT_MAX_ATTEMPTS,
  type OperationRetryContext,
} from '../src/lib/storageHealth'

/** A retry context with every clock at its "never happened" value. */
function retryCtx(over: Partial<OperationRetryContext> = {}): OperationRetryContext {
  return { connectionOpen: true, msSinceReopen: Infinity, msSinceFailedRecovery: Infinity, ...over }
}

/** The exact field-report shape (a DOMException from WKWebView). */
function webkitDeadConnection(): Error {
  return Object.assign(
    new Error('Attempt to get a record from database without an in-progress transaction'),
    { name: 'UnknownError' },
  )
}

test('isBrokenIdbConnection: the WebKit dead-handle signatures are recognized', () => {
  assert.equal(isBrokenIdbConnection(webkitDeadConnection()), true, 'the field report shape')
  // The same invalidation surfacing through a racing request.
  assert.equal(
    isBrokenIdbConnection(
      Object.assign(new Error("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."), {
        name: 'InvalidStateError',
      }),
    ),
    true,
  )
  // Dexie wraps a DOMException in a DexieError whose message is "<name> <message>".
  assert.equal(
    isBrokenIdbConnection(
      Object.assign(new Error('UnknownError Attempt to get all index records from database without an in-progress transaction'), {
        name: 'UnknownError',
      }),
    ),
    true,
    'the other WebKit variants (index records / cursor / key) match too',
  )
  assert.equal(
    isBrokenIdbConnection(
      Object.assign(new Error('Attempt to open a cursor in database without an in progress transaction'), { name: 'UnknownError' }),
    ),
    true,
    'a hyphen-less message still matches (the report pasted it that way)',
  )
  assert.equal(isBrokenIdbConnection(Object.assign(new Error('DatabaseClosed'), { name: 'DatabaseClosedError' })), true)
  // Dexie RE-WRAPS a failed open: `exceptions.OpenFailed(dbOpenError)` sets the
  // message to "<inner.name> <inner.message>" and the name to the wrapper's, so
  // every later operation on that failed boot reports OpenFailedError. Matching
  // the name alone would miss exactly the boot case C9 exists for.
  assert.equal(
    isBrokenIdbConnection(
      Object.assign(new Error('InvalidStateError The database connection is closing.'), { name: 'OpenFailedError' }),
    ),
    true,
    'a Dexie-wrapped dead handle still matches on the combined text',
  )
})

test('isBrokenIdbConnection: an ordinary failure is NOT a dead connection', () => {
  // A3's abort is the everyday transient shape — retrying it blind would only
  // delay a real boot bug.
  assert.equal(isBrokenIdbConnection(Object.assign(new Error('the transaction was aborted'), { name: 'AbortError' })), false)
  assert.equal(isBrokenIdbConnection(Object.assign(new Error('duplicate'), { name: 'ConstraintError' })), false)
  assert.equal(isBrokenIdbConnection(new Error('boom')), false)
  assert.equal(isBrokenIdbConnection(Object.assign(new Error('wide open'), { name: 'InvalidStateError' })), false, 'only a CLOSING connection, not every InvalidStateError')
  assert.equal(isBrokenIdbConnection(undefined), false)
  assert.equal(isBrokenIdbConnection(null), false)
  assert.equal(isBrokenIdbConnection('UnknownError: attempt to get a record'), false, 'a bare string has no name and no reliable shape')
  // Dexie's `TransactionInactiveError` is `if (!this.active) throw` — a table
  // used after its transaction finished, i.e. the async-gap programming error.
  // Retrying it would run the operation OUTSIDE the scope the caller wrote it
  // in and mask a real bug with a wrong write.
  assert.equal(
    isBrokenIdbConnection(Object.assign(new Error('Transaction has already completed or failed'), { name: 'TransactionInactiveError' })),
    false,
    'a transactional-state error is not a dead connection',
  )
  // The platform has no IndexedDB at all (Dexie wraps that in a
  // DatabaseClosedError): nothing is dead and a reopen can never help, so this
  // must not be classified — or every operation in such an environment would
  // churn a futile reopen.
  assert.equal(
    isBrokenIdbConnection(
      Object.assign(new Error('MissingAPIError IndexedDB API missing. Please visit https://tinyurl.com/y2uuvskb'), {
        name: 'DatabaseClosedError',
      }),
    ),
    false,
    'a capability absence is not a dead handle',
  )
})

test('planStorageInitAttempt: reopen while attempts remain, then abort', () => {
  const dead = webkitDeadConnection()
  assert.equal(planStorageInitAttempt(dead, 1), 'reopen')
  assert.equal(planStorageInitAttempt(dead, 2), 'reopen')
  assert.equal(planStorageInitAttempt(dead, STORAGE_INIT_MAX_ATTEMPTS), 'abort', 'the last attempt surfaces the error')
  assert.equal(planStorageInitAttempt(dead, 1, 1), 'abort', 'a max of 1 never reopens')
  // A non-connection error aborts on the FIRST attempt: no retry, no reopen.
  assert.equal(planStorageInitAttempt(new Error('boom'), 1), 'abort')
  assert.equal(planStorageInitAttempt(Object.assign(new Error('aborted'), { name: 'AbortError' }), 1), 'abort')
})

test('planOperationRetry: recover a dead handle, do not churn a fresh one', () => {
  const dead = webkitDeadConnection()
  // No reopen has happened yet (or the connection is closed) → full reopen.
  assert.equal(planOperationRetry(dead, retryCtx()), 'reopen-and-retry')
  assert.equal(planOperationRetry(dead, retryCtx({ connectionOpen: false })), 'reopen-and-retry')
  assert.equal(
    planOperationRetry(dead, retryCtx({ connectionOpen: false, msSinceReopen: 0 })),
    'reopen-and-retry',
    'a CLOSED connection is never assumed healthy',
  )
  // A reopen just landed: this is almost certainly a sibling of that recovery,
  // so retry against the fresh connection instead of closing it again.
  assert.equal(planOperationRetry(dead, retryCtx({ msSinceReopen: 0 })), 'retry')
  assert.equal(planOperationRetry(dead, retryCtx({ msSinceReopen: RECOVERY_COOLDOWN_MS - 1 })), 'retry')
  assert.equal(planOperationRetry(dead, retryCtx({ msSinceReopen: RECOVERY_COOLDOWN_MS })), 'reopen-and-retry', 'the cooldown expired')
  // Not a dead connection → never recovered from here.
  assert.equal(planOperationRetry(new Error('boom'), retryCtx()), 'surface')
  assert.equal(planOperationRetry(Object.assign(new Error('aborted'), { name: 'AbortError' }), retryCtx()), 'surface')
  // A cooldown of 0 disables the suppression entirely (tests/hosts may opt out).
  assert.equal(planOperationRetry(dead, retryCtx({ msSinceReopen: 0 }), { cooldownMs: 0 }), 'reopen-and-retry')
})

test('planOperationRetry: a recovery that just FAILED backs off instead of looping', () => {
  const dead = webkitDeadConnection()
  // The connection is not coming back by itself: immediate re-attempts would
  // turn every operation into another open() plus another pair of ring lines.
  assert.equal(planOperationRetry(dead, retryCtx({ msSinceFailedRecovery: 0 })), 'surface')
  assert.equal(planOperationRetry(dead, retryCtx({ msSinceFailedRecovery: RECOVERY_FAILURE_BACKOFF_MS - 1 })), 'surface')
  assert.equal(
    planOperationRetry(dead, retryCtx({ msSinceFailedRecovery: RECOVERY_FAILURE_BACKOFF_MS })),
    'reopen-and-retry',
    'after the backoff the operation tries again',
  )
  // The backoff outranks the cooldown: a failed recovery is not "a fresh
  // connection someone else just opened".
  assert.equal(planOperationRetry(dead, retryCtx({ msSinceReopen: 0, msSinceFailedRecovery: 0 })), 'surface')
  // A FAILED recovery while the connection reads closed still backs off (the
  // retry decision below it is what a closed connection short-circuits).
  assert.equal(planOperationRetry(dead, retryCtx({ connectionOpen: false, msSinceFailedRecovery: 0 })), 'surface')
})

test('describeStorageError: one bounded, greppable line', () => {
  assert.equal(
    describeStorageError(webkitDeadConnection()),
    'UnknownError Attempt to get a record from database without an in-progress transaction',
  )
  assert.equal(describeStorageError(new Error('a\n  b')), 'Error a b', 'whitespace collapses for the ring')
  assert.equal(describeStorageError(undefined), 'unknown error')
  const long = describeStorageError(new Error('x'.repeat(500)))
  assert.equal(long.length, 180)
  assert.ok(long.endsWith('…'))
})
