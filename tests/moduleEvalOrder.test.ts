// Regression pin for the module-eval-order cycle between playbackManager and
// sleepTimer. App.svelte imports `sleepTimerManager` BEFORE `playbackManager`;
// when sleepTimer imported the manager back, that ordering evaluated
// playbackManager's singleton constructor (which eagerly reads
// `sleepTimerManager`) before sleepTimer finished initializing the binding.
// Native ESM throws a TDZ ReferenceError there; the production (Rollup) bundle
// hoists the cyclic `const` to `undefined`, so `playbackManager._stm` was
// undefined and `init()`/`play()` threw "can't access property ... this._stm
// is undefined" at runtime. This file reproduces the App.svelte import order
// (sleepTimer FIRST) and asserts the singleton wired up the real controller.
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
