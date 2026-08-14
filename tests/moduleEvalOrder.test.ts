// Regression pin for the module-eval-order hazard between playbackManager and
// sleepTimer. App.svelte imports `sleepTimerManager` BEFORE `playbackManager`;
// when sleepTimer imported the manager back, that ordering evaluated
// playbackManager's singleton constructor (which eagerly read
// `sleepTimerManager`) before sleepTimer finished initializing the binding — a
// TDZ ReferenceError under Node, silently `undefined` in the production bundle
// ("can't access property ... this._stm is undefined"). Two fixes landed: the
// dependency was inverted (sleepTimer exposes `setExpireHandler`), and the
// manager's engine deps became lazy getters so construction no longer reads
// any module binding. This file still reproduces App.svelte's import order
// (sleepTimer FIRST) and asserts the graph loads and `_stm` resolves to the
// real controller.
//
// Import order is the whole point of the test — do NOT reorder these.

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sleepTimerManager } from '../src/lib/sleepTimer'
import { playbackManager } from '../src/lib/playbackManager'

test('playbackManager singleton resolves the real sleepTimerManager when sleepTimer is imported first', () => {
  const stm = (playbackManager as unknown as { _stm: unknown })._stm
  assert.ok(stm, 'playbackManager._stm is undefined — a module-eval cycle left the sleepTimer binding uninitialized')
  assert.equal(stm, sleepTimerManager, 'playbackManager._stm must be the sleepTimerManager singleton')
})
