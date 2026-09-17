const CACHE_NAME = 'mmdrome-v1'
const PRELOAD_CACHE = 'mmdrome-preload-cache'

const BASE = self.location.pathname.replace(/\/sw\.js$/, '') || '/'

const STATIC_ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png',
  BASE + '/icon-1024.png',
  BASE + '/manifest.webmanifest',
  BASE + '/soundtouch-processor.js',
]

function stripBase(pathname) {
  if (pathname.startsWith(BASE)) {
    return pathname.slice(BASE.length) || '/'
  }
  return pathname
}

function isApiOrStreaming(pathname) {
  const p = stripBase(pathname)
  return (
    p.startsWith('/api/') ||
    p.startsWith('/rest/') ||
    p.startsWith('/dav/')
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(STATIC_ASSETS).catch(() => {})
    )
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== PRELOAD_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)

  // NOTE (2026-09-17): cover art (getCoverArt) is DELIBERATELY not app-cached
  // here. The session-stable Subsonic salt (navidromeApi buildAuthParams,
  // localStorage `mmdrome:authSalt`) makes cover URLs survive restarts, so the
  // browser's own HTTP cache does this job correctly: Navidrome serves real
  // art as `public, no-cache` + ETag (revalidated via 304, so changed art is
  // picked up) and placeholders as `no-store` (never cached). An app-level
  // cache-first layer would double-store bytes, serve stale art on changes,
  // and persist unreadable placeholder bodies for cross-origin (opaque)
  // servers. Do not re-add one without solving those three.
  if (url.origin !== self.location.origin) return

  if (isApiOrStreaming(url.pathname)) return

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        }
        return response
      })
      .catch(() => caches.match(event.request))
  )
})
