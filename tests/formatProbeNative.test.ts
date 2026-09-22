import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyProbeResult,
  probeMapIsStale,
  stampProbeMap,
  PROBE_STAMP_KEY,
  type FormatVerdict,
} from '../src/lib/formatProbe.ts'

/**
 * The codec probe is now EVIDENCE-BASED on both platforms (2026-09-21,
 * "what is the point of checking if it doesn't actually verify"): the
 * static per-platform table and the OS-version gate are GONE — they
 * decided verdicts with zero evidence and field-pinned a bogus mp3
 * fallback twice. Native feeds the real bytes to AVAudioFile over a
 * `probeFormat` bridge call; web feeds them to an Audio element. The pure
 * pins below cover the persistence DECISIONS; the transport phase
 * (two-phase classification, JSON screening) is pinned natively in
 * DecodeProbeTests.swift — same semantics, same platform as the decoder.
 */

test('applyProbeResult: evidence-backed verdict persists and overwrites stale rows', () => {
  const stale: Record<string, FormatVerdict> = { opus: 'unsupported' }
  const r = applyProbeResult(stale, 'opus', 'ok')
  assert.equal(r.persist, true)
  assert.equal(r.next.opus, 'ok', 'an OS update that adds support must un-pin the fallback')
  // The input map is never mutated (the settings store holds a reference).
  assert.equal(stale.opus, 'unsupported')
})

test('applyProbeResult: identical verdict does not write', () => {
  const cur: Record<string, FormatVerdict> = { opus: 'ok' }
  const r = applyProbeResult(cur, 'opus', 'ok')
  assert.equal(r.persist, false)
})

test('applyProbeResult: network/unknown never persist — no evidence, no pin', () => {
  for (const v of ['network', 'unknown'] as const) {
    const r = applyProbeResult(undefined, 'opus', v)
    assert.equal(r.persist, false, `${v} must not pin a permanent fallback`)
    assert.deepEqual(r.next, {})
  }
})

test('applyProbeResult: unsupported persists — the device gave real evidence', () => {
  const r = applyProbeResult(undefined, 'aac', 'unsupported')
  assert.equal(r.persist, true)
  assert.equal(r.next.aac, 'unsupported')
})

test('applyProbeResult: other formats in the map are preserved', () => {
  const cur: Record<string, FormatVerdict> = { mp3: 'ok', flac: 'ok' }
  const r = applyProbeResult(cur, 'opus', 'ok')
  assert.equal(r.next.mp3, 'ok')
  assert.equal(r.next.flac, 'ok')
  assert.equal(r.next.opus, 'ok')
})

// --- F5: the probe-stamp gate (2026-09-22 field dump) ------------------------
// Verdicts persisted by the 1.2.30 static-table regression carried no
// provenance and short-circuited the (now evidence-based) probe forever —
// an iOS 27 device kept its bogus "opus unsupported" pin. The stamp makes
// provenance part of the cached shape.

test('probeMapIsStale: a legacy un-stamped map is stale by definition', () => {
  const legacy = { opus: 'unsupported' } as Record<string, FormatVerdict>
  assert.equal(probeMapIsStale(legacy, '1.2.33'), true)
})

test('probeMapIsStale: undefined map is not stale (nothing cached)', () => {
  assert.equal(probeMapIsStale(undefined, '1.2.33'), false)
})

test('probeMapIsStale: same-version stamp is fresh, older stamp is stale', () => {
  const fresh = stampProbeMap({ opus: 'ok' }, '1.2.33')
  assert.equal(probeMapIsStale(fresh, '1.2.33'), false)
  assert.equal(probeMapIsStale(fresh, '1.2.34'), true, 'an app update re-probes')
})

test('stampProbeMap: preserves verdicts and carries the version', () => {
  const stamped = stampProbeMap({ opus: 'ok', mp3: 'ok' }, '1.2.33')
  assert.equal(stamped.opus, 'ok')
  assert.equal(stamped.mp3, 'ok')
  assert.equal((stamped as Record<string, unknown>)[PROBE_STAMP_KEY], '1.2.33')
})

test('probeMapIsStale: a non-string stamp (corrupt) is stale', () => {
  const corrupt = { opus: 'ok', [PROBE_STAMP_KEY]: 42 } as unknown as Record<string, FormatVerdict>
  assert.equal(probeMapIsStale(corrupt, '1.2.33'), true)
})
