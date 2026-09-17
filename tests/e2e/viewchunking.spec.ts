import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Pins the Albums/Artists grid chunking (the SongsView CHUNK pattern extended
// to the grids): a large library mounts the FIRST CHUNK of cells, the grid
// grows by a chunk as the sentinel scrolls near, the header shows the honest
// count, and the sentinel flips to terminal copy when done. The Navidrome
// mock's static 3-song catalog is overridden per-request below to emit a
// 210-album library — enough for several chunks — without touching the
// shared mock's other consumers.
//
// Mock contract (from navidromeMock's own docs): first boot creates the Dexie
// schema, THEN credentials are seeded, THEN a reload re-boots the pipeline
// against the mock — a fresh profile cannot be seeded before the stores
// exist. Every test follows that sequence.

const ALBUMS = 210 // 50-cell chunks

type SongRow = Record<string, unknown>

function makeLibrary(): SongRow[] {
  const songs: SongRow[] = []
  for (let a = 0; a < ALBUMS; a++) {
    // 2 tracks per album, distinct ids/albums/artists, deterministic names.
    for (let t = 0; t < 2; t++) {
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

/** Registers the standard Navidrome mock, then re-registers ONLY search3
 *  (Playwright routes are last-registered-first-matched) to answer with the
 *  large catalog. The cover-art catch-all answers 1×1 PNGs for every cell. */
async function installLargeLibraryMock(page: Page): Promise<void> {
  await installNavidromeMock(page)
  await page.route('**/search3.view*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        'subsonic-response': { status: 'ok', version: '1.16.1', searchResult3: { song: makeLibrary() } },
      }),
    }),
  )
}

/** One boot/seed/reload cycle so the pipeline connects against the mock with
 *  the large catalog. */
async function bootWithLargeLibrary(page: Page): Promise<void> {
  await installLargeLibraryMock(page)
  await bootApp(page) // first boot: creates the Dexie schema
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
}

async function openAlbums(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
}

async function openArtists(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Artists', exact: true }).click()
}

function scrollToGridBottom(page: Page): Promise<void> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('div.flex-1.overflow-y-auto')
    if (!scroller) throw new Error('grid scroll container not found')
    scroller.scrollTop = scroller.scrollHeight
    scroller.dispatchEvent(new Event('scroll'))
  })
}

test('albums grid mounts the first chunk and grows on scroll', async ({ page }) => {
  await bootWithLargeLibrary(page)
  await openAlbums(page)

  const header = page.locator('h2', { hasText: 'Albums · ' })
  // The library load lands after data-app-ready — retry through the window.
  await expect(header).toHaveText(/Albums · 210 \(50 shown\)/, { timeout: 20_000 })

  // Growth happens on scroll proximity (IO rootMargin 200px): one scroll to
  // the bottom is enough to arm the sentinel.
  await scrollToGridBottom(page)
  await expect(header).toHaveText(/Albums · 210 \((100|150|200) shown\)/, { timeout: 10_000 })
  await expect(page.getByText('Loading more…')).toBeVisible()
})

test('albums grid sentinel reports completion and stops growing', async ({ page }) => {
  await bootWithLargeLibrary(page)
  await openAlbums(page)

  const header = page.locator('h2', { hasText: 'Albums · ' })
  await expect(header).toHaveText(/Albums · 210 \(50 shown\)/, { timeout: 20_000 })

  // Scroll repeatedly until the header reports every group rendered.
  for (let i = 0; i < 15; i++) {
    await scrollToGridBottom(page)
    const txt = (await header.textContent()) ?? ''
    if (txt.includes('(210 shown)')) break
    await page.waitForTimeout(80)
  }
  await expect(page.getByText(`All ${ALBUMS} albums loaded`)).toBeVisible()
  await expect(page.getByText('Loading more…')).toHaveCount(0)
})

test('artists grid chunks the same way', async ({ page }) => {
  await bootWithLargeLibrary(page)
  await openArtists(page)

  const header = page.locator('h2', { hasText: 'Artists · ' })
  await expect(header).toHaveText(/Artists · 210 \(50 shown\)/, { timeout: 20_000 })

  await scrollToGridBottom(page)
  await expect(header).toHaveText(/Artists · 210 \((100|150|200) shown\)/, { timeout: 10_000 })
})
