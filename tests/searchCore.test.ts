// Pins the pure keyword-search core (searchCore.ts) shared by the
// Songs/Albums/Artists views and the auto-queue filter predicate: query
// tokenization (whitespace + quoted phrases), the AND-across-tokens /
// OR-across-fields matcher, and the normalizeForSearch folding
// (punctuation, diacritics; CJK voicing marks preserved).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fieldsMatchQuery,
  foldTrackFields,
  highlightSegments,
  parseSearchQuery,
  rankTrackMatch,
  trackMatchesQuery,
  trackMatchesQueryFast,
} from '../src/lib/searchCore'
import { foldMapForSearch } from '../src/lib/matchNormalize'
import type { Track } from '../src/stores/appState'

const track = (over: Partial<Track> = {}): Track => ({
  trackId: 't1',
  title: 'Hey Jude',
  artist: 'The Beatles',
  album: 'Abbey Road',
  duration: 100,
  fileType: 'mp3',
  ...over,
})

// ── parseSearchQuery ───────────────────────────────────────────────────

test('parseSearchQuery: splits on whitespace, folds case/punctuation/diacritics, keeps order', () => {
  assert.deepEqual(parseSearchQuery('  Hey   JUDE '), ['hey', 'jude'])
  assert.deepEqual(parseSearchQuery("Don't Stop"), ['dont', 'stop'])
  assert.deepEqual(parseSearchQuery('Beyoncé'), ['beyonce'])
  assert.deepEqual(parseSearchQuery('AC/DC'), ['acdc'])
  assert.deepEqual(parseSearchQuery('バビロン'), ['バビロン'], 'CJK survives intact (voicing marks preserved)')
})

test('parseSearchQuery: quoted phrases become one token', () => {
  assert.deepEqual(parseSearchQuery('"hey jude" beatles'), ['hey jude', 'beatles'])
  assert.deepEqual(parseSearchQuery('"Don\'t Stop Me Now"'), ['dont stop me now'])
})

test('parseSearchQuery: empty and all-symbol queries yield no tokens', () => {
  assert.deepEqual(parseSearchQuery(''), [])
  assert.deepEqual(parseSearchQuery('   '), [])
  assert.deepEqual(parseSearchQuery('!!! 🎵'), [], 'tokens folding to "" are dropped — .includes("") would match everything')
  assert.deepEqual(parseSearchQuery('"!!! "'), [])
})

test('parseSearchQuery: unbalanced quote degrades gracefully', () => {
  assert.deepEqual(parseSearchQuery('"hey jude'), ['hey', 'jude'])
})

// ── fieldsMatchQuery ───────────────────────────────────────────────────

test('fieldsMatchQuery: AND across tokens, OR across fields, order-independent', () => {
  const fields = ['Hey Jude', 'The Beatles', 'Abbey Road']
  assert.equal(fieldsMatchQuery(fields, ['hey', 'beat']), true)
  assert.equal(fieldsMatchQuery(fields, ['beat', 'hey']), true, 'token order irrelevant')
  assert.equal(fieldsMatchQuery(fields, ['hey jude', 'abbey']), true, 'one token can span within one field')
  assert.equal(fieldsMatchQuery(fields, ['hey', 'stones']), false, 'every token must hit some field')
  assert.equal(fieldsMatchQuery(fields, ['abbey jude']), false, 'a token cannot span FIELD boundaries')
})

test('fieldsMatchQuery: empty token list passes everything; empty tokens are dropped', () => {
  assert.equal(fieldsMatchQuery(['Anything'], []), true)
  assert.equal(fieldsMatchQuery(['Anything'], ['!!!']), false, 'raw unnormalized tokens are taken literally — callers pass parseSearchQuery output, which drops all-symbol tokens before they get here')
  assert.equal(fieldsMatchQuery([], ['x']), false, 'no fields can never match a real token')
})

test('fieldsMatchQuery: folding applies to both sides', () => {
  assert.equal(fieldsMatchQuery(["Don't Stop Me Now"], ['dont stop']), true)
  assert.equal(fieldsMatchQuery(['Beyoncé'], ['beyonce']), true)
  assert.equal(fieldsMatchQuery(['AC/DC'], ['ac', 'dc']), true, 'separate tokens hit the punctuation-stripped field')
  assert.equal(fieldsMatchQuery(['AC/DC'], ['acdc']), true)
  assert.equal(fieldsMatchQuery(['AC/DC'], ['ac dc']), false, 'a phrase token must appear verbatim in ONE folded field — "ac dc" ⊄ "acdc"')
})

test('fieldsMatchQuery: CJK queries are plain substrings (voicing exact)', () => {
  assert.equal(fieldsMatchQuery(['ビートルズ - Let It Be'], ['ビートルズ']), true)
  assert.equal(fieldsMatchQuery(['バビロン'], ['ハビロン']), false, 'unvoiced variant must NOT match (dakuten not folded)')
  assert.equal(fieldsMatchQuery(['バビロン'], ['バビ']), true)
})

// ── trackMatchesQuery ──────────────────────────────────────────────────

test('trackMatchesQuery: multi-token cross-field match (the headline case)', () => {
  assert.equal(trackMatchesQuery(track(), parseSearchQuery('hey beatles')), true)
  assert.equal(trackMatchesQuery(track(), parseSearchQuery('beatles jude')), true)
  assert.equal(trackMatchesQuery(track(), parseSearchQuery('jude stones')), false)
})

test('trackMatchesQuery: searches title/artist/album/composer/albumArtist', () => {
  const tokens = parseSearchQuery('lennon white')
  assert.equal(
    trackMatchesQuery(track({ composer: 'John Lennon', albumArtist: 'Various Artists', album: 'The White Album' }), tokens),
    true
  )
  assert.equal(trackMatchesQuery(track({ composer: 'John Lennon' }), tokens), false, 'each token needs its own field hit')
  assert.equal(
    trackMatchesQuery(track({ albumArtist: 'Various Artists' }), parseSearchQuery('various hey')),
    true,
    'albumArtist searchable (compilations)'
  )
})

// ── memoized folding + fast path ──────────────────────────────────────

test('trackMatchesQueryFast agrees with trackMatchesQuery; foldTrackFields memoizes per object', () => {
  const t = track({ composer: 'John Lennon' })
  const tokens = parseSearchQuery('hey lennon')
  assert.equal(trackMatchesQueryFast(t, tokens), trackMatchesQuery(t, tokens))
  assert.deepEqual(foldTrackFields(t), ['hey jude', 'the beatles', 'abbey road', 'john lennon', ''])
  assert.equal(foldTrackFields(t), foldTrackFields(t), 'same array identity on repeat calls (memo hit)')
})

test('foldTrackFields: a NEW track object folds fresh (library reload), old objects collect via WeakMap', () => {
  assert.deepEqual(foldTrackFields(track({ title: 'A' })), ['a', 'the beatles', 'abbey road', '', ''])
})

// ── relevance ranking ─────────────────────────────────────────────────

test('rankTrackMatch: 0 means no match, verdict identical to the predicate', () => {
  assert.equal(rankTrackMatch(track(), parseSearchQuery('stones')), 0)
  assert.ok(rankTrackMatch(track(), parseSearchQuery('hey beatles')) > 0)
})

test('rankTrackMatch: exact field > word-start > substring at the same field weight', () => {
  const tokens = parseSearchQuery('jude')
  const exact = rankTrackMatch(track({ title: 'Jude' }), tokens)
  const wordStart = rankTrackMatch(track({ title: 'Jude Law' }), tokens)
  const substring = rankTrackMatch(track({ title: 'Prejudice' }), tokens)
  assert.ok(exact > wordStart, `${exact} > ${wordStart}`)
  assert.ok(wordStart > substring, `${wordStart} > ${substring}`)
})

test('rankTrackMatch: title hits outrank artist hits at the same quality', () => {
  const tokens = parseSearchQuery('beatles')
  const titleHit = rankTrackMatch(track({ title: 'Beatles' }), tokens)
  const artistHit = rankTrackMatch(track({ title: 'X', artist: 'The Beatles' }), tokens)
  assert.ok(titleHit > artistHit, `${titleHit} > ${artistHit}`)
})

test('rankTrackMatch: score sums over tokens — more field hits outrank fewer weaker ones', () => {
  const tokens = parseSearchQuery('jude beatles')
  const twoStrongHits = rankTrackMatch(track(), tokens) // title jude + artist beatles
  const twoWeakHits = rankTrackMatch(track({ title: 'X', composer: 'Jude' }), tokens) // composer jude + artist beatles
  assert.ok(twoStrongHits > twoWeakHits, `${twoStrongHits} > ${twoWeakHits}`)
})

// ── highlightSegments ─────────────────────────────────────────────────

/** Helper: build the fold map, highlight, and render to a marked-up string. */
function render(raw: string, query: string): string {
  const tokens = parseSearchQuery(query)
  const { folded, mapStart, mapEnd } = foldMapForSearch(raw)
  return highlightSegments(raw, folded, tokens, mapStart, mapEnd)
    .map((s) => (s.match ? `[${s.text}]` : s.text))
    .join('')
}

test('highlightSegments: plain and highlighted segments bracket the folded match', () => {
  assert.equal(render('/dav/Beatles/01 - Hey Jude.flac', 'jude'), '/dav/Beatles/01 - Hey [Jude].flac')
  assert.equal(render('/dav/Beatles/01 - Hey Jude.flac', 'beatles jude'), '/dav/[Beatles]/01 - Hey [Jude].flac')
  assert.equal(render("Don't Stop Me Now.mp3", 'dont'), "[Don't] Stop Me Now.mp3", 'the apostrophe is bracketed by its folded neighbors')
})

test('highlightSegments: no tokens or no match → one plain segment', () => {
  assert.equal(render('/a/b.flac', '!!!'), '/a/b.flac')
  assert.equal(render('/a/b.flac', 'xyz'), '/a/b.flac')
  assert.equal(render('', 'x'), '')
})

test('highlightSegments: CJK token highlights exactly the voiced characters', () => {
  assert.equal(render('/バビロン/01 - 曲名.flac', 'バビ'), '/[バビ]ロン/01 - 曲名.flac')
})

test('highlightSegments: a mismatched map degrades to one plain segment (never wrong highlights)', () => {
  const raw = 'Hey Jude'
  assert.deepEqual(
    highlightSegments(raw, 'wrong-fold', ['hey'], [0], [3]),
    [{ text: raw, match: false }],
  )
  assert.deepEqual(
    highlightSegments(raw, 'heyjude', ['hey'], [0], [1, 2]),
    [{ text: raw, match: false }],
    'wrong-length map also degrades',
  )
})
