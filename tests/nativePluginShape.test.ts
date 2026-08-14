import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NativeAudioEngineApp } from '../src/lib/nativePlugin'
import type { NativeEngineClient } from '../src/lib/playbackCore/nativeTransport'

/**
 * Compile-time shape check: the real `nativeEngine` (class `NativeAudioEngineApp`
 * from nativePlugin.ts) must satisfy the transport's `NativeEngineClient`
 * contract — the module docstring claims structural assignability via
 * method-style bivariance, and this pins it so interface drift fails `npm run
 * check` before any wiring. Type-only import: nativePlugin.ts (and its
 * Capacitor import) never executes under node --test.
 */
test('the real nativeEngine satisfies the NativeEngineClient contract', () => {
  // Compile-only: the assignment below errors if the class ever drifts from
  // the client contract. The null cast is never dereferenced at runtime.
  const probe: NativeAudioEngineApp = null as unknown as NativeAudioEngineApp
  const client: NativeEngineClient = probe
  assert.equal(typeof client, 'object')
})