import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iosMajorVersionForTest } from '../src/lib/formatProbe.ts'

/**
 * The 1.2.30 static-table regression (2026-09-21 field dump): the table said
 * iOS opus = 'unsupported' and the bootstrap persisted it, so an iOS 26/27
 * device that decodes raw Ogg-Opus in AVAudioFile silently fell back to mp3
 * transcoding under LDM. The verdict is version-gated, but the 1.2.31 UA
 * guess ALSO misfired in the field (the persisted `opus: unsupported` rode
 * through the fix): the OS version now comes from the native bridge
 * (`getOsVersion` → `ProcessInfo.operatingSystemVersion`), with the UA parse
 * as fallback only. These pins cover the pure UA fallback parser; the bridge
 * read itself needs Capacitor (web-only in node).
 */

test('iosMajorVersionForTest parses the WKWebView Safari Version token', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
  assert.equal(iosMajorVersionForTest(ua), 26)
})

test('iosMajorVersionForTest: single-digit major parses (old devices stay unsupported)', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.7 Mobile/15E148 Safari/604.1'
  assert.equal(iosMajorVersionForTest(ua), 16)
})

test('iosMajorVersionForTest: no Version token → 0 (conservative, mp3 fallback stays)', () => {
  assert.equal(iosMajorVersionForTest('Mozilla/5.0 (Macintosh) Chrome/120.0'), 0)
  assert.equal(iosMajorVersionForTest(''), 0)
})

test('iosMajorVersionForTest: the gate threshold discriminates 16 (unsupported) from 18 (ok)', () => {
  const IOS_OPUS_OK_MIN_MAJOR = 18
  const ua = (v: number) =>
    `Mozilla/5.0 (iPhone; CPU iPhone OS ${v}_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.0 Mobile/15E148 Safari/604.1`
  assert.ok(iosMajorVersionForTest(ua(16)) < IOS_OPUS_OK_MIN_MAJOR)
  assert.ok(iosMajorVersionForTest(ua(18)) >= IOS_OPUS_OK_MIN_MAJOR)
  // The reporting device must read 'ok'.
  assert.ok(iosMajorVersionForTest(ua(26)) >= IOS_OPUS_OK_MIN_MAJOR)
})
