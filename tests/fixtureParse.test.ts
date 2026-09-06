import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMp3Fixture } from './e2e/fixture'

// The e2e WebDAV mock serves these bytes to the REAL browser taglib; this
// Node-side guard (taglib-wasm runs on Node >=22.6 with its Emscripten
// fallback) fails fast if a taglib upgrade or a fixture change ever breaks
// parseability or identity — instead of an opaque Playwright timeout.

test('fixture mp3 parses through taglib-wasm with the expected identity tags', async () => {
  const { TagLib } = await import('taglib-wasm')
  const taglib = await TagLib.initialize()
  for (const fixture of [
    { title: 'Song One', artist: 'Artist A', album: 'Album X', track: 1, frames: 8 },
    { title: 'Song Two', artist: 'Artist B', album: 'Album Y', track: 2, frames: 10 },
  ]) {
    const bytes = buildMp3Fixture(fixture)
    assert.ok(bytes.length >= 1024, 'taglib-wasm rejects buffers under 1 KiB')
    const file = await taglib.open(new Uint8Array(bytes))
    const props = file.properties()
    const first = (v: unknown): string | undefined =>
      Array.isArray(v) ? String(v[0]) : typeof v === 'string' ? v : undefined
    assert.equal(first(props.title), fixture.title)
    assert.equal(first(props.artist), fixture.artist)
    assert.equal(first(props.album), fixture.album)
    assert.equal(first(props.trackNumber), String(fixture.track))
    const audio = file.audioProperties()
    assert.ok(audio, 'audio properties parse')
    assert.equal(audio?.codec, 'MP3')
    file.dispose()
  }
})
