// Pins the pure lyrics core (2026-09-14 lyrics feature): LRC parsing rules,
// structured-lyrics normalization, end-time derivation + break markers, the
// active-line binary search, and variant picking.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLrc,
  normalizeStructuredLyrics,
  lyricsFromPlainText,
  pickLyricsVariant,
  deriveLineEnds,
  activeLineIndex,
  isBreakMarker,
  type RawStructuredLyrics,
} from '../src/lib/lyricsCore'

test('parseLrc: basic timestamps, centiseconds', () => {
  const lines = parseLrc('[00:01.50]Hello\n[01:02.30]World')
  assert.deepEqual(
    lines.map((l) => l.startMs),
    [1500, 62_300],
  )
  assert.equal(lines[0].text, 'Hello')
})

test('parseLrc: multiple timestamps on one line expand to repeated lines', () => {
  const lines = parseLrc('[00:10.00][01:30.50]Chorus')
  assert.equal(lines.length, 2)
  assert.equal(lines[0].startMs, 10_000)
  assert.equal(lines[1].startMs, 90_500)
  assert.equal(lines[1].text, 'Chorus')
})

test('parseLrc: positive [offset:+] shifts lyrics EARLIER (stamped − offset)', () => {
  const lines = parseLrc('[offset:+1000]\n[00:05.00]Early')
  assert.equal(lines[0].startMs, 4000)
})

test('parseLrc: negative offset shifts later', () => {
  const lines = parseLrc('[offset:-500]\n[00:05.00]Late')
  assert.equal(lines[0].startMs, 5500)
})

test('parseLrc: metadata tags are skipped; unknown tags tolerated', () => {
  const lines = parseLrc('[ti:Song]\n[ar:Artist]\n[re:SomeTool]\n[zz:unknown]\n[00:01.00]Text')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].text, 'Text')
  // Letter-led keys are tags; digit-led brackets are timestamps — the
  // distinction is what keeps `[00:01.50]` out of the metadata rule.
})

test('parseLrc: empty stamped line becomes a break marker', () => {
  const lines = parseLrc('[00:01.00]A\n[00:09.00]\n[00:12.00]B')
  assert.equal(lines.length, 3)
  assert.ok(isBreakMarker(lines[1]))
  assert.equal(lines[1].text, '♪')
})

test('parseLrc: malformed lines never throw; untimed content is preserved', () => {
  // `[garbage` is not a tag (no colon) and not a timestamp — the line falls
  // through as UNTIMED content, which the parser deliberately keeps (some
  // payload generators emit untimed lines inside otherwise-synced docs; the
  // active-line search ignores them).
  const lines = parseLrc('not lrc at all\n[garbage\n[00:abc]broken\n[00:04.00]Fine')
  const timed = lines.filter((l) => l.startMs !== null)
  assert.equal(timed.length, 1)
  assert.equal(timed[0].text, 'Fine')
  assert.ok(lines.some((l) => l.text.includes('garbage')))
})

test('parseLrc: 3-digit fractions are milliseconds', () => {
  const lines = parseLrc('[00:01.250]Ms')
  assert.equal(lines[0].startMs, 1250)
})

test('normalizeStructuredLyrics: synced doc with container offset (added)', () => {
  const doc = normalizeStructuredLyrics({
    synced: true,
    offset: 500,
    line: [
      { start: 1000, value: 'One' },
      { start: 2000, value: 'Two' },
    ],
  })
  assert.ok(doc)
  assert.equal(doc.synced, true)
  assert.equal(doc.lines[0].startMs, 1500)
  assert.equal(doc.lines[1].startMs, 2500)
})

test('normalizeStructuredLyrics: empty values skipped', () => {
  const doc = normalizeStructuredLyrics({ synced: false, line: [{ value: '' }, { value: 'Keep' }] })
  assert.ok(doc)
  assert.equal(doc.lines.length, 1)
  assert.equal(doc.lines[0].text, 'Keep')
})

test('normalizeStructuredLyrics: synced-without-timestamps degrades to unsynced', () => {
  const doc = normalizeStructuredLyrics({ synced: true, line: [{ value: 'A' }, { value: 'B' }] })
  assert.ok(doc)
  assert.equal(doc.synced, false)
  assert.ok(doc.lines.every((l) => l.startMs === null))
})

test('normalizeStructuredLyrics: lines sorted by start', () => {
  const doc = normalizeStructuredLyrics({
    synced: true,
    line: [
      { start: 3000, value: 'C' },
      { start: 1000, value: 'A' },
      { start: 2000, value: 'B' },
    ],
  })
  assert.deepEqual(doc?.lines.map((l) => l.text), ['A', 'B', 'C'])
})

test('normalizeStructuredLyrics: empty payload returns null', () => {
  assert.equal(normalizeStructuredLyrics({ synced: true, line: [] }), null)
  assert.equal(normalizeStructuredLyrics({}), null)
})

test('lyricsFromPlainText: one line per non-empty row', () => {
  const doc = lyricsFromPlainText('First\n\nSecond\n')
  assert.equal(doc.synced, false)
  assert.deepEqual(
    doc.lines.map((l) => l.text),
    ['First', 'Second'],
  )
})

test('pickLyricsVariant: synced beats unsynced; first otherwise', () => {
  const unsynced: RawStructuredLyrics = { synced: false, line: [{ value: 'plain' }] }
  const synced: RawStructuredLyrics = { synced: true, line: [{ start: 0, value: 'timed' }] }
  assert.equal(pickLyricsVariant([unsynced, synced]), synced)
  assert.equal(pickLyricsVariant([unsynced]), unsynced)
  assert.equal(pickLyricsVariant([]), null)
})

test('deriveLineEnds: line ends where the next starts; last line at duration', () => {
  const lines = parseLrc('[00:01.00]A\n[00:05.00]B\n[00:09.00]C')
  deriveLineEnds(lines, 12_000)
  assert.equal(lines[0].endMs, 5000)
  assert.equal(lines[1].endMs, 9000)
  assert.equal(lines[2].endMs, 12_000)
})

test('deriveLineEnds: last line falls back to +5s when duration unknown', () => {
  const lines = parseLrc('[00:01.00]A')
  deriveLineEnds(lines, null)
  assert.equal(lines[0].endMs, 6000)
})

test('deriveLineEnds: gaps >= 8s insert a break marker at the midpoint', () => {
  const lines = parseLrc('[00:00.00]A\n[00:10.00]B')
  deriveLineEnds(lines, null)
  assert.equal(lines.length, 3)
  assert.ok(isBreakMarker(lines[1]))
  assert.equal(lines[1].startMs, 5000)
  assert.equal(lines[1].endMs, 10_000)
  assert.equal(lines[0].endMs, 5000)
})

test('deriveLineEnds: sub-8s gaps do not break', () => {
  const lines = parseLrc('[00:00.00]A\n[00:07.00]B')
  deriveLineEnds(lines, null)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].endMs, 7000)
})

test('activeLineIndex: binary search boundaries', () => {
  const lines = parseLrc('[00:01.00]A\n[00:05.00]B\n[00:09.00]C')
  deriveLineEnds(lines, 12_000)
  assert.equal(activeLineIndex(lines, 0), -1)
  assert.equal(activeLineIndex(lines, 999), -1)
  assert.equal(activeLineIndex(lines, 1000), 0)
  assert.equal(activeLineIndex(lines, 4999), 0)
  assert.equal(activeLineIndex(lines, 5000), 1)
  assert.equal(activeLineIndex(lines, 99_999), 2)
})

test('activeLineIndex: break markers participate', () => {
  const lines = parseLrc('[00:00.00]A\n[00:10.00]B')
  deriveLineEnds(lines, null)
  assert.equal(activeLineIndex(lines, 4999), 0)
  assert.equal(activeLineIndex(lines, 5000), 1) // the ♪ line
  assert.equal(activeLineIndex(lines, 10_000), 2)
})

test('activeLineIndex: unsynced doc is never active', () => {
  const doc = lyricsFromPlainText('A\nB')
  assert.equal(activeLineIndex(doc.lines, 5000), -1)
})
