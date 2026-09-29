import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Pins the Albums/Artists VIRTUAL GRID WINDOWS (2026-09-28; replaces the
// chunking spec — the grids now render a window of cells between row
// spacers, exactly the SongsView model). The invariants:
// - a large library mounts a BOUNDED cell count (never the whole grid), and
//   the count stays bounded deep in the list (no grow-only memory);
// - a scrollbar teleport lands the CORRECT content (the window derives from
//   scrollTop — no whole-gap mount, no stall);
// - the header count is the honest FULL filtered count;
// - the album/artist detail track lists window the same way.

const ALBUMS = 210 // 445 tracks (2 per album) — several windows deep

type SongRow = Record<string, unknown>

function makeLibrary(): SongRow[] {
  const songs: SongRow[] = []
  for (let a = 0; a < ALBUMS; a++) {
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

async function bootWithLargeLibrary(page: Page): Promise<void> {
  await installLargeLibraryMock(page)
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
}

function mountedCells(page: Page, attr: string): Promise<number> {
  return page.evaluate((a) => document.querySelectorAll(`[${a}]`).length, attr)
}

async function scrollToGridBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('div.flex-1.overflow-y-auto')
    if (!scroller) throw new Error('grid scroll container not found')
    scroller.scrollTop = scroller.scrollHeight
    scroller.dispatchEvent(new Event('scroll'))
  })
}

test('albums grid mounts a bounded window at the top', async ({ page }) => {
  await bootWithLargeLibrary(page)
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
  const header = page.locator('h2', { hasText: 'Albums · ' })
  await expect(header).toHaveText(`Albums · ${ALBUMS}`, { timeout: 20_000 })
  // Bounded: 2–5 columns × a handful of rows, never the whole 210.
  const cells = await mountedCells(page, 'data-album')
  expect(cells).toBeGreaterThan(4)
  expect(cells).toBeLessThanOrEqual(60)
})

test('albums grid teleport lands the last album with a bounded window', async ({ page }) => {
  await bootWithLargeLibrary(page)
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
  await expect(page.locator('h2', { hasText: 'Albums · ' })).toHaveText(`Albums · ${ALBUMS}`, { timeout: 20_000 })
  await scrollToGridBottom(page)
  await page.waitForTimeout(400)
  // The teleport renders the END of the list (a chunk grid would need to
  // grow through every sentinel; the window derives straight from scrollTop).
  const last = page.locator('[data-album]').last()
  await expect(last).toHaveAttribute('data-album', /Album 0209/)
  const cells = await mountedCells(page, 'data-album')
  expect(cells).toBeLessThanOrEqual(60)
})

test('artists grid windows the same way', async ({ page }) => {
  await bootWithLargeLibrary(page)
  await page.getByRole('button', { name: 'Artists', exact: true }).click()
  const header = page.locator('h2', { hasText: 'Artists · ' })
  await expect(header).toHaveText(`Artists · ${ALBUMS}`, { timeout: 20_000 })
  const cells = await mountedCells(page, 'data-artist')
  expect(cells).toBeGreaterThan(4)
  expect(cells).toBeLessThanOrEqual(60)
  await scrollToGridBottom(page)
  await page.waitForTimeout(400)
  // Artists sort alphabetically — the last cell is the alphabetically last
  // artist ("Artist 99"), NOT the highest index.
  await expect(page.locator('[data-artist]').last()).toHaveAttribute('data-artist', 'Artist 99')
})

test('album detail track list windows its rows', async ({ page }) => {
  await bootWithLargeLibrary(page)
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
  await page.locator('[data-album]').first().click()
  await page.waitForTimeout(400)
  // An album holds 2 tracks here — both mounted; the window machinery must
  // not break the small case. The rows carry the shared [data-track-id].
  const rows = await page.evaluate(() => document.querySelectorAll('[data-track-id]').length)
  expect(rows).toBe(2)
})
