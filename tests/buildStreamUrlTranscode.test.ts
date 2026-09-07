import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStreamUrl } from '../src/lib/navidromeApi'

const config = {
  baseUrl: 'https://srv.example',
  username: 'u',
  password: 'p',
}

test('buildStreamUrl: no transcode arg — byte-identical legacy URL', () => {
  const url = buildStreamUrl(config, 'abc123')
  assert.ok(url.startsWith('https://srv.example/rest/stream.view?'))
  assert.ok(url.includes('id=abc123'))
  assert.ok(!url.includes('format='), 'no format param without transcode')
  assert.ok(!url.includes('maxBitRate='), 'no bitrate param without transcode')
  assert.ok(!url.includes('estimateContentLength'))
})

test('buildStreamUrl: transcode params appended when provided', () => {
  const url = buildStreamUrl(config, 'abc123', { format: 'opus', maxBitRate: 128 })
  assert.ok(url.includes('format=opus'))
  assert.ok(url.includes('maxBitRate=128'))
  assert.ok(url.includes('estimateContentLength=true'))
})

test('buildStreamUrl: auth params survive alongside transcode params', () => {
  const url = buildStreamUrl(config, 'abc123', { format: 'mp3', maxBitRate: 96 })
  assert.ok(url.includes('u=u'))
  assert.ok(url.includes('v='), 'subsonic version param present')
  assert.ok(url.includes('c='), 'client name param present')
})
