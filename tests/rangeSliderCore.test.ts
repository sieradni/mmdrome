// Pins the dual-handle slider's handle-resolution model (2026-11-14). The
// component owns pixels; these are the rules a press and a drag follow. They
// exist because a FIXED "overlapping handles → maximum" tie-break made a
// collapsed pair at the RIGHT edge immovable: the press grabbed the maximum,
// every move clamped back to `lo`, and dragging the minimum down did nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyHandleMove,
  pickDragHandle,
  resolvePendingHandle,
} from '../src/lib/rangeSliderCore'

test('separated handles: a press grabs the nearer handle', () => {
  assert.equal(pickDragHandle(0, 20, 80), 0)
  assert.equal(pickDragHandle(30, 20, 80), 0)
  assert.equal(pickDragHandle(49, 20, 80), 0)
  assert.equal(pickDragHandle(51, 20, 80), 1)
  assert.equal(pickDragHandle(90, 20, 80), 1)
  assert.equal(pickDragHandle(100, 20, 80), 1)
})

test('overlapping handles at the RIGHT edge: a press to the left grabs the minimum', () => {
  // The reported defect: the pair is parked on the domain maximum, so the press
  // used to grab the maximum and the drag was clamped back to the same value.
  assert.equal(pickDragHandle(60, 100, 100), 0)
  assert.deepEqual(applyHandleMove(0, 60, 100, 100), [60, 100])
})

test('overlapping handles: a press exactly ON the pair defers to the first move', () => {
  assert.equal(pickDragHandle(100, 100, 100), 'pending')
  assert.equal(resolvePendingHandle(100, 100), null) // no movement yet
  assert.equal(resolvePendingHandle(99, 100), 0) // left → minimum
  assert.equal(resolvePendingHandle(100, 100) === null, true)
  // Collapsed in the middle, either direction opens that side.
  assert.equal(resolvePendingHandle(50, 40), 1)
  assert.equal(resolvePendingHandle(30, 40), 0)
})

test('overlapping handles at the LEFT edge still widen to the right', () => {
  assert.equal(pickDragHandle(40, 0, 0), 1)
  assert.deepEqual(applyHandleMove(1, 40, 0, 0), [0, 40])
})

test('the reported gesture: both handles at the maximum, drag the disc left', () => {
  const handle = resolvePendingHandle(90, 100)
  assert.equal(handle, 0)
  // The minimum follows the pointer down, the maximum stays where it was…
  assert.deepEqual(applyHandleMove(handle as 0, 90, 100, 100), [90, 100])
  // …continues through the same gesture…
  assert.deepEqual(applyHandleMove(0, 50, 90, 100), [50, 100])
  // …and is clamped at the maximum instead of crossing it.
  assert.deepEqual(applyHandleMove(0, 120, 50, 100), [100, 100])
})

test('the maximum handle clamps at the minimum rather than crossing it', () => {
  assert.deepEqual(applyHandleMove(1, 10, 30, 50), [30, 30])
  assert.deepEqual(applyHandleMove(1, 60, 30, 50), [30, 60])
})
