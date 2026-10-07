// Unit pins for the pure seek-capability derivation (2026-10-07, Phase 0 of
// docs/plans/2026-10-07-seek-intent-and-stream-epochs.md). The rule must never
// cost correctness: a "false" is allowed only when direct play is CERTAIN.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSeekCapability } from '../src/lib/playbackCore/seekCapability'

const opus128 = { format: 'opus', maxBitRate: 128 }

test('a transcoded row can server-offset (runtime verdict is the authority)', () => {
  const cap = deriveSeekCapability({ transcode: opus128, fileType: 'flac', bitrate: 900 })
  assert.equal(cap.canServerOffset, true)
  assert.equal(cap.paramName, 'timeOffset')
  assert.equal(cap.sourceFileType, 'flac')
  assert.equal(cap.sourceBitrate, 900)
  assert.equal(cap.clientSplice, 'flac')
})

test('format equal to the source suffix with a covering cap is a CERTAIN direct play', () => {
  const cap = deriveSeekCapability({ transcode: { format: 'mp3', maxBitRate: 320 }, fileType: 'mp3', bitrate: 192 })
  assert.equal(cap.canServerOffset, false)
  // The prediction still carries the evidence for the HUD/diagnostics.
  assert.equal(cap.paramName, 'timeOffset')
  assert.equal(cap.sourceBitrate, 192)
})

test('format equal to the source suffix with a cap BELOW the source still transcodes', () => {
  const cap = deriveSeekCapability({ transcode: { format: 'mp3', maxBitRate: 64 }, fileType: 'mp3', bitrate: 192 })
  assert.equal(cap.canServerOffset, true)
})

test('an UNKNOWN source bitrate errs toward can (never silently disable epochs)', () => {
  const cap = deriveSeekCapability({ transcode: { format: 'mp3', maxBitRate: 64 }, fileType: 'mp3' })
  assert.equal(cap.canServerOffset, true)
  assert.equal(cap.sourceBitrate, undefined)
})

test('a raw URL can never server-offset (Phase 3 raw splice owns that lane)', () => {
  const cap = deriveSeekCapability({ transcode: null, fileType: 'flac', bitrate: 900 })
  assert.equal(cap.canServerOffset, false)
  // The splice hint still rides (Phase 3 consumes it); Phase 2 does not.
  assert.equal(cap.clientSplice, 'flac')
})

test('only FLAC declares a splice capability — Ogg waits for the fixture proof', () => {
  assert.equal(deriveSeekCapability({ transcode: null, fileType: 'ogg' }).clientSplice, undefined)
  assert.equal(deriveSeekCapability({ transcode: opus128, fileType: 'ogg' }).clientSplice, undefined)
  assert.equal(deriveSeekCapability({ transcode: opus128, fileType: 'flac' }).clientSplice, 'flac')
})

test('case/whitespace in the requested format cannot fake a direct play', () => {
  const cap = deriveSeekCapability({ transcode: { format: ' MP3 ', maxBitRate: 320 }, fileType: 'mp3', bitrate: 128 })
  assert.equal(cap.canServerOffset, false)
})
