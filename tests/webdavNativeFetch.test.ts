import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nativeWebdavFetch } from '../src/lib/webdavUtils'

for (const method of ['GET', 'PROPFIND']) {
  test(`native ${method} preserves fresh-read intent without browser cache support`, async () => {
    let sentHeaders: Record<string, string> = {}
    await nativeWebdavFetch('https://dav.example/song.mp3', {
      method,
      cache: 'no-store',
      headers: new Headers({ Authorization: 'Basic demo', Depth: '0' }),
    }, 1000, async (options) => {
      sentHeaders = options.headers ?? {}
      return { status: 200, data: '', headers: {}, url: options.url }
    })
    const headers = new Headers(sentHeaders)
    assert.equal(headers.get('Cache-Control'), 'no-cache')
    assert.equal(headers.get('Authorization'), 'Basic demo')
    assert.equal(headers.get('Depth'), '0')
  })
}

test('native requests without fresh-read intent retain their supplied headers', async () => {
  for (const headers of [undefined, { 'Cache-Control': 'max-age=60', Authorization: 'Basic demo' }]) {
    await nativeWebdavFetch('https://dav.example/song.mp3', { headers }, 1000, async (options) => {
      assert.deepEqual(new Headers(options.headers), new Headers(headers))
      return { status: 200, data: '', headers: {}, url: options.url }
    })
  }
})
