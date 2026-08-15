// TODO 3.6t — permanent suites for the pure matching/scoring core
// (`src/lib/metadataCore.ts`): the auto-bind evidence gate, ambiguity ties,
// the tag-led-uncertain rule, size-only-never-binds, CJK normalization in the
// scoring path (0.3), the index fingerprint (FNV change-gating), the mtime
// diff, and `verifyEntryAgainstTrack`. These are the decision rules the
// scanner and the File Matching UI share — DOM/Dexie-free by construction, so
// the suite imports the core module directly (no taglib, no DOMParser).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchTrackToWebdav,
  matchTrackToWebdavCandidates,
  verifyEntryAgainstTrack,
  computeIndexFingerprint,
  findChangedTracks,
  mtimeChanged,
} from '../src/lib/metadataCore'
import type { Track } from '../src/stores/appState'
import type { LocalMetadataStore, WebdavFileEntry } from '../src/lib/db'

const STAMP = 'Mon, 01 Jan 2024 00:00:00 GMT'

function track(over: Partial<Track> = {}): Track {
  return {
    trackId: 't1',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    duration: 200,
    fileType: 'flac',
    size: 12345,
    trackNumber: 1,
    ...over,
  }
}

function entry(over: Partial<WebdavFileEntry> = {}): WebdavFileEntry {
  return {
    path: '/dav/files/user/Song.flac',
    filename: 'Song.flac',
    size: 12345,
    lastModified: STAMP,
    tags: { title: 'Song', artist: 'Artist', album: 'Album', trackNumber: 1 },
    ...over,
  }
}

function metaRow(over: Partial<LocalMetadataStore> = {}): LocalMetadataStore {
  return {
    trackId: 't1',
    rating: 0,
    loved: false,
    fileType: 'flac',
    syncStatus: 'synced',
    lastModifiedLocally: 0,
    ...over,
  }
}

// ── Auto-bind evidence gate (D8) ─────────────────────────────────────────

test('an exact filename match auto-binds', () => {
  const match = matchTrackToWebdav(track(), [entry()])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, '/dav/files/user/Song.flac')
})

test('a size-only lead (nameScore 40) NEVER auto-binds — gate requires real evidence', () => {
  const sizeOnly = entry({
    path: '/dav/other/SomethingElse.flac',
    filename: 'SomethingElse.flac',
    size: 12345,
    tags: undefined,
  })
  const match = matchTrackToWebdav(track({ title: 'Song', size: 12345 }), [sizeOnly])
  assert.deepEqual(match, { entry: null, ambiguous: false })
})

test('the size-only file still surfaces as a near-miss suggestion in the picker', () => {
  const sizeOnly = entry({
    path: '/dav/other/SomethingElse.flac',
    filename: 'SomethingElse.flac',
    size: 12345,
    tags: undefined,
  })
  const cand = matchTrackToWebdavCandidates(track({ title: 'Song', size: 12345 }), [sizeOnly])
  assert.equal(cand.status, 'none')
  assert.deepEqual(cand.promptCandidates.map((e) => e.path), ['/dav/other/SomethingElse.flac'])
})

test('a size-only TIE counts no-match in BOTH views (count-line parity)', () => {
  const s1 = entry({ path: '/dav/a/X.flac', filename: 'X.flac', size: 12345, tags: undefined })
  const s2 = entry({ path: '/dav/b/Y.flac', filename: 'Y.flac', size: 12345, tags: undefined })
  const match = matchTrackToWebdav(track({ title: 'Song', size: 12345 }), [s1, s2])
  assert.deepEqual(match, { entry: null, ambiguous: false })
  const cand = matchTrackToWebdavCandidates(track({ title: 'Song', size: 12345 }), [s1, s2])
  assert.equal(cand.status, 'none', 'never ambiguous — the scanner and the count line agree')
})

test('a same-size file whose PROBED tags contradict the track gets no size fallback', () => {
  const contradicting = entry({
    path: '/dav/x/Wrong.flac',
    filename: 'Wrong.flac',
    size: 12345,
    tags: { title: 'Wrong', artist: 'Other' },
  })
  const match = matchTrackToWebdav(track({ title: 'Song', size: 12345 }), [contradicting])
  assert.deepEqual(match, { entry: null, ambiguous: false })
})

// ── Ambiguity ties ───────────────────────────────────────────────────────

test('two files with the same top score are ambiguous — never guess (duplicate "01 - Intro")', () => {
  const a = entry({ path: '/dav/A/01 - Intro.flac', filename: '01 - Intro.flac', tags: undefined })
  const b = entry({ path: '/dav/B/01 - Intro.flac', filename: '01 - Intro.flac', tags: undefined })
  const match = matchTrackToWebdav(track({ title: 'Intro' }), [a, b])
  assert.deepEqual(match, { entry: null, ambiguous: true })
  const cand = matchTrackToWebdavCandidates(track({ title: 'Intro' }), [a, b])
  assert.equal(cand.status, 'ambiguous')
  assert.deepEqual(cand.promptCandidates.map((e) => e.path), ['/dav/A/01 - Intro.flac', '/dav/B/01 - Intro.flac'])
})

// ── Tag-led-uncertain rule ───────────────────────────────────────────────

test('a tag verdict without title+artist certainty is ambiguous in BOTH views', () => {
  const weird = entry({
    path: '/dav/x/Unknown.flac',
    filename: 'Unknown.flac',
    size: 1,
    tags: { title: 'Song', artist: 'WRONG', album: 'Album', trackNumber: 1 },
  })
  const match = matchTrackToWebdav(track(), [weird])
  assert.deepEqual(match, { entry: null, ambiguous: true })
  const cand = matchTrackToWebdavCandidates(track(), [weird])
  assert.equal(cand.status, 'ambiguous')
  assert.deepEqual(cand.promptCandidates.map((e) => e.path), ['/dav/x/Unknown.flac'])
})

test('a certain tag match (exact title AND artist) auto-binds even with a weak filename', () => {
  const tagged = entry({
    path: '/dav/x/song.flac',
    filename: 'not-matching-name.flac',
    size: 1,
    tags: { title: 'Song', artist: 'Artist', album: 'Album', trackNumber: 1 },
  })
  const match = matchTrackToWebdav(track(), [tagged])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, tagged.path)
})

// ── CJK normalization in the scoring path (0.3) ─────────────────────────

test('CJK titles match CJK filenames (normalizeForMatch is script-safe)', () => {
  const cjk = entry({ path: '/dav/jp/バビロン.flac', filename: 'バビロン.flac', tags: undefined })
  const match = matchTrackToWebdav(track({ title: 'バビロン', artist: '中島みゆき' }), [cjk])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, cjk.path)
})

test('CJK titles never near-match an unrelated ASCII filename', () => {
  const ascii = entry({ path: '/dav/x/Something.flac', filename: 'Something.flac', tags: undefined })
  const match = matchTrackToWebdav(track({ title: 'バビロン' }), [ascii])
  assert.deepEqual(match, { entry: null, ambiguous: false })
})

// ── Scoring detail: substring names and excluded paths ───────────────────

test('a filename containing the title still auto-binds (substring score > 40)', () => {
  const live = entry({ path: '/dav/l/Song Live.flac', filename: 'Song Live.flac', size: 1, tags: undefined })
  const match = matchTrackToWebdav(track(), [live])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, live.path)
})

test('excludePaths removes already-bound files from scoring', () => {
  const claimed = entry({ path: '/dav/claimed/Song.flac' })
  const match = matchTrackToWebdav(track(), [claimed], new Set([claimed.path]))
  assert.deepEqual(match, { entry: null, ambiguous: false })
})

// ── Fingerprint (FNV change-gating) ──────────────────────────────────────

test('fingerprint is order-stable and path+size-keyed; mtime is deliberately blind', () => {
  const a = entry({ path: '/dav/a.flac', size: 1, tags: undefined })
  const b = entry({ path: '/dav/b.flac', size: 2, tags: undefined })
  assert.equal(computeIndexFingerprint([a, b]), computeIndexFingerprint([b, a]))
  // An mtime-only change must NOT change the fingerprint (matched rows
  // re-diff on their own mtime; a tag edit can't create a new match).
  assert.equal(
    computeIndexFingerprint([a]),
    computeIndexFingerprint([{ ...a, lastModified: 'Tue, 02 Jan 2024 00:00:00 GMT' }]),
  )
  // Add / rename / resize all change it.
  assert.notEqual(computeIndexFingerprint([a]), computeIndexFingerprint([a, b]))
  assert.notEqual(computeIndexFingerprint([a]), computeIndexFingerprint([{ ...a, path: '/dav/renamed.flac' }]))
  assert.notEqual(computeIndexFingerprint([a]), computeIndexFingerprint([{ ...a, size: 3 }]))
})

// ── mtime diff ───────────────────────────────────────────────────────────

test('mtimeChanged: raw-string diff today (3.7b will normalize both sides to epoch)', () => {
  assert.equal(mtimeChanged(STAMP, STAMP), false, 'same stamp → unchanged')
  assert.equal(mtimeChanged(STAMP, 'Tue, 02 Jan 2024 00:00:00 GMT'), true, 'different stamp → changed')
  assert.equal(mtimeChanged(STAMP, undefined), true, 'server omitting getlastmodified → changed (re-read)')
  assert.equal(mtimeChanged(undefined, undefined), false)
  assert.equal(mtimeChanged(undefined, STAMP), true)
})

test('findChangedTracks splits changed vs unmatched rows', () => {
  const meta = new Map<string, LocalMetadataStore>([
    ['t1', metaRow({ trackId: 't1', webdavPath: '/dav/Song.flac', webdavLastModified: STAMP })],
    ['t2', metaRow({ trackId: 't2', webdavPath: '/dav/Old.flac', webdavLastModified: STAMP })],
    ['t3', metaRow({ trackId: 't3' })],
  ])
  const timestamps = new Map([
    ['/dav/Song.flac', STAMP],
    ['/dav/Old.flac', 'Tue, 02 Jan 2024 00:00:00 GMT'],
  ])
  const { changed, unmatched } = findChangedTracks(
    [track({ trackId: 't1' }), track({ trackId: 't2' }), track({ trackId: 't3' })],
    meta,
    timestamps,
  )
  assert.deepEqual(changed.map((t) => t.trackId), ['t2'])
  assert.deepEqual(unmatched.map((t) => t.trackId), ['t3'])
})

// ── Re-verification verdict (D8) ─────────────────────────────────────────

test('verifyEntryAgainstTrack: verified / conflict / unknown matrix', () => {
  const t = track({ title: 'Song' })
  assert.equal(verifyEntryAgainstTrack(t, entry({ tags: { title: 'Song' } })), 'verified')
  assert.equal(verifyEntryAgainstTrack(t, entry({ tags: { title: 'Different' } })), 'conflict')
  assert.equal(verifyEntryAgainstTrack(t, entry({ tags: undefined })), 'unknown')
  assert.equal(verifyEntryAgainstTrack(t, entry({ tags: { title: '' } })), 'unknown')
  // Normalization applies on both sides: case/punctuation differences fold away.
  assert.equal(verifyEntryAgainstTrack(t, entry({ tags: { title: ' song! ' } })), 'verified')
})
