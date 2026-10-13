// Pins the pending-scrobble enqueue policy (A3, 2026-10-09): only the unique
// index violation is a duplicate. The old catch-all read an AbortError as
// "already queued" — the 2026-10-08 dump showed 20 of those on ordinary track
// advances — so a dropped Listen left no trace anywhere.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDuplicateEnqueueError } from '../src/lib/scrobbleEnqueuePolicy'

test('isDuplicateEnqueueError: only the unique-index violation is a duplicate', () => {
  assert.equal(isDuplicateEnqueueError({ name: 'ConstraintError' }), true)
  const abort = Object.assign(new Error('the transaction was aborted'), { name: 'AbortError' })
  assert.equal(isDuplicateEnqueueError(abort), false, 'an aborted write is retryable, never a duplicate')
  assert.equal(isDuplicateEnqueueError(new Error('boom')), false)
  assert.equal(isDuplicateEnqueueError(undefined), false)
  assert.equal(isDuplicateEnqueueError(null), false)
  assert.equal(isDuplicateEnqueueError('ConstraintError'), false, 'a bare string is not an error object')
})
