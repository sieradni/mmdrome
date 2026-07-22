const CACHE_NAME = 'mmdrome-v1'
const PRELOAD_CACHE = 'mmdrome-preload-cache'

const BASE = self.location.pathname.replace(/\/sw\.js$/, '') || '/'

const STATIC_ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png',
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

function isAppAsset(pathname) {
  const p = stripBase(pathname)
  return (
    p === '/' ||
    p === '/index.html' ||
    p.startsWith('/assets/') ||
    p.startsWith('/icon-') ||
    p === '/manifest.webmanifest' ||
    p === '/soundtouch-processor.js'
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

  if (url.origin !== self.location.origin) return

  if (isApiOrStreaming(url.pathname)) return

  if (isAppAsset(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return response
        })
      })
    )
    return
  }

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
