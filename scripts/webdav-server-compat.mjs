#!/usr/bin/env node
// Opt-in integration gate (not named test-* so Node's unit discovery skips it):
// real upstream servers, production write core and
// tag editor, real Chromium CORS. No user endpoints, credentials or music.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, request as httpRequest } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { webdavPutAtomic, readDestinationValidators, ConflictError, AbortedBeforeMoveError } from '../src/lib/webdavAtomicWrite.ts'
import { authHeaders, buildWebdavUrl } from '../src/lib/webdavPaths.ts'
import { modifyMetadataBuffer } from '../src/lib/tagWriter.ts'
import { getTagLib } from '../src/lib/taglibSingleton.ts'
import { buildMp3Fixture } from '../tests/e2e/fixture.ts'

const exec = promisify(execFile)
const command = async (file, args, options = {}) => (await exec(file, args, {
  windowsHide: true, timeout: 240_000, maxBuffer: 8_000_000, ...options,
})).stdout.trim()
const here = resolve('tests/webdav-servers')
const profiles = [
  { name: 'go', version: 'golang.org/x/net v0.62.0' },
  { name: 'apache', image: 'mmdrome-webdav-apache:compat', version: 'Apache 2.4.69 / mod_dav_fs',
    args: ['httpd-foreground', '-f', '/compat/apache.conf'], config: join(here, 'apache.conf') },
  { name: 'sabre', image: 'mmdrome-webdav-sabre:compat', version: 'sabre/dav 4.7.0' },
  { name: 'rclone', image: 'rclone/rclone:1.75.2@sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5',
    version: 'rclone 1.75.2', args: ['serve', 'webdav', '/data', '--addr', ':8080'] },
  { name: 'dufs', image: 'sigoden/dufs:v0.47.0@sha256:e5152c04e41d5a9d785546278b632bf035c8a08c52d7e8d35f4b59681f5ff35a',
    version: 'Dufs 0.47.0', args: ['/data', '-A', '-b', '0.0.0.0', '-p', '8080'] },
  { name: 'wsgidav', image: 'mmdrome-webdav-wsgidav:compat', version: 'WsgiDAV 4.4.0 / cheroot 11.1.2' },
  { name: 'nginx', image: 'mmdrome-webdav-nginx:compat', version: 'nginx 1.30.6 / dav-ext module' },
]
const strict = process.argv.includes('--strict')
const selected = process.argv.slice(2).filter(arg => arg !== '--strict')
if (selected.some(name => !profiles.some(p => p.name === name))) throw new Error('Unknown server profile')
const targets = selected.length ? profiles.filter(p => selected.includes(p.name)) : profiles
const browserName = process.env.WEBDAV_BROWSER ?? 'chromium'
const browserType = { chromium, firefox }[browserName]
if (!browserType) throw new Error('WEBDAV_BROWSER must be chromium or firefox')
// Playwright owns and clears test-results before a run. Keep live backend
// data/evidence separate so running the UI suite cannot delete its files.
mkdirSync(resolve('webdav-compat-results'), { recursive: true })
const runRoot = mkdtempSync(resolve('webdav-compat-results/run-'))
const report = { startedAt: new Date().toISOString(), scope: 'Local filesystem backends through a restrictive CORS reverse proxy; not full product installations or remote storage providers.', servers: [] }
const auth = authHeaders('compat', 'disposable-test-password')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })

async function startBackend(profile, data) {
  if (profile.name === 'go') {
    const binary = join(runRoot, process.platform === 'win32' ? 'go-dav.exe' : 'go-dav')
    await command('go', ['build', '-o', binary, '.'], { cwd: join(here, 'go') })
    const probe = createServer()
    const address = await listen(probe)
    await close(probe)
    const child = spawn(binary, ['-root', data, '-addr', address.slice(7)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let logs = ''
    child.stderr.on('data', b => { logs += b })
    return { address, identity: profile.version, stop: async () => { child.kill(); }, logs: () => logs }
  }
  if (['apache', 'sabre', 'wsgidav', 'nginx'].includes(profile.name)) {
    console.log(`building ${profile.name} integration image`)
    await command('docker', ['build', '-q', '-t', profile.image, join(here, profile.name)])
  }
  const args = ['run', '-d', '--name', `mmdrome-dav-${profile.name}-${Date.now()}`,
    '-p', '127.0.0.1::8080', '--mount', `type=bind,source=${data},target=/data`]
  if (profile.config) args.push('--mount', `type=bind,source=${profile.config},target=/compat/apache.conf,readonly`)
  args.push(profile.image, ...(profile.args ?? []))
  const id = await command('docker', args)
  try {
    const mapping = await command('docker', ['port', id, '8080/tcp'])
    const identity = await command('docker', ['image', 'inspect', profile.image, '--format', '{{.Id}}'])
    return {
      address: `http://${mapping.split('\n')[0]}`, identity,
      stop: () => command('docker', ['rm', '-f', id]),
      logs: async () => {
        const output = await exec('docker', ['logs', id], { windowsHide: true, timeout: 10_000, maxBuffer: 1_000_000 })
        return output.stdout + output.stderr
      },
    }
  } catch (error) { await command('docker', ['rm', '-f', id]); throw error }
}

async function ready(address, logs) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(address + '/', { method: 'OPTIONS', signal: AbortSignal.timeout(1000) })
      await response.arrayBuffer()
      if (response.status < 500) return
    } catch { /* starting */ }
    await sleep(200)
  }
  throw new Error('Server did not start: ' + await logs())
}

// CORS is deliberately a separate configured reverse proxy, as on many real
// installations. It does not implement DAV, XML validators, writes or renames.
async function corsProxy(backend) {
  const trace = []
  let dropMoveResponse = false
  const server = createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, PROPFIND, PUT, MOVE, DELETE',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, Destination, Overwrite', Vary: 'Origin' }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return }
    if (req.headers.authorization !== auth.Authorization) { res.writeHead(401, cors).end(); return }
    const upstream = httpRequest(backend + req.url, { method: req.method, headers: req.headers }, response => {
      trace.push({ method: req.method, path: req.url, status: response.statusCode,
        headers: Object.fromEntries(['if', 'if-match', 'if-unmodified-since', 'overwrite', 'destination'].filter(h => req.headers[h]).map(h => [h, req.headers[h]])) })
      if (dropMoveResponse && req.method === 'MOVE') {
        dropMoveResponse = false
        response.resume()
        response.on('end', () => res.destroy())
        return
      }
      const headers = { ...response.headers, ...cors }
      delete headers['access-control-expose-headers']
      delete headers['access-control-allow-credentials']
      res.writeHead(response.statusCode, headers)
      response.pipe(res)
    })
    upstream.on('error', error => { if (!res.headersSent) res.writeHead(502, cors); res.end(String(error)) })
    req.pipe(upstream)
  })
  return { server, address: await listen(server), trace, dropNextMove: () => { dropMoveResponse = true } }
}

const origin = createServer((_req, res) => res.end('<!doctype html><title>WebDAV compatibility</title>'))
let browser
try {
  const originUrl = await listen(origin)
  browser = await browserType.launch()
  const page = await browser.newPage()
  await page.goto(originUrl)
  report.browser = browser.version()
  report.browserEngine = browserName
  for (const profile of targets) {
    const facts = { name: profile.name, version: profile.version, cases: [] }
    report.servers.push(facts)
    let backend, proxy
    try {
      const data = join(runRoot, profile.name)
      mkdirSync(join(data, 'Music'), { recursive: true })
      // Disposable fixture directories only. Apache/nginx run as unprivileged
      // container users; Linux bind mounts otherwise inherit the host's 0755.
      chmodSync(data, 0o777)
      chmodSync(join(data, 'Music'), 0o777)
      backend = await startBackend(profile, data)
      facts.imageIdentity = backend.identity
      await ready(backend.address, backend.logs)
      proxy = await corsProxy(backend.address)
      const base = proxy.address + '/'
      const transportCalls = []
      const direct = (url, options = {}) => fetch(url, { ...options, headers: { ...auth, ...options.headers }, signal: AbortSignal.timeout(15_000) })
      const browserFetch = async (url, options, timeoutMs) => {
        transportCalls.push({ method: options.method ?? 'GET', url })
        const bodyBase64 = options.body instanceof ArrayBuffer ? Buffer.from(options.body).toString('base64') : null
        const value = await page.evaluate(async ({ url, options, bodyBase64, timeoutMs }) => {
          const response = await fetch(url, { ...options, body: bodyBase64 !== null ? Uint8Array.from(atob(bodyBase64), c => c.charCodeAt(0)) : options.body,
            signal: AbortSignal.timeout(timeoutMs) })
          const bytes = new Uint8Array(await response.arrayBuffer())
          let binary = ''
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
          return { ok: response.ok, status: response.status, base64: btoa(binary) }
        }, { url, options: { ...options, headers: Object.fromEntries(new Headers(options.headers)), body: bodyBase64 !== null ? undefined : options.body }, bodyBase64, timeoutMs })
        const bytes = Buffer.from(value.base64, 'base64')
        return { ok: value.ok, status: value.status, text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => new Uint8Array(bytes).buffer }
      }
      const nativeFetch = (url, options) => direct(url, options)
      const original = buildMp3Fixture({ title: 'Fixture', artist: 'Original Artist' })
      const remote = buildMp3Fixture({ title: 'Fixture', artist: 'Concurrent Writer' })
      const seed = async (path, bytes = original) => {
        const response = await direct(buildWebdavUrl(base, path), { method: 'PUT', body: bytes })
        const body = await response.text()
        assert.ok(response.ok, `seed PUT ${response.status}: ${body.slice(0, 300)}`)
      }
      const get = async path => Buffer.from(await (await direct(buildWebdavUrl(base, path), { cache: 'no-store' })).arrayBuffer())
      const baseline = async (path, transport) => {
        const read = await readDestinationValidators(transport, buildWebdavUrl(base, path), auth, 15_000)
        assert.equal(read.kind, 'ok', 'server must publish usable DAV validators')
        return read.validators
      }
      const scenario = async (name, fn) => {
        try {
          const limitation = await fn()
          facts.cases.push({ name, result: limitation ? 'limitation' : 'passed', ...(limitation ? { limitation } : {}) })
        }
        catch (error) { facts.cases.push({ name, result: 'failed', error: String(error.stack ?? error) }); console.log(`${profile.name}: FAIL ${name}: ${error.message}`) }
      }
      for (const path of ['Music/Song One.mp3', 'Music/Ego Renegade Boy [qdlD5a9umzg].mp3', 'Music/Björk 中 # & 100%.mp3']) {
        for (const [mode, transport] of [['browser', browserFetch], ['native-core', nativeFetch]]) {
          await scenario(`${mode}: replace ${path}`, async () => {
            await seed(path)
            const validators = await baseline(path, transport)
            const read = await transport(buildWebdavUrl(base, path), { headers: auth, cache: 'no-store' }, 15_000)
            const modified = await modifyMetadataBuffer(await read.arrayBuffer(), 80, true, 'mp3')
            const outcome = await webdavPutAtomic(base, path, modified, 'compat', 'disposable-test-password', validators, transport, 15_000, { revalidateOnly: mode === 'browser' })
            assert.notEqual(outcome.precondition, 'blind')
            if (mode === 'browser') assert.equal(outcome.precondition, 'revalidated')
            const written = await get(path)
            assert.ok(written.includes(Buffer.from('POPM')), 'rating frame survives actual server storage')
            assert.ok(written.includes(Buffer.from('Original Artist')))
            assert.equal((await direct(buildWebdavUrl(base, path + '.mmdrome-tmp'))).status, 404)
          })
        }
      }
      const path = 'Music/Song One.mp3'
      await scenario('browser: real Opus rating roundtrip', async () => {
        const path = 'Music/Ego Renegade Boy [qdlD5a9umzg].opus'
        await seed(path, readFileSync(resolve('native/StreamFileSupport/Tests/StreamFileSupportTests/Fixtures/growth.opus')))
        const validators = await baseline(path, browserFetch)
        const read = await browserFetch(buildWebdavUrl(base, path), { headers: auth, cache: 'no-store' }, 15_000)
        const modified = await modifyMetadataBuffer(await read.arrayBuffer(), 80, true, 'opus')
        await webdavPutAtomic(base, path, modified, 'compat', 'disposable-test-password', validators, browserFetch, 15_000, { revalidateOnly: true })
        const taglib = await getTagLib()
        const file = await taglib.open(new Uint8Array(await get(path)))
        try {
          const rating = Object.entries(file.properties()).find(([key]) => key.toUpperCase() === 'RATING')?.[1]
          assert.equal(Array.isArray(rating) ? rating[0] : rating, '80')
        } finally { file.dispose() }
      })
      await scenario('discovery: Depth infinity or Depth 1 fallback', async () => {
        let response = await browserFetch(base, { method: 'PROPFIND', headers: { ...auth, Depth: 'infinity' } }, 15_000)
        if ([400, 403, 405, 409, 412, 501].includes(response.status)) response = await browserFetch(base, { method: 'PROPFIND', headers: { ...auth, Depth: '1' } }, 15_000)
        assert.equal(response.status, 207)
        assert.match(await response.text(), /Music/)
      })
      await scenario('single byte Range read with minimal CORS', async () => {
        const response = await browserFetch(buildWebdavUrl(base, path), { headers: { ...auth, Range: 'bytes=0-99' } }, 15_000)
        assert.equal(response.status, 206)
        assert.equal((await response.arrayBuffer()).byteLength, 100)
      })
      for (const [mode, transport] of [['browser', browserFetch], ['native-core', nativeFetch]]) {
        await scenario(`${mode}: concurrent writer refused before MOVE`, async () => {
          await seed(path)
          const validators = await baseline(path, transport)
          const moves = proxy.trace.filter(r => r.method === 'MOVE').length
          await assert.rejects(webdavPutAtomic(base, path, new Uint8Array(original).buffer, 'compat', 'disposable-test-password', validators, transport, 15_000, {
            revalidateOnly: mode === 'browser', beforeMove: async () => {
              // Date-only servers cannot resolve writes within the same second.
              // Test their advertised granularity here; record that limit below.
              if (!validators.etag) await sleep(1100)
              await seed(path, remote); return true
            },
          }), ConflictError)
          assert.equal(proxy.trace.filter(r => r.method === 'MOVE').length, moves)
          assert.deepEqual(await get(path), remote)
          assert.equal((await direct(buildWebdavUrl(base, path + '.mmdrome-tmp'))).status, 404)
        })
        await scenario(`${mode}: cancelled write cleans temp`, async () => {
          await seed(path)
          const validators = await baseline(path, transport)
          await assert.rejects(webdavPutAtomic(base, path, new Uint8Array(remote).buffer, 'compat', 'disposable-test-password', validators, transport, 15_000, {
            revalidateOnly: mode === 'browser', beforeMove: () => false,
          }), AbortedBeforeMoveError)
          assert.deepEqual(await get(path), original)
          assert.equal((await direct(buildWebdavUrl(base, path + '.mmdrome-tmp'))).status, 404)
        })
      }
      const currentValidators = await baseline(path, browserFetch)
      if (!currentValidators.etag) facts.limitations = ['DAV exposes only last-modified: changes within its timestamp resolution may be invisible to the collision check.']
      await scenario('lost MOVE response stays unknown even if the browser retries', async () => {
        await seed(path)
        const validators = await baseline(path, browserFetch)
        const moves = proxy.trace.filter(r => r.method === 'MOVE').length
        const calls = transportCalls.filter(r => r.method === 'MOVE').length
        proxy.dropNextMove()
        try {
          await webdavPutAtomic(base, path, new Uint8Array(remote).buffer, 'compat', 'disposable-test-password', validators, browserFetch, 15_000, { revalidateOnly: true })
          assert.fail('lost response must not report success')
        } catch (error) { assert.equal(error.remoteState, 'unknown') }
        const wireMoves = proxy.trace.filter(r => r.method === 'MOVE').slice(moves)
        assert.equal(wireMoves.filter(r => r.status >= 200 && r.status < 300).length, 1, 'one committed rename')
        assert.equal(transportCalls.filter(r => r.method === 'MOVE').length, calls + 1, 'application makes no ambiguous retry')
        facts.browserAutomaticMoveRetries = wireMoves.length - 1
        const after = await direct(buildWebdavUrl(base, path))
        const bytes = Buffer.from(await after.arrayBuffer())
        if (after.status === 404 && wireMoves.length > 1) {
          return 'Upstream replay hazard: first MOVE committed, browser transparently replayed it, and the server deleted the destination before discovering the source was gone. App reports unknown; this server/proxy combination is not safe under response loss.'
        }
        assert.equal(after.status, 200)
        assert.deepEqual(bytes, remote, 'the backend retained the committed file')
      })
      facts.trace = proxy.trace
      facts.result = facts.cases.some(c => c.result === 'failed') ? 'failed' :
        facts.cases.some(c => c.result === 'limitation') || facts.limitations?.length ? 'passed-with-limitations' : 'passed'
      if (facts.result === 'failed') facts.logs = await backend.logs()
      console.log(`${profile.name}: ${facts.cases.filter(c => c.result === 'passed').length}/${facts.cases.length} passed; ${facts.result}`)
    } catch (error) {
      facts.result = 'failed'
      facts.error = String(error.stack ?? error)
      if (backend) facts.logs = await backend.logs()
      console.log(`${profile.name}: ${error.message}`)
    } finally {
      if (proxy) await close(proxy.server)
      if (backend) await backend.stop()
      writeFileSync(join(runRoot, 'report.json'), JSON.stringify(report, null, 2))
    }
  }
} finally {
  await browser?.close()
  await close(origin)
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(runRoot, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`Evidence: ${join(runRoot, 'report.json')}`)
}
if (report.servers.some(s => s.result === 'failed' || (strict && s.result !== 'passed'))) process.exitCode = 1
