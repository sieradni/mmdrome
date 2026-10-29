import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startLocalServers } from './e2e/localServers'

for (const requireExplicitOverwrite of [false, true]) {
  test(`WebDAV fixture enforces overwrite semantics (explicit T required: ${requireExplicitOverwrite})`, async () => {
    const server = await startLocalServers({ requireExplicitOverwrite })
    try {
      const path = `${server.dir}/Song One.mp3`
      const destination = server.webdavBaseUrl + path.split('/').map(encodeURIComponent).join('/')
      const source = destination + '.mmdrome-tmp'
      const before = Buffer.from(server.fileBytes(path)!)
      const replacement = Buffer.from('replacement bytes')
      assert.equal((await fetch(source, { method: 'PUT', body: replacement })).status, 201)
      // Explicit refusal always holds, even when a server defaults to T.
      assert.equal((await fetch(source, { method: 'MOVE', headers: { Destination: destination, Overwrite: 'F' } })).status, 412)
      assert.deepEqual(server.fileBytes(path), before)
      const omitted = await fetch(source, { method: 'MOVE', headers: { Destination: destination } })
      assert.equal(omitted.status, requireExplicitOverwrite ? 412 : 204)
      if (requireExplicitOverwrite) {
        assert.deepEqual(server.fileBytes(path), before)
        assert.deepEqual(server.fileBytes(path + '.mmdrome-tmp'), replacement)
        assert.equal((await fetch(source, { method: 'MOVE', headers: { Destination: destination, Overwrite: 'T' } })).status, 204)
      }
      assert.deepEqual(server.fileBytes(path), replacement)
      assert.equal(server.fileBytes(path + '.mmdrome-tmp'), undefined)
    } finally {
      await server.close()
    }
  })
}
