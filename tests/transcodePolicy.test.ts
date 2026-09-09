import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  transcodeParams,
  resolveTranscodeFormat,
  isLosslessTranscodeFormat,
  effectiveThumbSize,
  BUILTIN_TRANSCODE_FORMATS,
  type TranscodeInput,
} from '../src/lib/transcodePolicy'
import { lowDataSuppressesNavidromeScrobble } from '../src/lib/scrobbleManager'
import { planNavidromeLoad } from '../src/lib/navidromeLoadPlan'
import type { NavidromeConnectResult, NavidromeSong } from '../src/lib/navidromeApi'
import type { Track } from '../src/stores/appState'

// ── transcodeParams ─────────────────────────────────────────────────────────

const base = (over: Partial<TranscodeInput> = {}): TranscodeInput => ({
  mode: 'always',
  lowDataActive: false,
  hasConfig: true,
  ...over,
})

test('transcodeParams: null with no config (no URL to decorate)', () => {
  assert.equal(transcodeParams(base({ hasConfig: false }), 'opus', 128), null)
})

test('transcodeParams: null when mode off', () => {
  assert.equal(transcodeParams(base({ mode: 'off' }), 'opus', 128), null)
})

test('transcodeParams: null when mode lowData and LDM inactive', () => {
  assert.equal(transcodeParams(base({ mode: 'lowData', lowDataActive: false }), 'opus', 128), null)
})

test('transcodeParams: active when mode lowData and LDM engaged', () => {
  assert.deepEqual(transcodeParams(base({ mode: 'lowData', lowDataActive: true }), 'opus', 128), {
    format: 'opus',
    maxBitRate: 128,
  })
})

test('transcodeParams: active when mode always regardless of LDM', () => {
  assert.deepEqual(transcodeParams(base({ mode: 'always', lowDataActive: false }), 'mp3', 192), {
    format: 'mp3',
    maxBitRate: 192,
  })
})

test('transcodeParams: undefined mode behaves as off (default — no silent change)', () => {
  assert.equal(transcodeParams(base({ mode: undefined }), 'opus', 128), null)
})

test('transcodeParams: probe failure for the chosen format falls back to mp3', () => {
  assert.deepEqual(transcodeParams(base({ probeFailed: true }), 'opus', 128), {
    format: 'mp3',
    maxBitRate: 128,
  })
})

test('transcodeParams: probe failure for mp3 itself stays mp3 (no fallback loop)', () => {
  assert.deepEqual(transcodeParams(base({ probeFailed: true }), 'mp3', 128), {
    format: 'mp3',
    maxBitRate: 128,
  })
})

test('transcodeParams: undefined bitrate defaults to 128 (opus server default)', () => {
  assert.deepEqual(transcodeParams(base(), 'opus', undefined), { format: 'opus', maxBitRate: 128 })
})

// ── resolveTranscodeFormat ──────────────────────────────────────────────────

test('resolveTranscodeFormat: default is opus (Navidrome DefaultDownsamplingFormat parity)', () => {
  assert.equal(resolveTranscodeFormat(undefined, false), 'opus')
  // The Custom chip persists '' until the user types — empty is the default, never a bare `format=`.
  assert.equal(resolveTranscodeFormat('', false), 'opus')
})

test('resolveTranscodeFormat: custom server format passes through verbatim', () => {
  assert.equal(resolveTranscodeFormat('CustomDSP', false), 'customdsp')
})

test('resolveTranscodeFormat: no fallback without a FAILED probe', () => {
  assert.equal(resolveTranscodeFormat('opus', false), 'opus')
})

test('resolveTranscodeFormat: mp3 only on demonstrated failure', () => {
  assert.equal(resolveTranscodeFormat('aac', true), 'mp3')
  assert.equal(resolveTranscodeFormat('mp3', true), 'mp3')
})

// ── formats & thumbnails ────────────────────────────────────────────────────

test('BUILTIN_TRANSCODE_FORMATS matches Navidrome built-in transcodings', () => {
  assert.deepEqual([...BUILTIN_TRANSCODE_FORMATS], ['opus', 'mp3', 'aac', 'flac'])
})

test('isLosslessTranscodeFormat: flac/wav/alac yes, opus/mp3/aac no', () => {
  assert.equal(isLosslessTranscodeFormat('flac'), true)
  assert.equal(isLosslessTranscodeFormat('wav'), true)
  assert.equal(isLosslessTranscodeFormat('alac'), true)
  assert.equal(isLosslessTranscodeFormat('opus'), false)
  assert.equal(isLosslessTranscodeFormat('mp3'), false)
  assert.equal(isLosslessTranscodeFormat('aac'), false)
})

test('effectiveThumbSize: steps down one canonical level under LDM', () => {
  assert.equal(effectiveThumbSize({ size: 512, lowDataActive: true }), 256)
  assert.equal(effectiveThumbSize({ size: 256, lowDataActive: true }), 128)
  assert.equal(effectiveThumbSize({ size: 128, lowDataActive: true }), 96)
  assert.equal(effectiveThumbSize({ size: 96, lowDataActive: true }), 96)
})

test('effectiveThumbSize: unchanged when LDM is off', () => {
  assert.equal(effectiveThumbSize({ size: 512, lowDataActive: false }), 512)
  assert.equal(effectiveThumbSize({ size: 128, lowDataActive: false }), 128)
})

// ── Navidrome scrobble LDM gate ─────────────────────────────────────────────

test('lowDataSuppressesNavidromeScrobble mirrors the flag', () => {
  assert.equal(lowDataSuppressesNavidromeScrobble(true), true)
  assert.equal(lowDataSuppressesNavidromeScrobble(false), false)
})

// ── planNavidromeLoad lowData (the auto-scan suppression) ───────────────────

const song = (id: string): NavidromeSong => ({ id, title: `T${id}`, artist: 'A', album: 'B', duration: 100 })
const mapSong = (s: NavidromeSong): Track => ({
  trackId: `navidrome-${s.id}`,
  title: s.title,
  artist: s.artist,
  album: s.album,
  duration: s.duration,
  fileType: 'mp3',
})

const loadResult = (): NavidromeConnectResult => ({
  connection: { connected: true },
  songs: [song('1'), song('2')],
  loadResult: { loaded: 2, failed: 0 },
})

test('planNavidromeLoad: lowData suppresses the automatic scan like offline', () => {
  const plan = planNavidromeLoad(loadResult(), {
    mapSong,
    webdavConfigured: true,
    online: true,
    lowData: true,
  })
  assert.equal(plan.configureWebdav, true)
  assert.equal(plan.scanWebdav, false)
})

test('planNavidromeLoad: without lowData the online scan still fires', () => {
  const plan = planNavidromeLoad(loadResult(), {
    mapSong,
    webdavConfigured: true,
    online: true,
  })
  assert.equal(plan.scanWebdav, true)
})

test('planNavidromeLoad: lowData never suppresses the library load itself', () => {
  const plan = planNavidromeLoad(loadResult(), {
    mapSong,
    webdavConfigured: false,
    online: true,
    lowData: true,
  })
  assert.equal(plan.applyLibrary, true)
  assert.equal(plan.tracks.length, 2)
})
