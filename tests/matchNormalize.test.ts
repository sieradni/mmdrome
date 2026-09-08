import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filenameHintsTitle,
  foldMapForSearch,
  normalizeForHint,
  normalizeForMatch,
  normalizeForSearch,
} from '../src/lib/matchNormalize'

test('CJK titles survive normalization', () => {
  assert.equal(normalizeForMatch('バビロン'), 'バビロン')
  assert.equal(normalizeForMatch('日本語のタイトル'), '日本語のタイトル')
  assert.equal(normalizeForHint('バビロン'), 'バビロン')
  assert.equal(normalizeForMatch('ビートルズ - Let It Be'), 'ビートルズ let it be')
})

test('symbols and emoji are stripped; letters of any script survive', () => {
  assert.equal(normalizeForMatch('🎵 Title — (Live) [Remastered]'), 'title live remastered')
  assert.equal(normalizeForMatch('Élodie (feat. Mø)'), 'élodie feat mø')
  assert.equal(normalizeForMatch('!!!').length, 0)
  assert.equal(normalizeForHint('01 - Astral Traveller!'), '01 astral traveller')
})

test('normalizeForHint cannot drift from normalizeForMatch', () => {
  const samples = [
    'バビロン',
    'ビートルズ - Let It Be',
    'Élodie (feat. Mø)',
    '🎵 Title — (Live) [Remastered]',
    '!!!',
    '01 - Astral Traveller!',
    'Александр Зацепин',
    'かぐや姫 ～ 光る竹',
  ]
  for (const s of samples) {
    assert.equal(normalizeForHint(s), normalizeForMatch(s))
  }
})

test('filenameHintsTitle never matches on empty normalized titles', () => {
  assert.equal(filenameHintsTitle('01 - Track.mp3', new Set([''])), false)
  assert.equal(filenameHintsTitle('01 - Track.mp3', new Set(['!!!'])), false)
  assert.equal(filenameHintsTitle('01 - Track.mp3', new Set(['track', ''])), true)
})

test('filenameHintsTitle: leading track numbers are stripped before compare', () => {
  assert.equal(filenameHintsTitle('01 - Track.mp3', new Set(['track'])), true)
  assert.equal(filenameHintsTitle('07 - バビロン.flac', new Set(['バビロン'])), true)
})

test('filenameHintsTitle: CJK titles match their own filenames, not others', () => {
  assert.equal(filenameHintsTitle('バビロン.mp3', new Set(['バビロン'])), true)
  assert.equal(filenameHintsTitle('Other Song.mp3', new Set(['バビロン'])), false)
})

test('filenameHintsTitle: empty filename base never matches', () => {
  assert.equal(filenameHintsTitle('.mp3', new Set(['x'])), false)
  assert.equal(filenameHintsTitle('', new Set(['x'])), false)
})

// ── normalizeForSearch (search-box folding) ────────────────────────────

test('normalizeForSearch folds diacritics for search', () => {
  assert.equal(normalizeForSearch('Beyoncé'), 'beyonce')
  assert.equal(normalizeForSearch('Élodie'), 'elodie')
  assert.equal(normalizeForSearch('Åse'), 'ase')
})

test('normalizeForSearch preserves CJK voicing marks (katakana dakuten survive NFD+NFC round-trip)', () => {
  assert.equal(normalizeForSearch('ビートルズ'), 'ビートルズ')
  assert.equal(normalizeForSearch('バビロン'), 'バビロン')
  assert.equal(normalizeForSearch('かぐや姫'), 'かぐや姫')
  assert.equal(normalizeForSearch('ガ'), 'ガ')
})

test('normalizeForSearch inherits the canonical folding (case, punctuation, whitespace)', () => {
  assert.equal(normalizeForSearch('  AC/DC  '), 'acdc')
  assert.equal(normalizeForSearch("Don't Stop"), 'dont stop')
  assert.equal(normalizeForSearch('!!!'), '')
})

// ── foldMapForSearch (folded→raw alignment for highlighting) ──────────

/** The map's contract: folded output EXACTLY equals normalizeForSearch(raw),
 *  and every mapped raw range is inside bounds and non-decreasing. */
function assertValidMap(raw: string) {
  const { folded, mapStart, mapEnd } = foldMapForSearch(raw)
  assert.equal(folded, normalizeForSearch(raw), JSON.stringify(raw))
  assert.equal(mapStart.length, folded.length, JSON.stringify(raw))
  assert.equal(mapEnd.length, folded.length, JSON.stringify(raw))
  for (let k = 0; k < folded.length; k++) {
    assert.ok(mapStart[k] < mapEnd[k], `empty span at ${k} in ${JSON.stringify(raw)}`)
    assert.ok(mapEnd[k] <= raw.length, `span past end at ${k} in ${JSON.stringify(raw)}`)
    if (k > 0) assert.ok(mapStart[k] >= mapStart[k - 1], `spans out of order at ${k} in ${JSON.stringify(raw)}`)
  }
}

test('foldMapForSearch: folded output is byte-identical to normalizeForSearch', () => {
  const corpus = [
    "Don't Stop Me Now",
    '/dav/files/user/Beatles/01 - Hey Jude.flac',
    'Beyoncé — Édition Deluxe (Live) [2020]',
    '  AC/DC  ',
    '!!!',
    '',
    'バビロン',
    'ビートルズ - Let It Be',
    'かぐや姫 ～ 光る竹',
    'Åse Østrøm',
    'İstanbul ﬁle',
    '가나다 한글',
    'Çağatay Ö.',
    ' Straße ß ',
  ]
  for (const raw of corpus) assertValidMap(raw)
})

test('foldMapForSearch: folded characters map back to their raw sources', () => {
  // Punctuation is consumed by the pipeline but bracketed by its neighbors:
  // the token `dont` spans the apostrophe in the raw string.
  const { folded, mapStart, mapEnd } = foldMapForSearch("Don't")
  assert.equal(folded, 'dont')
  const raw = "Don't"
  const span = raw.slice(mapStart[0], mapEnd[3])
  assert.equal(span, "Don't", `got ${JSON.stringify(span)}`)
})

test('foldMapForSearch: CJK voicing marks attribute to the voiced character', () => {
  const { folded, mapStart, mapEnd } = foldMapForSearch('バビロン')
  assert.equal(folded, 'バビロン')
  // Each folded char maps to exactly its own raw position (3-byte chars in
  // UTF-16 are 1 code unit each here).
  for (let k = 0; k < folded.length; k++) {
    assert.equal(mapEnd[k] - mapStart[k], 1)
  }
})
