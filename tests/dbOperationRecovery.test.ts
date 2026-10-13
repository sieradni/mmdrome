// Pins the transparent per-operation IndexedDB recovery (2026-10-13, the
// follow-up to C9's boot-only recovery): a dead-handle failure on ANY store
// read/write reopens the connection and re-runs the operation instead of
// surfacing.
//
// The wrappers are exercised over FAKE prototypes shaped like Dexie's — the
// methods live on a base prototype and get wrapped on the per-instance
// subclass prototype (Dexie subclasses its internal Table/Collection per db),
// so the tests drive the real installer without IndexedDB. The bounds matter
// as much as the recovery: one retry per operation, one reopen per burst
// (single-flight), no reopen churn inside the cooldown, no reopen at all once a
// recovery has FAILED (backoff), and never a retry for a non-dead-connection
// error or for a callback-iterating read that already handed rows over.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CALLBACK_ITERATING_METHODS, collectWrappableMethods, installOperationRecovery } from '../src/lib/dbOperationRecovery'
import { db } from '../src/lib/db'

function deadError(): Error {
  return Object.assign(
    new Error('Attempt to get a record from database without an in-progress transaction'),
    { name: 'UnknownError' },
  )
}

/** Behind the fake prototypes: records calls and queues errors for the next
 *  calls of a named operation. */
const mock = {
  calls: [] as string[],
  failures: new Map<string, unknown[]>(),
  /** Names whose fake delivers a row BEFORE consuming a queued failure (the
   *  mid-iteration failure shape a retry must never repeat). */
  afterDelivery: new Set<string>(),
  reset() {
    mock.calls.length = 0
    mock.failures.clear()
    mock.afterDelivery.clear()
  },
  /** The next `times` calls to `name` throw these errors. */
  fail(name: string, ...errors: unknown[]) {
    mock.failures.set(name, [...(mock.failures.get(name) ?? []), ...errors])
  },
  hit(name: string): boolean {
    mock.calls.push(name)
    const queue = mock.failures.get(name)
    if (queue && queue.length > 0) throw queue.shift()
    return true
  },
}

class FakeBase {
  name = 'host'
  /** Wrapped (promise-returning), like Dexie's Table.get. */
  async get(key: string) {
    mock.hit('get')
    return { key }
  }

  async put(value: unknown) {
    mock.hit('put')
    return value
  }

  async count() {
    mock.hit('count')
    return 3
  }

  /** Callback-iterating. By default a queued failure lands BEFORE any delivery
   *  (the dominant dead-handle shape — the transaction never starts); with
   *  `mock.afterDelivery` armed it delivers a row first. */
  async each(cb?: (v: unknown) => void) {
    if (mock.afterDelivery.has('each')) {
      mock.calls.push('each')
      if (typeof cb === 'function') cb('row')
      throw mock.failures.get('each')?.shift() ?? new Error('partial boom')
    }
    mock.hit('each')
    if (typeof cb === 'function') cb('row')
    return undefined
  }

  /** Chain builder: returns a non-thenable (Dexie's where/limit). */
  where() {
    mock.hit('where')
    return { marker: 'collection' }
  }

  /** Synchronous thrower (Dexie's argument validators). */
  syncThrow() {
    mock.hit('syncThrow')
    return 'ok'
  }

  /** Dexie-private: never wrapped. */
  _trans() {
    mock.hit('_trans')
    return 'internal'
  }

  /** Accessor: never shadowed by a wrapper. */
  get core() {
    mock.hit('core')
    return 'the core'
  }
}

interface HostState {
  recoveries: number
  reopensAt: number[]
  clock: number
  open: boolean
  recoverFails: boolean
}

function makeHost(options: { cooldownMs?: number; failureBackoffMs?: number; installTwice?: boolean } = {}) {
  const state: HostState = { recoveries: 0, reopensAt: [], clock: 1000, open: true, recoverFails: false }
  class Host extends FakeBase {}
  const opts = {
    recover: async () => {
      state.recoveries++
      if (state.recoverFails) throw new Error('reopen boom')
      state.reopensAt.push(state.clock)
    },
    isOpen: () => state.open,
    now: () => state.clock,
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
    ...(options.failureBackoffMs === undefined ? {} : { failureBackoffMs: options.failureBackoffMs }),
  }
  const wrapped = installOperationRecovery([Host.prototype], opts)
  const second = options.installTwice ? installOperationRecovery([Host.prototype], opts) : null
  return { host: new Host() as FakeBase, wrapped, second, state }
}

test('a dead-handle failure reopens the connection and re-runs the operation', async () => {
  mock.reset()
  const { host, wrapped, state } = makeHost()
  mock.fail('get', deadError())
  assert.deepEqual(await host.get('k'), { key: 'k' })
  assert.deepEqual(mock.calls, ['get', 'get'], 'the operation ran twice')
  assert.equal(state.recoveries, 1)
  assert.ok(wrapped.includes('get') && wrapped.includes('put') && wrapped.includes('count'), 'public ops are wrapped')
})

test('an ordinary failure is rethrown untouched — no reopen, no retry', async () => {
  mock.reset()
  const { host, state } = makeHost()
  const boom = new Error('boom')
  mock.fail('put', boom)
  await assert.rejects(host.put(1), (err) => err === boom)
  assert.deepEqual(mock.calls, ['put'], 'no retry')
  assert.equal(state.recoveries, 0)
})

test('an AbortError is not a dead handle (A3) — it surfaces unchanged', async () => {
  mock.reset()
  const { host, state } = makeHost()
  const abort = Object.assign(new Error('the transaction was aborted'), { name: 'AbortError' })
  mock.fail('count', abort)
  await assert.rejects(host.count(), (err) => err === abort)
  assert.equal(state.recoveries, 0)
})

test('a sibling failure inside the cooldown retries WITHOUT churning another reopen', async () => {
  mock.reset()
  const { host, state } = makeHost({ cooldownMs: 1500 })
  // 1st failure: no reopen has ever happened → reopen-and-retry.
  mock.fail('get', deadError())
  await host.get('a')
  assert.equal(state.recoveries, 1)
  // 2nd failure at the same instant (the burst shape): the reopen just landed,
  // so retry against it instead of closing the connection under everyone else.
  mock.fail('get', deadError())
  await host.get('b')
  assert.equal(state.recoveries, 1, 'still one reopen')
  assert.deepEqual(mock.calls, ['get', 'get', 'get', 'get'])
})

test('a connection that reports CLOSED reopens even inside the cooldown', async () => {
  mock.reset()
  const { host, state } = makeHost({ cooldownMs: 1500 })
  mock.fail('get', deadError())
  await host.get('a')
  assert.equal(state.recoveries, 1)
  state.open = false
  mock.fail('get', deadError())
  await host.get('b')
  assert.equal(state.recoveries, 2, 'a closed connection is never assumed healthy')
})

test('after the cooldown a fresh dead handle reopens again', async () => {
  mock.reset()
  const { host, state } = makeHost({ cooldownMs: 1500 })
  mock.fail('get', deadError())
  await host.get('a')
  state.clock += 1500
  mock.fail('get', deadError())
  await host.get('b')
  assert.equal(state.recoveries, 2, 'the cooldown expired')
})

test('a burst of simultaneous failures shares ONE reopen (single-flight)', async () => {
  mock.reset()
  const { host, state } = makeHost()
  mock.fail('get', deadError())
  mock.fail('put', deadError())
  mock.fail('count', deadError())
  const results = await Promise.all([host.get('x'), host.put('y'), host.count()])
  assert.deepEqual(results, [{ key: 'x' }, 'y', 3])
  assert.equal(state.recoveries, 1, 'three failures, one reopen')
  assert.deepEqual(state.reopensAt, [1000])
})

test('a failed reopen surfaces the ORIGINAL error and never retries', async () => {
  mock.reset()
  const { host, state } = makeHost()
  state.recoverFails = true
  const original = deadError()
  mock.fail('get', original)
  await assert.rejects(host.get('k'), (err) => err === original)
  assert.deepEqual(mock.calls, ['get'], 'the operation was not re-run')
  assert.equal(state.recoveries, 1)
})

test('after a FAILED recovery further dead failures surface until the backoff expires', async () => {
  mock.reset()
  const { host, state } = makeHost({ failureBackoffMs: 1500 })
  state.recoverFails = true
  const first = deadError()
  mock.fail('get', first)
  await assert.rejects(host.get('a'), (err) => err === first)
  assert.equal(state.recoveries, 1)
  // Same instant: a connection that just failed to reopen must not be
  // re-attempted once per operation (a write loop would storm indexDB.open()).
  const second = deadError()
  mock.fail('get', second)
  await assert.rejects(host.get('b'), (err) => err === second)
  assert.equal(state.recoveries, 1, 'no second reopen inside the backoff')
  assert.deepEqual(mock.calls, ['get', 'get'], 'the second operation was never re-run')
  // Once the backoff has expired the next dead failure tries again.
  state.clock += 1500
  state.recoverFails = false
  mock.fail('get', deadError())
  await host.get('c')
  assert.equal(state.recoveries, 2, 'the backoff expired')
})

test('the retry is bounded: a second dead failure inside it surfaces', async () => {
  mock.reset()
  const { host, state } = makeHost()
  const first = deadError()
  const second = deadError()
  mock.fail('get', first, second)
  await assert.rejects(host.get('k'), (err) => err === second)
  assert.equal(state.recoveries, 1, 'the recovery happened once')
  assert.deepEqual(mock.calls, ['get', 'get'], 'exactly one retry')
})

test('chain builders pass through untouched and never trigger a recovery', () => {
  mock.reset()
  const { host, state } = makeHost()
  assert.deepEqual(host.where(), { marker: 'collection' })
  assert.equal(state.recoveries, 0)
})

test('a callback-iterating read retries ONLY while nothing was delivered', async () => {
  mock.reset()
  const { host, wrapped, state } = makeHost()
  assert.ok(wrapped.includes('each'), 'each is wrapped — its retry is gated, not forbidden')
  assert.ok(collectWrappableMethods(Object.getPrototypeOf(host) as object).includes('each'))
  assert.ok(CALLBACK_ITERATING_METHODS.includes('each'))
  // The dead-handle shape: the transaction never starts, so the callback was
  // never invoked and re-running cannot re-deliver anything.
  mock.fail('each', deadError())
  const seen: unknown[] = []
  await host.each((v) => seen.push(v))
  assert.deepEqual(seen, ['row'], 'the callback saw the row exactly once')
  assert.deepEqual(mock.calls, ['each', 'each'], 'the operation ran twice')
  assert.equal(state.recoveries, 1)
})

test('a callback-iterating read that already delivered rows surfaces — never re-delivers', async () => {
  mock.reset()
  const { host, state } = makeHost()
  const dead = deadError()
  mock.fail('each', dead)
  mock.afterDelivery.add('each')
  const seen: unknown[] = []
  await assert.rejects(host.each((v) => seen.push(v)), (err) => err === dead)
  assert.deepEqual(seen, ['row'], 'the caller processed the row once')
  assert.deepEqual(mock.calls, ['each'], 'no retry: that row would arrive twice')
  assert.equal(state.recoveries, 0)
})

test('a callback-iterating read without a countable callback never retries', async () => {
  mock.reset()
  const { host, state } = makeHost()
  const dead = deadError()
  mock.fail('each', dead)
  await assert.rejects(
    (host.each as unknown as (cb?: unknown) => Promise<unknown>)(),
    (err) => err === dead,
    'with nothing to instrument there is no proof that nothing was delivered',
  )
  assert.equal(state.recoveries, 0)
})

test('Dexie-private members and accessors are left alone', () => {
  const { host, wrapped } = makeHost()
  assert.ok(!wrapped.includes('_trans'))
  assert.ok(!wrapped.includes('core'))
  assert.equal(host._trans(), 'internal')
  assert.equal(host.core, 'the core')
})

test('a synchronous thrower keeps throwing for an ordinary error', () => {
  mock.reset()
  const { host, state } = makeHost()
  mock.fail('syncThrow', new Error('invalid argument'))
  assert.throws(() => host.syncThrow(), /invalid argument/)
  assert.equal(state.recoveries, 0)
})

test('a dead connection throwing synchronously still recovers', async () => {
  mock.reset()
  const { host, state } = makeHost()
  mock.fail('syncThrow', deadError())
  assert.equal(await host.syncThrow(), 'ok', 'the recovered call returns the retry promise')
  assert.equal(state.recoveries, 1)
})

test('the app database has operation recovery installed at module load', () => {
  // Without this pin the whole feature could silently not install (a renamed
  // `Table`/`Collection` on a future Dexie, or installing before the instance
  // exists) and every unit test above would still pass.
  const runtime = db as unknown as { Table?: { prototype: object }; Collection?: { prototype: object } }
  const tableProto = runtime.Table?.prototype as Record<string, unknown>
  const tableBase = Object.getPrototypeOf(tableProto) as Record<string, unknown>
  // `each*` is wrapped too (its retry is gated on the delivery count), so a
  // future installer change that silently stops wrapping it fails here.
  for (const name of ['get', 'put', 'delete', 'toArray', 'count', 'bulkPut', 'bulkDelete', 'each']) {
    assert.notEqual(tableProto[name], tableBase[name], `Table.${name} is wrapped on the per-instance prototype`)
  }
  const collectionProto = runtime.Collection?.prototype as Record<string, unknown>
  const collectionBase = Object.getPrototypeOf(collectionProto) as Record<string, unknown>
  // `each*` beyond Table.each lives here (`where(…).each()`, the picker's reads).
  for (const name of ['toArray', 'each', 'eachKey']) {
    assert.notEqual(collectionProto[name], collectionBase[name], `Collection.${name} is wrapped too`)
  }
  // Dexie-private internals stay untouched: `_trans` is Dexie's own transaction
  // factory and `core` is assigned per open — wrapping either would be fatal.
  assert.equal(tableProto._trans, tableBase._trans)
  assert.equal(Object.getOwnPropertyDescriptor(tableProto, 'core'), undefined, 'the core accessor is not shadowed')
})

test('installing twice never double-wraps', async () => {
  mock.reset()
  const { host, second, state } = makeHost({ installTwice: true })
  assert.deepEqual(second, [], 'the second install wraps nothing')
  mock.fail('get', deadError())
  await host.get('k')
  assert.deepEqual(mock.calls, ['get', 'get'], 'one retry, not a nested pair')
  assert.equal(state.recoveries, 1)
})
