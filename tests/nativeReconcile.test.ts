import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reconcileReload,
  type NativeReconcileResult,
  type NativeReconcileState,
} from '../src/lib/playbackCore/nativeReconcile'

const known = new Set(['t1', 't2', 't3'])

function state(over: Partial<NativeReconcileState>): NativeReconcileState {
  return { trackId: 't2', playing: true, position: 42, ...over }
}

test('engine not playing - idle (nothing to resync)', () => {
  assert.deepEqual(
    reconcileReload(state({ playing: false }), ['t1', 't2'], (id) => known.has(id)),
    { kind: 'idle' },
  )
})

test('playing but no trackId - idle', () => {
  assert.deepEqual(
    reconcileReload(state({ trackId: '' }), ['t1', 't2'], (id) => known.has(id)),
    { kind: 'idle' },
  )
})

test('idle paths never consult isKnown (side-effect guard)', () => {
  const boom = (): boolean => {
    throw new Error('isKnown must not be consulted on idle states')
  }
  reconcileReload(state({ playing: false }), ['t1'], boom)
  reconcileReload(state({ trackId: '' }), ['t1'], boom)
})

test('playing + known + in combined - resync with the QUEUE index (never state.index)', () => {
  const result = reconcileReload(state({ position: 133.5 }), ['t0', 't1', 't2'], (id) => known.has(id)) as Extract<
    NativeReconcileResult,
    { kind: 'resync' }
  >
  assert.equal(result.kind, 'resync')
  assert.equal(result.trackId, 't2')
  assert.equal(result.index, 2)
  assert.equal(result.position, 133.5)
})

test('a divergent engine index is ignored - indexOf wins (E7)', () => {
  const result = reconcileReload(
    state({ position: 5 }),
    ['t1', 't2', 't3'],
    (id) => known.has(id),
  ) as Extract<NativeReconcileResult, { kind: 'resync' }>
  assert.equal(result.index, 1)
})

test('playing + known + dropped from combined - resync with index -1 (re-adopt)', () => {
  const result = reconcileReload(state({ position: 77 }), ['t1', 't9'], (id) => known.has(id)) as Extract<
    NativeReconcileResult,
    { kind: 'resync' }
  >
  assert.equal(result.kind, 'resync')
  assert.equal(result.index, -1)
  assert.equal(result.position, 77)
})

test('empty combined + known track - resync with index -1', () => {
  const result = reconcileReload(state({ position: 0 }), [], (id) => known.has(id)) as Extract<
    NativeReconcileResult,
    { kind: 'resync' }
  >
  assert.equal(result.index, -1)
})

test('playing + unknown to the library - stop (the honest signal)', () => {
  assert.deepEqual(reconcileReload(state({ trackId: 'foreign' }), ['t1', 't2'], (id) => known.has(id)), {
    kind: 'stop',
  })
})

test('input immutability - arrays/objects are not mutated', () => {
  const combined = ['t1', 't2']
  const snapshot = Object.freeze(state({}))
  reconcileReload(snapshot, combined, (id) => known.has(id))
  assert.deepEqual(combined, ['t1', 't2'])
})
