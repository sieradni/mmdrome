import { expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Shared harness for the thumbnail-flow e2e suites (thumbflow-views,
// thumbflow-stress). Covers are delayed so in-flight fetches are observable —
// with an instant server the connection pool never looks contended and the
// firehose class of bug is invisible (the exact blind spot that shipped in
// 1.2.23).
//
// Counting rules:
// - "Landing screen loaded" is asserted as a LOAD RATIO over the near-center
//   band, never as an absolute count. At a clamped list END the band is
//   genuinely small (last rows + upward pre-roll only), and grid cells are
//   ~6× taller than list rows — a count calibrated on one view lies on the
//   other. A stuck band (arming never fired) still fails: near=0 → ratio=0.
// - Queue counters are scoped to the queue overlay's scroller: the queue is
//   a z-40 overlay and the LIBRARY STAYS MOUNTED underneath, so document-wide
//   counts would mix the two surfaces.

export const ALBUMS = 220
export const TRACKS_PER_ALBUM = 2
export const COVER_DELAY_MS = 120

type SongRow = Record<string, unknown>

export function makeLibrary(albums = ALBUMS, perAlbum = TRACKS_PER_ALBUM): SongRow[] {
  const songs: SongRow[] = []
  for (let a = 0; a < albums; a++) {
    for (let t = 0; t < perAlbum; t++) {
      songs.push({
        id: `tr-${a}-${t}`,
        title: `Track ${t} of Album ${a}`,
        artist: `Artist ${a}`,
        album: `Album ${String(a).padStart(4, '0')}`,
        duration: 180,
        track: t + 1,
        year: 2020 + (a % 5),
        genre: 'Test',
        suffix: 'mp3',
        bitRate: 320,
        size: 8000000,
        starred: 'false',
        created: '2024-01-01T00:00:00Z',
        albumId: `al-${a}`,
        path: `Music/Album ${a}/Track ${t}.mp3`,
      })
    }
  }
  return songs
}

/** Standard mock + a large search3 override (last-registered-first-matched)
 *  + 120 ms covers. The boot/seed/reload cycle follows navidromeMock's
 *  contract: first boot creates the Dexie schema, then credentials, then a
 *  reload re-boots the pipeline against the mock. `songs` allows a custom
 *  catalog shape (e.g. one mega-album for a queue-flood test); the base mock
 *  still supplies the decodable stream WAV, so tracks can go ACTIVE. */
export async function bootSongLibrary(page: Page, songs: SongRow[]): Promise<void> {
  await installNavidromeMock(page)
  await page.route('**/search3.view*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        'subsonic-response': { status: 'ok', version: '1.16.1', searchResult3: { song: songs } },
      }),
    }),
  )
  await page.route('**/getCoverArt*', async (route) => {
    await new Promise((r) => setTimeout(r, COVER_DELAY_MS))
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: png,
    })
  })
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
}

export async function bootBigLibrary(page: Page): Promise<void> {
  await bootSongLibrary(page, makeLibrary())
}

/** Continuous stamped scrolling on a specific scroller — the scrollbar-jump
 *  profile (12-screen hops, ~50 ms apart). Resolves on the LAST hop — a
 *  fire-and-forget timer kept hopping after return, so "settled" samples
 *  recorded mid-teleport (the 2026-09-17n round's "9 mounted / 0 near"). */
export async function fling(page: Page, selector: string, hops: number, intervalMs: number): Promise<void> {
  await page.evaluate(
    ({ selector, hops, intervalMs }) =>
      new Promise<void>((resolve) => {
        const scroller = document.querySelector<HTMLElement>(selector)
        if (!scroller) throw new Error(`scroller not found: ${selector}`)
        let done = 0
        const timer = setInterval(() => {
          done++
          scroller.scrollTop += scroller.clientHeight * 12
          scroller.dispatchEvent(new Event('scroll'))
          if (done >= hops) {
            clearInterval(timer)
            resolve()
          }
        }, intervalMs)
      }),
    { selector, hops, intervalMs },
  )
}

/** A slow continuous drag profile: small steps at gesture cadence — the
 *  scroll events stay "recent", so the far pre-roll holds while the visible
 *  tier paces at one 4-row batch per hold window. */
export async function slowDrag(page: Page, selector: string, steps: number, pxPerStep: number, intervalMs: number): Promise<void> {
  await page.evaluate(
    ({ selector, steps, pxPerStep, intervalMs }) => {
      const scroller = document.querySelector<HTMLElement>(selector)
      if (!scroller) throw new Error(`scroller not found: ${selector}`)
      let done = 0
      const timer = setInterval(() => {
        done++
        scroller.scrollTop += pxPerStep
        scroller.dispatchEvent(new Event('scroll'))
        if (done >= steps) clearInterval(timer)
      }, intervalMs)
    },
    { selector, steps, pxPerStep, intervalMs },
  )
}

export function coverImgsIn(page: Page, scope: string): Promise<number> {
  return page.evaluate((scope) => {
    const root = document.querySelector(scope)
    if (!root) throw new Error(`scope not found: ${scope}`)
    return root.querySelectorAll('img[src*="getCoverArt"]').length
  }, scope)
}

/** Load state of the near-center band within `scope`: how many cover slots
 *  sit within `radiusVh` viewport-heights of the viewport center, and how
 *  many of those have a COMPLETE img. An in-flight row shows the wrapper
 *  div, not an img — a band stuck before arming reports near=0 (ratio 0),
 *  which must fail. Bands are sized to the CURRENT pre-roll geometry
 *  (5.5 ≈ the ±4000px unlatch box on a 720px viewport) — whatever the band
 *  size, near=0 still fails, so the assertion stays honest. */
export function nearBandLoad(page: Page, scope: string, radiusVh: number): Promise<{ near: number; loaded: number; ratio: number }> {
  return page.evaluate(({ scope, radiusVh }) => {
    const root = document.querySelector(scope)
    if (!root) throw new Error(`scope not found: ${scope}`)
    const vh = window.innerHeight
    const mid = vh / 2
    let near = 0
    let loaded = 0
    for (const img of root.querySelectorAll<HTMLImageElement>('img[src*="getCoverArt"]')) {
      const r = img.getBoundingClientRect()
      if (Math.abs(r.top + r.height / 2 - mid) <= vh * radiusVh) {
        near++
        if (img.complete && img.naturalWidth > 0) loaded++
      }
    }
    return { near, loaded, ratio: near === 0 ? 0 : loaded / near }
  }, { scope, radiusVh })
}

export const LIST_SCROLLER = 'div.flex-1.overflow-y-auto'
export const QUEUE_SCROLLER = 'div.z-40 div.min-h-0.flex-1.overflow-y-auto'
