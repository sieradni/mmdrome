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
  computeTagCacheFingerprint,
  buildTrackTitleIndex,
  matchFileToTracks,
  canAutoBind,
  tagCacheEntryIsFresh,
  pruneTagCacheEntries,
  TAG_NETWORK_ERROR_TTL_MS,
  TAG_UNREADABLE_TTL_MS,
  PROBE_SWEEP_MIN_FILES,
  planProbeSweep,
  findChangedTracks,
  mtimeChanged,
  parseMtimeToEpoch,
  mergeFileComments,
  selectHealEvictions,
  bindingReleaseable,
  buildEffectiveTitleCounts,
  auditBoundFile,
  classifyFmRow,
  fmSeverity,
  type FmRowFacts,
} from '../src/lib/metadataCore'
import type { Track } from '../src/stores/appState'
import type { LocalMetadataStore, WebdavFileEntry, FileTagCacheEntry } from '../src/lib/db'

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

function tagEntry(over: Partial<FileTagCacheEntry> = {}): FileTagCacheEntry {
  return {
    id: 'base\u0000/path',
    baseKey: 'base',
    path: '/path',
    size: 12345,
    status: 'ok',
    probedAt: 1000,
    ...over,
  }
}

// ── Auto-bind evidence gate (D8) ─────────────────────────────────────────

test('an exact filename match auto-binds', () => {
  const match = matchTrackToWebdav(track(), [entry()])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, '/dav/files/user/Song.flac')
  assert.equal(match.reason, null, 'a bound row carries no no-match reason')
})

test('a size-only lead (nameScore 40) NEVER auto-binds — gate requires real evidence', () => {
  const sizeOnly = entry({
    path: '/dav/other/SomethingElse.flac',
    filename: 'SomethingElse.flac',
    size: 12345,
    tags: undefined,
  })
  const match = matchTrackToWebdav(track({ title: 'Song', size: 12345 }), [sizeOnly])
  assert.deepEqual(match, { entry: null, ambiguous: false, reason: 'not-probed' })
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
  assert.deepEqual(match, { entry: null, ambiguous: false, reason: 'not-probed' })
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
  assert.deepEqual(match, { entry: null, ambiguous: false, reason: 'tags-contradict' })
})

// ── Ambiguity ties ───────────────────────────────────────────────────────

test('two files with the same top score are ambiguous — never guess (duplicate "01 - Intro")', () => {
  const a = entry({ path: '/dav/A/01 - Intro.flac', filename: '01 - Intro.flac', tags: undefined })
  const b = entry({ path: '/dav/B/01 - Intro.flac', filename: '01 - Intro.flac', tags: undefined })
  const match = matchTrackToWebdav(track({ title: 'Intro' }), [a, b])
  assert.deepEqual(match, { entry: null, ambiguous: true, reason: 'ambiguous' })
  const cand = matchTrackToWebdavCandidates(track({ title: 'Intro' }), [a, b])
  assert.equal(cand.status, 'ambiguous')
  assert.deepEqual(cand.promptCandidates.map((e) => e.path), ['/dav/A/01 - Intro.flac', '/dav/B/01 - Intro.flac'])
})

// ── Tag-led-uncertain rule ───────────────────────────────────────────────

// 6.5a — a UNIQUE exact-title tag match auto-binds without artist certainty:
// the artist tag is only a tiebreaker across same-title files. (Re-pinned from
// the old `certain`-only rule, which required title+artist and flagged every
// artist-less exact-title match ambiguous.)
test('a unique exact-title tag match auto-binds without artist certainty (6.5a)', () => {
  const tagged = entry({
    path: '/dav/x/Unknown.flac',
    filename: 'Unknown.flac',
    size: 1,
    tags: { title: 'Song', artist: 'WRONG', album: 'Album', trackNumber: 1 },
  })
  const match = matchTrackToWebdav(track(), [tagged])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, tagged.path)
  const cand = matchTrackToWebdavCandidates(track(), [tagged])
  assert.equal(cand.status, 'matched')
  assert.deepEqual(cand.promptCandidates.map((e) => e.path), ['/dav/x/Unknown.flac'])
})

test('a shared exact title WITHOUT artist agreement is ambiguous — artist is the tiebreaker (6.5a)', () => {
  const a = entry({ path: '/dav/a/Song.flac', filename: 'a.flac', size: 1, tags: { title: 'Song' } })
  const b = entry({ path: '/dav/b/Song.flac', filename: 'b.flac', size: 1, tags: { title: 'Song', artist: 'Other' } })
  const match = matchTrackToWebdav(track({ artist: 'Artist' }), [a, b])
  assert.deepEqual(match, { entry: null, ambiguous: true, reason: 'ambiguous' })
  const cand = matchTrackToWebdavCandidates(track({ artist: 'Artist' }), [a, b])
  assert.equal(cand.status, 'ambiguous')
})

test('a same-title rival with a partial artist match never auto-binds the non-certain leader (6.5a)', () => {
  const a = entry({ path: '/dav/a/Song.flac', filename: 'a.flac', size: 1, tags: { title: 'Song' } })
  const b = entry({ path: '/dav/b/Song.flac', filename: 'b.flac', size: 1, tags: { title: 'Song', artist: 'B' } })
  const match = matchTrackToWebdav(track({ artist: 'Artist B' }), [a, b])
  assert.deepEqual(match, { entry: null, ambiguous: true, reason: 'ambiguous' })
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

// ── 6.4 — year/duration corroboration and duration demotion ─────────────

test('6.4: a duration mismatch beyond ±2s DEMOTES certainty (never binds)', () => {
  const version = entry({
    path: '/dav/x/Song.flac',
    filename: 'other.flac',
    size: 1,
    tags: { title: 'Song', artist: 'Artist', album: 'Album', trackNumber: 1, duration: 205 },
  })
  const match = matchTrackToWebdav(track({ duration: 200 }), [version])
  assert.deepEqual(match, { entry: null, ambiguous: true, reason: 'duration-conflict' })
  const cand = matchTrackToWebdavCandidates(track({ duration: 200 }), [version])
  assert.equal(cand.status, 'ambiguous')
})

test('6.4: ±2s is the inclusive boundary — 2s corroborates, 2.1s demotes', () => {
  const within = entry({ path: '/dav/a/Song.flac', filename: 'a.flac', size: 1, tags: { title: 'Song', artist: 'Artist', duration: 202 } })
  const justOver = entry({ path: '/dav/b/Song.flac', filename: 'b.flac', size: 1, tags: { title: 'Song', artist: 'Artist', duration: 202.1 } })
  // 2s still within tolerance → certain → binds.
  assert.equal(matchTrackToWebdav(track({ duration: 200 }), [within]).ambiguous, false)
  // 2.1s is a different version → demoted → ambiguous.
  assert.deepEqual(matchTrackToWebdav(track({ duration: 200 }), [justOver]), { entry: null, ambiguous: true, reason: 'duration-conflict' })
})

test('6.4: duration conflict is not bypassed by an exact filename when the tag is title-only', () => {
  const wrongVersion = entry({
    path: '/dav/x/Song.flac',
    filename: 'Song.flac',
    size: 1,
    tags: { title: 'Song', duration: 210 },
  })
  assert.deepEqual(
    matchTrackToWebdav(track({ duration: 200 }), [wrongVersion]),
    { entry: null, ambiguous: true, reason: 'duration-conflict' },
  )
})

test('6.4: a VBR off-by-one duration is within tolerance (no demotion)', () => {
  const vbr = entry({ path: '/dav/x/Song.flac', filename: 'x.flac', size: 1, tags: { title: 'Song', artist: 'Artist', duration: 199 } })
  const match = matchTrackToWebdav(track({ duration: 200 }), [vbr])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, vbr.path)
})

test('6.4: an absent/null duration on either side is no signal (no demotion, no penalty)', () => {
  const track200 = track({ duration: 200 })
  // File duration missing → no signal.
  const missing = entry({ path: '/dav/a/Song.flac', filename: 'a.flac', size: 1, tags: { title: 'Song', artist: 'Artist' } })
  assert.equal(matchTrackToWebdav(track200, [missing]).ambiguous, false)
  // File duration 0 (getAudioProperties() null → 0) → no signal.
  const zero = entry({ path: '/dav/b/Song.flac', filename: 'b.flac', size: 1, tags: { title: 'Song', artist: 'Artist', duration: 0 } })
  assert.equal(matchTrackToWebdav(track200, [zero]).ambiguous, false)
  // Track duration 0 (zero-duration Navidrome row) → no signal.
  assert.equal(matchTrackToWebdav(track({ duration: 0 }), [missing]).ambiguous, false)
})

test('6.4: duration corroboration breaks a title+artist tie (the agreeing file wins)', () => {
  const agreeing = entry({ path: '/dav/a/Song.flac', filename: 'a.flac', size: 1, tags: { title: 'Song', artist: 'Artist', duration: 200 } })
  const silent = entry({ path: '/dav/b/Song.flac', filename: 'b.flac', size: 1, tags: { title: 'Song', artist: 'Artist' } })
  const match = matchTrackToWebdav(track({ duration: 200 }), [agreeing, silent])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, agreeing.path)
})

test('6.4: year corroborates within ±1 (reissue) and NEVER demotes on a larger mismatch', () => {
  // Reissue year (off by one) is fine.
  const reissue = entry({ path: '/dav/a/Song.flac', filename: 'a.flac', size: 1, tags: { title: 'Song', artist: 'Artist', year: 2006 } })
  assert.equal(matchTrackToWebdav(track({ year: 2005 }), [reissue]).ambiguous, false)
  // A wildly different year still binds (year is corroboration only, unlike duration).
  const wrongYear = entry({ path: '/dav/b/Song.flac', filename: 'b.flac', size: 1, tags: { title: 'Song', artist: 'Artist', year: 1980 } })
  assert.equal(matchTrackToWebdav(track({ year: 2005 }), [wrongYear]).ambiguous, false)
})

// ── 6.5b — contradiction-blocks-filename ────────────────────────────────

test('6.5b: probed tags that contradict the track suppress the filename evidence too', () => {
  // The filename would otherwise be an EXACT match (nameScore 100 → bind),
  // but the in-file identity says a different song — the tags outrank the
  // name, so it must not auto-bind.
  const mislabeled = entry({
    path: '/dav/x/Song.flac',
    filename: 'Song.flac',
    size: 1,
    tags: { title: 'Completely Different', artist: 'Other' },
  })
  const match = matchTrackToWebdav(track({ title: 'Song', artist: 'Artist' }), [mislabeled])
  assert.deepEqual(match, { entry: null, ambiguous: false, reason: 'tags-contradict' })
})

test('6.5b: a file with NO identity tags is not a contradiction and still binds on filename', () => {
  const untagged = entry({ path: '/dav/x/Song.flac', filename: 'Song.flac', size: 1, tags: undefined })
  const match = matchTrackToWebdav(track(), [untagged])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, untagged.path)
})

test('6.5b: a whitespace-only title is no identity signal, not a contradiction', () => {
  const blank = entry({
    path: '/dav/x/Song.flac',
    filename: 'Song.flac',
    size: 1,
    tags: { title: '   ', artist: '   ' },
  })
  const match = matchTrackToWebdav(track(), [blank])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, blank.path)
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
  assert.deepEqual(match, { entry: null, ambiguous: false, reason: 'not-probed' })
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
  assert.deepEqual(match, { entry: null, ambiguous: false, reason: 'no-file-on-server' })
})

// ── No-match reasons (File Matching row labels) ──────────────────────────

test('reason: no file of the track\'s type exists on the server', () => {
  const mp3 = entry({ path: '/dav/only/Other.mp3', filename: 'Other.mp3', size: 1, tags: undefined })
  const cand = matchTrackToWebdavCandidates(track(), [mp3])
  assert.equal(cand.status, 'none')
  assert.equal(cand.reason, 'no-file-on-server')
})

test('reason: probed tags name a different song (6.5b suppression)', () => {
  const wrong = entry({ path: '/dav/x/Wrong.flac', filename: 'Song.flac', size: 12345, tags: { title: 'Unrelated Title' } })
  const cand = matchTrackToWebdavCandidates(track(), [wrong])
  assert.equal(cand.status, 'none')
  assert.equal(cand.reason, 'tags-contradict')
})

test('reason: a size/filename candidate exists but its tags were never read', () => {
  const unprobed = entry({ path: '/dav/x/Whatever.flac', filename: 'Whatever.flac', size: 12345, tags: undefined })
  const cand = matchTrackToWebdavCandidates(track(), [unprobed])
  assert.equal(cand.status, 'none')
  assert.equal(cand.reason, 'not-probed')
})

test('reason: the read was attempted and failed is NOT reported as not-probed (2026-08-21)', () => {
  // A failed probe must never tell the user to rescan — rescanning cannot
  // succeed where the read itself failed. The failure statuses are honest.
  const unreadable = entry({
    path: '/dav/x/Bad.flac',
    filename: 'Bad.flac',
    size: 12345,
    tags: undefined,
    probeStatus: 'unreadable',
  })
  const network = entry({
    path: '/dav/x/Flaky.flac',
    filename: 'Flaky.flac',
    size: 12345,
    tags: undefined,
    probeStatus: 'network-error',
  })
  assert.equal(matchTrackToWebdavCandidates(track(), [unreadable]).reason, 'read-failed')
  assert.equal(matchTrackToWebdavCandidates(track(), [network]).reason, 'read-failed')

  // A size-only scored lead (below the D8 gate) whose tag read failed gets
  // the same honesty — not "run Scan again".
  const sizeOnlyFailed = entry({ path: '/dav/x/Whatever.flac', filename: 'Whatever.flac', size: 12345, tags: undefined, probeStatus: 'unreadable' })
  assert.equal(matchTrackToWebdavCandidates(track(), [sizeOnlyFailed]).reason, 'read-failed')
})

test('reason: probed-but-empty candidates are no-identity-tags, not not-probed (2026-08-21)', () => {
  // THE field-report bug: every candidate was probed, all carried no identity
  // title, and the row still said "File tags not read yet — run Scan" forever.
  const probed = entry({
    path: '/dav/x/Whatever.flac',
    filename: 'Whatever.flac',
    size: 12345,
    tags: undefined,
    probeStatus: 'empty',
  })
  assert.equal(matchTrackToWebdavCandidates(track(), [probed]).reason, 'no-identity-tags')
})

test('reason: unprobed candidates outrank probed-empty ones in the no-score case', () => {
  // Mixed pool: one file still genuinely unread → there is still hope, so
  // "not probed" stays the truthful headline over "no identity tags".
  const unprobed = entry({ path: '/dav/x/A.flac', filename: 'A.flac', size: 12345, tags: undefined })
  const probedEmpty = entry({ path: '/dav/x/B.flac', filename: 'B.flac', size: 12345, tags: undefined, probeStatus: 'empty' })
  assert.equal(matchTrackToWebdavCandidates(track(), [probedEmpty]).reason, 'no-identity-tags')
  assert.equal(matchTrackToWebdavCandidates(track(), [unprobed, probedEmpty]).reason, 'not-probed')
})

test('reason: the file was probed but carries no identity title', () => {
  const empty = entry({ path: '/dav/x/Whatever.flac', filename: 'Whatever.flac', size: 12345, tags: { title: '' } })
  const cand = matchTrackToWebdavCandidates(track(), [empty])
  assert.equal(cand.status, 'none')
  assert.equal(cand.reason, 'no-identity-tags')
})

test('reason: a duration mismatch beyond ±2 s demotes to a labeled conflict', () => {
  const version = entry({
    path: '/dav/x/Song.flac',
    filename: 'other.flac',
    size: 1,
    tags: { title: 'Song', artist: 'Artist', album: 'Album', trackNumber: 1, duration: 205 },
  })
  const cand = matchTrackToWebdavCandidates(track({ duration: 200 }), [version])
  assert.equal(cand.status, 'ambiguous')
  assert.equal(cand.reason, 'duration-conflict')
})

test('reason: a tie leaves the verdict ambiguous with a labeled tie', () => {
  const a = entry({ path: '/dav/A/01 - Intro.flac', filename: '01 - Intro.flac', tags: undefined })
  const b = entry({ path: '/dav/B/01 - Intro.flac', filename: '01 - Intro.flac', tags: undefined })
  const cand = matchTrackToWebdavCandidates(track({ title: 'Intro' }), [a, b])
  assert.equal(cand.status, 'ambiguous')
  assert.equal(cand.reason, 'ambiguous')
})

test('reason: near-title tag evidence below the confidence gate is weak', () => {
  const longTitle = entry({
    path: '/dav/x/Other.flac',
    filename: 'Other.flac',
    size: 1,
    tags: { title: 'Song Is Actually A Considerably Longer Extended Title Here' },
  })
  const cand = matchTrackToWebdavCandidates(track(), [longTitle])
  assert.equal(cand.status, 'none')
  assert.equal(cand.reason, 'weak-evidence')
})

test('reason: a matched track reports null', () => {
  const cand = matchTrackToWebdavCandidates(track(), [entry()])
  assert.equal(cand.status, 'matched')
  assert.equal(cand.reason, null)
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

test('parseMtimeToEpoch: RFC1123 and ISO forms of the same instant normalize identically', () => {
  const RFC1123 = 'Mon, 01 Jan 2024 00:00:00 GMT'
  const ISO = '2024-01-01T00:00:00Z'
  assert.equal(parseMtimeToEpoch(RFC1123), parseMtimeToEpoch(ISO), 'same instant → same epoch')
  assert.equal(parseMtimeToEpoch(RFC1123), 1704067200000)
  assert.equal(parseMtimeToEpoch('2024-01-01T00:00:00+00:00'), 1704067200000)
  assert.equal(parseMtimeToEpoch(undefined), undefined)
  assert.equal(parseMtimeToEpoch('not-a-date'), undefined, 'unparseable → undefined (raw fallback)')
  assert.equal(parseMtimeToEpoch(''), undefined)
})

test('mtimeChanged compares EPOCHS, so format variance never mass-flags unchanged files (3.7b)', () => {
  // The same instant stamped in different formats by a post-switch server:
  // raw-string inequality would report changed and re-read every row.
  assert.equal(mtimeChanged('Mon, 01 Jan 2024 00:00:00 GMT', '2024-01-01T00:00:00Z'), false)
  assert.equal(mtimeChanged('2024-01-01T00:00:00Z', '2024-01-01T00:00:00+00:00'), false)
  // Legacy 2-digit-year RFC1123 (some servers) normalizes to the same epoch
  // as the 4-digit form — no mass-flag after a switch between the two.
  assert.equal(mtimeChanged('Mon, 01 Jan 24 00:00:00 GMT', '2024-01-01T00:00:00Z'), false)
  // Genuinely different instants are still changed, whatever the format mix.
  assert.equal(mtimeChanged('Mon, 01 Jan 2024 00:00:00 GMT', '2024-01-02T00:00:00Z'), true)
  assert.equal(mtimeChanged('2024-01-01T00:00:00Z', 'Mon, 02 Jan 2024 00:00:00 GMT'), true)
})

test('mtimeChanged: absent or unparseable sides fall back to the raw-string diff', () => {
  assert.equal(mtimeChanged(STAMP, STAMP), false, 'same stamp → unchanged')
  assert.equal(mtimeChanged(STAMP, undefined), true, 'server omitting getlastmodified → changed (re-read)')
  assert.equal(mtimeChanged(undefined, undefined), false)
  assert.equal(mtimeChanged(undefined, STAMP), true)
  assert.equal(mtimeChanged('garbage', 'garbage'), false, 'equal unparseable strings → unchanged (same raw value)')
  assert.equal(mtimeChanged('garbage', STAMP), true, 'one unparseable side → raw diff wins')
})

test('mergeFileComments: the file wins when it HAS a comment; absence keeps the cached value (3.7a)', () => {
  assert.equal(mergeFileComments('cached comment', 'file comment'), 'file comment', 'file authoritative')
  assert.equal(mergeFileComments('cached comment', undefined), 'cached comment', 'file LACKS the tag → keep cached')
  assert.equal(mergeFileComments(undefined, 'file comment'), 'file comment')
  assert.equal(mergeFileComments(undefined, undefined), undefined)
  // An empty file comment is mapped to undefined by extractMetadataFromBuffer,
  // so "file has a comment" is exactly `fileComments !== undefined`.
  assert.equal(mergeFileComments('cached comment', ''), 'cached comment')
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

  // An empty complete index still marks every existing binding changed, so
  // the scanner can clear paths for files deleted from the server.
  const vanished = findChangedTracks(
    [track({ trackId: 't1' })],
    new Map([['t1', metaRow({ trackId: 't1', webdavPath: '/dav/Song.flac', webdavLastModified: STAMP })]]),
    new Map(),
  )
  assert.deepEqual(vanished.changed.map((t) => t.trackId), ['t1'])
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

// ── Phase 6.1 — tag-cache fingerprint (the second evidence channel) ──────

test('probe sweep planner is automatic and confined to the 3:1 threshold (6.12)', () => {
  assert.equal(planProbeSweep(0, 0), 'sweep-all')
  assert.equal(planProbeSweep(10, 10), 'sweep-all')
  assert.equal(planProbeSweep(PROBE_SWEEP_MIN_FILES, 0), 'sweep-all')
  assert.equal(planProbeSweep(PROBE_SWEEP_MIN_FILES + 1, 0), 'hint-gated')
  // 3:1 ratio dominates above the 500-file floor
  assert.equal(planProbeSweep(1500, 500), 'sweep-all')
  assert.equal(planProbeSweep(1501, 500), 'hint-gated')
  assert.equal(planProbeSweep(600, 100), 'hint-gated')
})

test('tag cache freshness: success/empty are size-bound and failures use separate TTLs (6.6)', () => {
  const now = 10_000
  assert.equal(tagCacheEntryIsFresh(tagEntry({ status: 'ok', size: 4 }), 4, undefined, now), true)
  assert.equal(tagCacheEntryIsFresh(tagEntry({ status: 'empty', size: 4 }), 4, undefined, now), true)
  assert.equal(tagCacheEntryIsFresh(tagEntry({ status: 'ok', size: 4 }), 5, undefined, now), false)

  const network = tagEntry({ status: 'network-error', probedAt: now - TAG_NETWORK_ERROR_TTL_MS + 1 })
  assert.equal(tagCacheEntryIsFresh(network, network.size, undefined, now), true)
  assert.equal(tagCacheEntryIsFresh({ ...network, probedAt: now - TAG_NETWORK_ERROR_TTL_MS }, network.size, undefined, now), false)

  const unreadable = tagEntry({ status: 'unreadable', probedAt: now - TAG_UNREADABLE_TTL_MS + 1 })
  assert.equal(tagCacheEntryIsFresh(unreadable, unreadable.size, undefined, now), true)
  assert.equal(tagCacheEntryIsFresh({ ...unreadable, probedAt: now - TAG_UNREADABLE_TTL_MS }, unreadable.size, undefined, now), false)

  const stamped = tagEntry({ lastModified: STAMP })
  assert.equal(tagCacheEntryIsFresh(stamped, stamped.size, STAMP, now), true)
  assert.equal(tagCacheEntryIsFresh(stamped, stamped.size, '2024-01-01T00:00:00Z', now), true)
  assert.equal(tagCacheEntryIsFresh(stamped, stamped.size, 'Tue, 02 Jan 2024 00:00:00 GMT', now), false)
  assert.equal(tagCacheEntryIsFresh(stamped, stamped.size, undefined, now), false)
})

test('computeTagCacheFingerprint is order-stable and flips on any probe-result change', () => {
  const a = tagEntry({ path: '/a' })
  const b = tagEntry({ path: '/b' })
  assert.equal(computeTagCacheFingerprint([a, b]), computeTagCacheFingerprint([b, a]))
  // probedAt is the change signal — a re-probe (new result) flips the hash.
  assert.notEqual(computeTagCacheFingerprint([a]), computeTagCacheFingerprint([{ ...a, probedAt: 2000 }]))
  // path, size, and status all flip it too.
  assert.notEqual(computeTagCacheFingerprint([a]), computeTagCacheFingerprint([{ ...a, path: '/renamed' }]))
  assert.notEqual(computeTagCacheFingerprint([a]), computeTagCacheFingerprint([{ ...a, size: 1 }]))
  assert.notEqual(computeTagCacheFingerprint([a]), computeTagCacheFingerprint([{ ...a, status: 'empty' }]))
  assert.notEqual(computeTagCacheFingerprint([a]), computeTagCacheFingerprint([{ ...a, lastModified: STAMP }]))
})

test('pruneTagCacheEntries removes vanished paths only after a complete index', () => {
  const old = tagEntry({ path: '/old' })
  const current = tagEntry({ path: '/current' })
  const active = new Set(['/current'])
  const pruned = pruneTagCacheEntries([old, current], active, true)
  assert.deepEqual(pruned.kept.map((entry) => entry.path), ['/current'])
  assert.deepEqual(pruned.removed.map((entry) => entry.path), ['/old'])

  const partial = pruneTagCacheEntries([old, current], active, false)
  assert.deepEqual(partial.kept.map((entry) => entry.path), ['/old', '/current'])
  assert.deepEqual(partial.removed, [])
})

// ── Phase 6.2 — reverse matching (file → track) for probe-time binding ───

test('matchFileToTracks: exact title+artist is certain', () => {
  const idx = buildTrackTitleIndex([track({ trackId: 't1', title: 'Song', artist: 'Artist' })])
  assert.deepEqual(
    matchFileToTracks(entry({ tags: { title: 'Song', artist: 'Artist' } }), idx),
    { verdict: 'certain', trackId: 't1' },
  )
})

test('matchFileToTracks: a unique exact title auto-binds without artist certainty (6.5a)', () => {
  const idx = buildTrackTitleIndex([track({ trackId: 't1', title: 'Song', artist: 'Artist' })])
  assert.deepEqual(
    matchFileToTracks(entry({ tags: { title: 'Song' } }), idx), // artist-less tag
    { verdict: 'unique-title', trackId: 't1' },
  )
})

test('matchFileToTracks: a unique title is demoted to ambiguous by a 6.4 duration conflict', () => {
  const idx = buildTrackTitleIndex([track({ trackId: 't1', title: 'Song', artist: 'Artist', duration: 200 })])
  assert.deepEqual(
    matchFileToTracks(entry({ filename: 'x.flac', tags: { title: 'Song', duration: 210 } }), idx),
    { verdict: 'ambiguous', trackId: null },
  )
  // Duration within ±2s (or absent) still auto-binds.
  assert.deepEqual(
    matchFileToTracks(entry({ filename: 'x.flac', tags: { title: 'Song', duration: 201 } }), idx),
    { verdict: 'unique-title', trackId: 't1' },
  )
})

test('matchFileToTracks: a title+artist certain match is demoted to ambiguous by a duration conflict', () => {
  const idx = buildTrackTitleIndex([track({ trackId: 't1', title: 'Song', artist: 'Artist', duration: 200 })])
  assert.deepEqual(
    matchFileToTracks(entry({ filename: 'x.flac', tags: { title: 'Song', artist: 'Artist', duration: 250 } }), idx),
    { verdict: 'ambiguous', trackId: null },
  )
})

test('matchFileToTracks: same title under two artists is ambiguous', () => {
  const idx = buildTrackTitleIndex([
    track({ trackId: 't1', title: 'Song', artist: 'ArtistA' }),
    track({ trackId: 't2', title: 'Song', artist: 'ArtistB' }),
  ])
  assert.deepEqual(
    matchFileToTracks(entry({ tags: { title: 'Song' } }), idx), // no artist to disambiguate
    { verdict: 'ambiguous', trackId: null },
  )
})

test('matchFileToTracks: two identical title+artist tracks are ambiguous (never guess)', () => {
  const idx = buildTrackTitleIndex([
    track({ trackId: 't1', title: 'Song', artist: 'Artist' }),
    track({ trackId: 't2', title: 'Song', artist: 'Artist' }),
  ])
  assert.deepEqual(
    matchFileToTracks(entry({ tags: { title: 'Song', artist: 'Artist' } }), idx),
    { verdict: 'ambiguous', trackId: null },
  )
})

test('matchFileToTracks: duplicate tracks with one already bound — binds the unbound one', () => {
  const idx = buildTrackTitleIndex([
    track({ trackId: 't1', title: 'Song', artist: 'Artist' }),
    track({ trackId: 't2', title: 'Song', artist: 'Artist' }),
  ])
  assert.deepEqual(
    matchFileToTracks(entry({ tags: { title: 'Song', artist: 'Artist' } }), idx, new Set(['t1'])),
    { verdict: 'certain', trackId: 't2' },
  )
})

test('matchFileToTracks: the file-type filter rejects mismatched extensions', () => {
  const idx = buildTrackTitleIndex([track({ trackId: 't1', title: 'Song', fileType: 'mp3' })])
  assert.deepEqual(
    matchFileToTracks(entry({ filename: 'Song.flac', tags: { title: 'Song', artist: 'Artist' } }), idx),
    { verdict: 'none', trackId: null },
  )
})

test('matchFileToTracks: missing tags or an empty title is none', () => {
  const idx = buildTrackTitleIndex([track({ trackId: 't1', title: 'Song' })])
  assert.deepEqual(matchFileToTracks(entry({ tags: undefined }), idx), { verdict: 'none', trackId: null })
  assert.deepEqual(matchFileToTracks(entry({ tags: { title: '' } }), idx), { verdict: 'none', trackId: null })
})

test('matchFileToTracks: CJK titles match their track', () => {
  const idx = buildTrackTitleIndex([track({ trackId: 't1', title: 'バビロン', artist: '中島みゆき' })])
  assert.deepEqual(
    matchFileToTracks(entry({ filename: 'something.flac', tags: { title: 'バビロン', artist: '中島みゆき' } }), idx),
    { verdict: 'certain', trackId: 't1' },
  )
})

test('matchFileToTracks: empty and Unknown Title tracks never become candidates', () => {
  const idx = buildTrackTitleIndex([
    track({ trackId: 't1', title: '' }),
    track({ trackId: 't2', title: 'Unknown Title' }),
  ])
  assert.deepEqual(
    matchFileToTracks(entry({ tags: { title: 'Unknown Title' } }), idx),
    { verdict: 'none', trackId: null },
  )
})

// ── Phase 6.3 — auto-bind eligibility (the shared guards) ────────────────

test('canAutoBind: only unbound, clean rows are bindable', () => {
  assert.deepEqual(canAutoBind(undefined, undefined), { bindable: false, reason: 'track-missing' })
  assert.deepEqual(canAutoBind(track(), undefined), { bindable: true })
  assert.deepEqual(
    canAutoBind(track(), metaRow({ webdavPath: '/dav/Song.flac' })),
    { bindable: false, reason: 'already-bound' },
  )
  assert.deepEqual(canAutoBind(track(), metaRow({ matchSource: 'manual' })), { bindable: false, reason: 'manual' })
  assert.deepEqual(
    canAutoBind(track(), metaRow({ syncStatus: 'pending_sync' })),
    { bindable: false, reason: 'pending-sync' },
  )
  assert.deepEqual(canAutoBind(track(), metaRow({ ignored: true })), { bindable: false, reason: 'ignored' })
})

// ── Heal pass: selectHealEvictions (2026-09-05) ────────────────────────────
// The force-scan heal releases AUTO links whose bound file's own (fresh)
// identity tags prove the link wrong. Decision rule: titles differ AND (some
// OTHER track carries the file's exact title OR the titles are not a
// same-release family). Exact titles, family variants ("Song (Live)" under
// "Song"), tag-less files, and punctuation-only titles are never released.

test('selectHealEvictions: a swapped pair is released — each file is provably the other track', () => {
  const a = track({ trackId: 't1', title: 'Song A', artist: 'ArtistA' })
  const b = track({ trackId: 't2', title: 'Song B', artist: 'ArtistB' })
  const all = [a, b]
  const candidates = [
    // Track A is bound to B's file (its tags name B), and vice versa.
    { track: a, entry: entry({ path: '/dav/B.flac', filename: 'B.flac', tags: { title: 'Song B', artist: 'ArtistB' } }) },
    { track: b, entry: entry({ path: '/dav/A.flac', filename: 'A.flac', tags: { title: 'Song A', artist: 'ArtistA' } }) },
  ]
  assert.deepEqual(selectHealEvictions(candidates, all).sort(), ['t1', 't2'])
})

test('selectHealEvictions: ownedElsewhere releases even a family-titled file', () => {
  // The file is tagged "Song (Live)" and a real track "Song (Live)" exists —
  // the file is provably THAT song, whatever the prefix relation to the owner.
  const owner = track({ trackId: 't1', title: 'Song' })
  const other = track({ trackId: 't2', title: 'Song (Live)' })
  const candidates = [{
    track: owner,
    entry: entry({ path: '/dav/Live.flac', filename: 'Live.flac', tags: { title: 'Song (Live)' } }),
  }]
  assert.deepEqual(selectHealEvictions(candidates, [owner, other]), ['t1'])
})

test('selectHealEvictions: a family title with no other owner is kept (live/feat trap, D8)', () => {
  // "Song (Live)" under owner "Song" with no track "Song (Live)" in the
  // library is plausibly the SAME file under a shorter catalog name — unlinking
  // would orphan a working push target. The family gate exists for this case.
  const owner = track({ trackId: 't1', title: 'Song' })
  const candidates = [{
    track: owner,
    entry: entry({ path: '/dav/Live.flac', filename: 'Live.flac', tags: { title: 'Song (Live)' } }),
  }]
  assert.deepEqual(selectHealEvictions(candidates, [owner]), [])
})

test('selectHealEvictions: a wholly different title with no other owner is released', () => {
  // The reverse family direction is NOT a family: "Rainbow" vs "Rain". A file
  // whose tags name something unrelated under an auto-bound row is a bad link.
  const owner = track({ trackId: 't1', title: 'Song' })
  const candidates = [{
    track: owner,
    entry: entry({ path: '/dav/Completely.flac', filename: 'Completely.flac', tags: { title: 'A Different Song Entirely' } }),
  }]
  assert.deepEqual(selectHealEvictions(candidates, [owner]), ['t1'])
})

test('selectHealEvictions: exact normalized titles never release (case/punct differences fold)', () => {
  const owner = track({ trackId: 't1', title: 'Song' })
  const candidates = [{
    track: owner,
    entry: entry({ path: '/dav/Live.flac', filename: 'Live.flac', tags: { title: ' song! ' } }),
  }]
  assert.deepEqual(selectHealEvictions(candidates, [owner]), [])
})

test('selectHealEvictions: tag-less and empty-title files are never judged, let alone released', () => {
  const owner = track({ trackId: 't1', title: 'Song' })
  const all = [owner, track({ trackId: 't2', title: 'Other Song' })]
  const candidates = [
    { track: owner, entry: entry({ path: '/dav/a.flac', filename: 'a.flac', tags: undefined }) },
    { track: owner, entry: entry({ path: '/dav/b.flac', filename: 'b.flac', tags: { title: '' } }) },
  ]
  // No file title → nothing to compare → no release.
  assert.deepEqual(selectHealEvictions(candidates, all), [])

  // A punctuation-only FILE title retains identity under effectiveTitle (D13):
  // it differs from "Song" and no track owns it, so it is a genuine conflict
  // and the row is released (the drain cannot re-match it either, so the row
  // surfaces in File Matching for a human verdict — never silent churn).
  const punct = [{
    track: owner,
    entry: entry({ path: '/dav/c.flac', filename: 'c.flac', tags: { title: '///' } }),
  }]
  assert.deepEqual(selectHealEvictions(punct, all), ['t1'])
})

test('selectHealEvictions: an empty owner title is skipped; punctuation-only owners keep identity', () => {
  // effectiveTitle (D13) gives '///' identity, so a file tagged with a real
  // different title under it is a genuine conflict — consistent with
  // verifyEntryAgainstTrack. A truly empty owner title has no identity to
  // compare, so it is skipped.
  const punct = track({ trackId: 't1', title: '///' })
  const empty = track({ trackId: 't2', title: '' })
  const candidates = [
    { track: punct, entry: entry({ path: '/dav/a.flac', filename: 'a.flac', tags: { title: 'Something' } }) },
    { track: empty, entry: entry({ path: '/dav/b.flac', filename: 'b.flac', tags: { title: 'Something' } }) },
  ]
  assert.deepEqual(selectHealEvictions(candidates, [punct, empty]), ['t1'])
})

test('selectHealEvictions: duplicate library titles do not release an exact-owner match', () => {
  // Both "Song" tracks exist; the file tags say "Song" — it cannot be told
  // apart from the owner, so it stays (uniqueness is not required for the
  // ownedElsewhere proof, and here there IS no proof).
  const a = track({ trackId: 't1', title: 'Song', artist: 'ArtistA' })
  const b = track({ trackId: 't2', title: 'Song', artist: 'ArtistB' })
  const candidates = [{
    track: a,
    entry: entry({ path: '/dav/Song.flac', filename: 'Song.flac', tags: { title: 'Song', artist: 'ArtistB' } }),
  }]
  assert.deepEqual(selectHealEvictions(candidates, [a, b]), [])
})

// ── Identity-dominance floor (2026-09-05) ──────────────────────────────────
// The file tags and the Navidrome catalog are parsed from the SAME files, so
// an exact-title tag match (no duration conflict) IS the song and must outrank
// the strongest filename-only evidence a competitor can reach (exact-name 100
// + equal-size bonus 10 = 110). Without the floor, an untagged same-name
// same-size duplicate was re-linked over the correctly-tagged file.

test('exact-title tag evidence outranks an untagged filename-exact equal-size twin', () => {
  const tagged = entry({ path: '/dav/Album/Song.flac', filename: 'Song.flac', tags: { title: 'Song' } })
  const twin = entry({ path: '/dav/Other/Song.flac', filename: 'Song.flac', tags: undefined })
  const match = matchTrackToWebdav(track(), [twin, tagged])
  assert.equal(match.ambiguous, false)
  assert.equal(match.entry?.path, tagged.path)
})

test('two exact-title tag candidates still tie (identity floor never picks blindly)', () => {
  const a = entry({ path: '/dav/A/Song.flac', filename: 'Song.flac', tags: { title: 'Song' } })
  const b = entry({ path: '/dav/B/Song.flac', filename: 'Song.flac', tags: { title: 'Song' } })
  const match = matchTrackToWebdav(track(), [a, b])
  assert.equal(match.entry, null)
  assert.equal(match.ambiguous, true)
})

// ── Link auditor: auditBoundFile (2026-09-05) ──────────────────────────────
// The File Matching auditor judges an EXISTING binding from the bound file's
// own (fresh, cached) identity tags. Pure — callers stamp the entry from the
// probe cache, so auditing thousands of links costs zero network reads. It
// never auto-clears anything; it classifies for the human (and the verdict
// vocabulary is the same one verifyEntryAgainstTrack already returns).

test('auditBoundFile: exact normalized titles verify (case/punct fold away)', () => {
  const audit = auditBoundFile(
    track(),
    entry({ tags: { title: ' song! ', artist: 'Artist' } }),
  )
  assert.equal(audit.verdict, 'verified')
  assert.equal(audit.readState, 'tagged')
  assert.equal(audit.fileTitle, ' song! ', 'raw file title is preserved for display')
})

test('auditBoundFile: a differing title is a conflict and reports the file title', () => {
  const audit = auditBoundFile(
    track(),
    entry({ tags: { title: 'Completely Different' } }),
  )
  assert.equal(audit.verdict, 'conflict')
  assert.equal(audit.fileTitle, 'Completely Different')
  assert.equal(audit.readState, 'tagged')
})

test('auditBoundFile: never-probed files are unknown + not-probed (not a fake verdict)', () => {
  const audit = auditBoundFile(track(), entry({ tags: undefined }))
  assert.deepEqual(audit, { verdict: 'unknown', readState: 'not-probed' })
})

test('auditBoundFile: read failures are reported honestly, never as "rescan me"', () => {
  const unreadable = auditBoundFile(
    track(),
    entry({ tags: undefined, probeStatus: 'unreadable' }),
  )
  assert.equal(unreadable.verdict, 'unknown')
  assert.equal(unreadable.readState, 'unreadable')
  const network = auditBoundFile(
    track(),
    entry({ tags: undefined, probeStatus: 'network-error' }),
  )
  assert.equal(network.verdict, 'unknown')
  assert.equal(network.readState, 'network-error')
})

test('auditBoundFile: a probed file without a title is empty (artist-only tags included)', () => {
  // probeStatus 'ok' means SOME identity was read (e.g. artist-only) — the
  // title is still missing, so the audit cannot compare and says so.
  const probedOk = auditBoundFile(
    track(),
    entry({ tags: { artist: 'Artist' }, probeStatus: 'ok' }),
  )
  assert.equal(probedOk.verdict, 'unknown')
  assert.equal(probedOk.readState, 'empty')
  const probedEmpty = auditBoundFile(
    track(),
    entry({ tags: { title: '' }, probeStatus: 'empty' }),
  )
  assert.equal(probedEmpty.verdict, 'unknown')
  assert.equal(probedEmpty.readState, 'empty')
})

test('auditBoundFile: a title-less track cannot be confirmed even when the file has a title', () => {
  const audit = auditBoundFile(
    track({ title: '' }),
    entry({ tags: { title: 'Something' } }),
  )
  assert.equal(audit.verdict, 'unknown')
  assert.equal(audit.readState, 'tagged')
})

// ── Heal/auditor shared predicate: bindingReleaseable (2026-09-05) ────────
// The per-row release predicate behind selectHealEvictions, ALSO used by the
// File Matching auditor's `fixable` flag — one source of truth so the view's
// "rescan will fix this" promise matches what a rescan actually releases.
// Raw titles in, effective-title counts map as evidence; normalization happens
// here so consumers cannot drift.

test('bindingReleaseable: agrees with selectHealEvictions on the release/keep matrix', () => {
  const counts = buildEffectiveTitleCounts([
    track({ trackId: 't1', title: 'Song' }),
    track({ trackId: 't2', title: 'Song B' }),
  ])
  // Provable swap: file tags name a track that exists elsewhere.
  assert.equal(bindingReleaseable('Song', 'Song B', counts), true)
  // Family variant, no other owner: kept.
  const solo = buildEffectiveTitleCounts([track({ trackId: 't1', title: 'Song' })])
  assert.equal(bindingReleaseable('Song', 'Song (Live)', solo), false)
  // Wholly different title, no other owner: released.
  assert.equal(bindingReleaseable('Song', 'A Different Song Entirely', solo), true)
  // Exact (folded) titles never release.
  assert.equal(bindingReleaseable('Song', ' song! ', solo), false)
  // Empty either side never releases.
  assert.equal(bindingReleaseable('Song', '', solo), false)
  assert.equal(bindingReleaseable('', 'Song', solo), false)
})

test('bindingReleaseable: ownedElsewhere releases even a family-titled file', () => {
  const counts = buildEffectiveTitleCounts([
    track({ trackId: 't1', title: 'Song' }),
    track({ trackId: 't2', title: 'Song (Live)' }),
  ])
  assert.equal(bindingReleaseable('Song', 'Song (Live)', counts), true)
})

test('bindingReleaseable: duplicate owners of the file title never self-release an exact match', () => {
  // Both "Song" tracks exist; the file says "Song" — no proof of a wrong link.
  const counts = buildEffectiveTitleCounts([
    track({ trackId: 't1', title: 'Song' }),
    track({ trackId: 't2', title: 'Song' }),
  ])
  assert.equal(bindingReleaseable('Song', 'Song', counts), false)
  // ...but a DIFFERENT owned title is still proof even with duplicates around.
  const withOther = buildEffectiveTitleCounts([
    track({ trackId: 't1', title: 'Song' }),
    track({ trackId: 't2', title: 'Song' }),
    track({ trackId: 't3', title: 'Other' }),
  ])
  assert.equal(bindingReleaseable('Song', 'Other', withOther), true)
})

test('bindingReleaseable: normalization matches the heal counts (case/punct fold on both sides)', () => {
  // buildEffectiveTitleCounts keys by the SAME effectiveTitle, so a raw file
  // title that folds to a library title proves ownership.
  const counts = buildEffectiveTitleCounts([track({ trackId: 't1', title: 'song' })])
  assert.equal(bindingReleaseable('Song B', ' SONG! ', counts), true)
})

// ── File Matching buckets + severity (2026-09-09) ──────────────────────────
// The attention hierarchy behind the File Matching filters. A manual pick is
// the user's verdict: it resolves the row (bucket `confirmed`) whatever the
// tags say, while the audit evidence itself stays untouched (D17 honesty —
// confirmation never fabricates a tag `verified`).

function fmRow(over: Partial<FmRowFacts> = {}): FmRowFacts {
  return { kind: 'no-match', pendingPush: false, ...over }
}

test('classifyFmRow: unlinked and auto-audit rows need action', () => {
  assert.equal(classifyFmRow(fmRow({ kind: 'no-match' })), 'action')
  assert.equal(classifyFmRow(fmRow({ kind: 'ambiguous' })), 'action')
  assert.equal(classifyFmRow(fmRow({ kind: 'vanished' })), 'action')
  assert.equal(classifyFmRow(fmRow({ kind: 'stale-base' })), 'action')
  assert.equal(classifyFmRow(fmRow({ kind: 'matched', matchSource: 'auto', verdict: 'conflict', readState: 'tagged' })), 'action')
  assert.equal(classifyFmRow(fmRow({ kind: 'matched', matchSource: 'auto', verdict: 'unknown', readState: 'empty' })), 'action')
  assert.equal(classifyFmRow(fmRow({ kind: 'matched', matchSource: 'auto', verdict: 'unknown', readState: 'not-probed' })), 'action')
})

test('classifyFmRow: a manual pick resolves the row whatever the tags say', () => {
  // The title-less case from the 2026-09-09 report: tags can never verify,
  // so the user's same-file Confirm must move the row out of Needs action.
  assert.equal(classifyFmRow(fmRow({ kind: 'matched', matchSource: 'manual', verdict: 'unknown', readState: 'empty' })), 'confirmed')
  assert.equal(classifyFmRow(fmRow({ kind: 'matched', matchSource: 'manual', verdict: 'unknown', readState: 'not-probed' })), 'confirmed')
  assert.equal(classifyFmRow(fmRow({ kind: 'matched', matchSource: 'manual', verdict: 'conflict', readState: 'tagged' })), 'confirmed')
  assert.equal(classifyFmRow(fmRow({ kind: 'matched', matchSource: 'manual', verdict: 'verified', readState: 'tagged' })), 'confirmed')
})

test('classifyFmRow: verified auto links and ignored rows are the low-priority bulk', () => {
  assert.equal(classifyFmRow(fmRow({ kind: 'matched', matchSource: 'auto', verdict: 'verified', readState: 'tagged' })), 'verified')
  // Absent matchSource stamps (legacy auto rows) behave as auto.
  assert.equal(classifyFmRow(fmRow({ kind: 'matched', verdict: 'verified', readState: 'tagged' })), 'verified')
  assert.equal(classifyFmRow(fmRow({ kind: 'matched', verdict: 'unknown', readState: 'empty' })), 'action')
  assert.equal(classifyFmRow(fmRow({ kind: 'ignored' })), 'ignored')
})

test('fmSeverity: errors first, picks next, confirmations after, resolved last', () => {
  const sev = (r: Partial<FmRowFacts>) => fmSeverity(fmRow(r))
  const vanished = sev({ kind: 'vanished' })
  const stale = sev({ kind: 'stale-base' })
  const conflict = sev({ kind: 'matched', matchSource: 'auto', verdict: 'conflict', readState: 'tagged' })
  const readFailed = sev({ kind: 'no-match', reason: 'read-failed' })
  const failedRead = sev({ kind: 'matched', matchSource: 'auto', verdict: 'unknown', readState: 'network-error' })
  const ambiguous = sev({ kind: 'ambiguous' })
  const noMatch = sev({ kind: 'no-match', reason: 'no-identity-tags' })
  const notProbed = sev({ kind: 'matched', matchSource: 'auto', verdict: 'unknown', readState: 'not-probed' })
  const empty = sev({ kind: 'matched', matchSource: 'auto', verdict: 'unknown', readState: 'empty' })
  const confirmed = sev({ kind: 'matched', matchSource: 'manual', verdict: 'unknown', readState: 'empty' })
  const verified = sev({ kind: 'matched', matchSource: 'auto', verdict: 'verified', readState: 'tagged' })
  const ignored = sev({ kind: 'ignored' })
  assert.ok(vanished < stale, 'dead link before stale link')
  assert.ok(stale < conflict && stale < readFailed, 'dead links before evidence errors')
  assert.ok(conflict < ambiguous && readFailed < ambiguous && failedRead < ambiguous, 'errors before picks')
  assert.ok(ambiguous < noMatch, 'ambiguous before plain no-match')
  assert.ok(noMatch < notProbed && noMatch < empty, 'missing links before audit confirmations')
  assert.ok(empty > notProbed, 'never-read before title-less (a read may still verify)')
  assert.ok(confirmed > empty, 'user-confirmed after every action row')
  assert.ok(verified > confirmed, 'tag-verified bulk after confirmed')
  assert.ok(ignored > verified, 'ignored last')
})
