// Unit pins for the pure playback-position intent latch (2026-10-07, Phase 1
// of docs/plans/2026-10-07-seek-intent-and-stream-epochs.md). The latch is the
// JS half of "a playback position is an intent": it survives load latency and
// is spent exactly once by the load path that finally owns a source.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearSeekIntent,
  consumeSeekIntent,
  createSeekIntentState,
  latchSeekIntent,
} from '../src/lib/playbackCore/seekIntent'

test('a latched intent is consumed once by its own row', () => {
  const state = createSeekIntentState()
  latchSeekIntent(state, 't1', 60)

  const spent = consumeSeekIntent(state, 't1')
  assert.equal(spent?.trackId, 't1')
  assert.equal(spent?.position, 60)
  // Single-use: the second consume finds nothing.
  assert.equal(consumeSeekIntent(state, 't1'), null)
})

test('latest wins: a newer scrub replaces the parked position and bumps the generation', () => {
  const state = createSeekIntentState()
  const first = latchSeekIntent(state, 't1', 10)
  const second = latchSeekIntent(state, 't1', 42)

  assert.equal(second.generation, first.generation + 1)
  assert.equal(state.intent?.position, 42)
  assert.equal(consumeSeekIntent(state, 't1')?.position, 42)
})

test('a consume against another row clears without applying (the app moved on)', () => {
  const state = createSeekIntentState()
  latchSeekIntent(state, 't1', 60)

  assert.equal(consumeSeekIntent(state, 't2'), null)
  // The stale intent must NOT survive and apply to a later t1 load.
  assert.equal(state.intent, null)
  assert.equal(consumeSeekIntent(state, 't1'), null)
})

test('clearSeekIntent drops the parked intent (stop/teardown)', () => {
  const state = createSeekIntentState()
  latchSeekIntent(state, 't1', 60)
  clearSeekIntent(state)
  assert.equal(state.intent, null)
})

test('consuming an empty latch is a no-op', () => {
  const state = createSeekIntentState()
  assert.equal(consumeSeekIntent(state, 't1'), null)
})
