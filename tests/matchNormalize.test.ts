import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filenameHintsTitle,
  normalizeForHint,
  normalizeForMatch,
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
