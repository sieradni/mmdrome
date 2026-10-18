import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, basename } from 'node:path'

// Dedicated generated fixtures only; no proxying or production credentials.
const fixtureRoot = new URL('../native/StreamFileSupport/Tests/StreamFileSupportTests/Fixtures/', import.meta.url)
const allowed = new Map([['growth.opus', 'audio/ogg'], ['header.flac', 'audio/flac']])
const bounded = (value, fallback, min, max) => {
  const n = value === null ? fallback : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) throw new Error('Invalid transfer profile')
  return n
}

export function fixtureServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture.invalid')
      const name = url.pathname.slice(1)
      if (!allowed.has(name) || basename(name) !== name) {
        response.writeHead(404).end('Use /growth.opus or /header.flac')
        return
      }
      const bytes = await readFile(new URL(name, fixtureRoot))
      const rate = bounded(url.searchParams.get('rate'), 24_000, 1, 100_000_000)
      const chunk = Math.floor(bounded(url.searchParams.get('chunk'), 4096, 1, 1_048_576))
      const pauseAt = bounded(url.searchParams.get('pauseAt'), 0, 0, bytes.length)
      const pauseMs = bounded(url.searchParams.get('pauseMs'), 0, 0, 120_000)
      const match = /^bytes=(\d+)-(?:(\d+))?$/.exec(request.headers.range ?? '')
      const start = match ? Number(match[1]) : 0
      const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1
      if (start > end || start >= bytes.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }).end()
        return
      }
      const headers = { 'Content-Type': allowed.get(name), 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges' }
      if (url.searchParams.get('length') !== '0') headers['Content-Length'] = String(end - start + 1)
      if (match) headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`
      response.writeHead(match ? 206 : 200, headers)
      let offset = start
      let paused = false
      let timer
      response.on('close', () => clearTimeout(timer))
      const send = () => {
        if (response.destroyed) return
        if (!paused && pauseAt > 0 && offset >= pauseAt) {
          paused = true
          timer = setTimeout(send, pauseMs)
          return
        }
        if (offset > end) { response.end(); return }
        const next = Math.min(end + 1, offset + chunk)
        const piece = bytes.subarray(offset, next)
        offset = next
        const continueSending = () => { timer = setTimeout(send, piece.length / rate * 1000) }
        if (response.write(piece)) continueSending()
        else response.once('drain', continueSending)
      }
      send()
    } catch {
      if (!response.headersSent) response.writeHead(400)
      response.end('Invalid fixture or transfer profile')
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port')
  fixtureServer().listen(port, '0.0.0.0', () => {
    console.log(`Generated audio fixtures: http://localhost:${port}/growth.opus?rate=24000&chunk=4096`)
    console.log('rate=bytes/sec; pauseAt=absolute byte offset; pauseMs=one pause; length=0 omits total. Range is supported.')
  })
}
