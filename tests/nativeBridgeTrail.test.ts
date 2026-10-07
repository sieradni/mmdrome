// Pins the bridge trail's SEEK EPOCH actor line (2026-10-07, Phase 2 of
// docs/plans/2026-10-07-seek-intent-and-stream-epochs.md).
//
// The trail is the multi-skip dump's discriminator between "the engine moved
// the playhead" and "JS positioned it". A server-offset epoch is a THIRD
// positioner, so its line must name `epoch` and carry the base/target it moved
// to — otherwise a future investigation blames engage/refreshQueue for a
// position only the epoch set.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { epochTrailLine } from '../src/lib/playbackCore/nativeBridgeTrail'

test('the open line names the epoch actor with its base and target', () => {
  const line = epochTrailLine({ phase: 'open', epoch: 2, base: 187, target: 187.9 })
  assert.equal(line, 'epoch open #2 base=187s target=187.9s')
  // The actor name is what a dump groups by — it must not be an engage shape.
  assert.match(line, /^epoch /)
  assert.doesNotMatch(line, /engage|refreshQueue/)
})

test('the verdict line carries the container evidence verbatim', () => {
  const line = epochTrailLine({
    phase: 'verdict',
    epoch: 3,
    base: 300,
    verdict: 'honored',
    containerFrames: 13_230_000,
    expectedFrames: 13_230_000,
  })
  assert.equal(line, 'epoch verdict #3 base=300s verdict=honored container=13230000f expected=13230000f')
})

test('a rebase (ignored) and a discard (unknown) are distinguishable', () => {
  assert.equal(
    epochTrailLine({ phase: 'verdict', epoch: 1, base: 60, verdict: 'ignored' }),
    'epoch verdict #1 base=60s verdict=ignored',
  )
  assert.equal(
    epochTrailLine({ phase: 'closed', base: 60, verdict: 'unknown' }),
    'epoch closed base=60s verdict=unknown',
  )
  // A close with no verdict (the transfer died before an open, or the kill
  // switch discarded a live epoch) still records its actor and base.
  assert.equal(epochTrailLine({ phase: 'closed', base: 90 }), 'epoch closed base=90s')
})

test('missing fields never fabricate a bad number', () => {
  const line = epochTrailLine({ phase: 'closed', base: 0 })
  assert.equal(line, 'epoch closed base=0s')
  assert.doesNotMatch(line, /NaN|undefined|null/)
})
