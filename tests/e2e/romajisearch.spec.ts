import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Pins the Japanese script bridge END TO END (2026-11-16). The node suites pin
// the matcher (`textMatchCore`/`romanizeCore`); this spec proves the WIRING —
// the debounced header input feeding the real bundled views, so a romaji query
// filters a kana catalog. That gap cannot be covered by a unit test: the search
// box lives in App.svelte, the filter in the views, and the bundle is what
// ships.
//
// The catalog is deliberately kana-only on the Japanese rows (title, artist and
// album), with one Latin row to prove ordinary search did not change.

const CATALOG = [
  {
    id: 'jp-1', title: 'ツユ', artist: 'ツユ', album: 'くらべられっ子',
    duration: 215, track: 1, year: 2020, genre: 'J-Pop', suffix: 'mp3', bitRate: 320,
    size: 9_000_000, starred: 'false', created: '2024-01-03T00:00:00Z', albumId: 'al-jp',
    path: 'Music/ツユ - くらべられっ子.mp3',
  },
  {
    id: 'jp-2', title: 'アサガオ', artist: 'ヨルシカ', album: 'くらべられっ子',
    duration: 199, track: 2, year: 2020, genre: 'J-Pop', suffix: 'mp3', bitRate: 320,
    size: 8_800_000, starred: 'false', created: '2024-01-04T00:00:00Z', albumId: 'al-jp',
    path: 'Music/ヨルシカ - アサガオ.mp3',
  },
  {
    id: 'en-1', title: 'Golden Hour', artist: 'Mara Voss', album: 'Nightdrive',
    duration: 187, track: 1, year: 2021, genre: 'Electronic', suffix: 'flac', bitRate: 320,
    size: 29_000_000, starred: 'false', created: '2024-03-20T00:00:00Z', albumId: 'al-en',
    path: 'Music/Golden Hour.flac',
  },
]

async function bootWithKanaCatalog(page: Page): Promise<void> {
  await installNavidromeMock(page, CATALOG)
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await expect(page.locator('[data-track-id]').first()).toBeVisible({ timeout: 15_000 })
}

/** The Songs rows' ids, in render order. */
function rowIds(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-track-id]')].map((el) => el.getAttribute('data-track-id')),
  )
}

async function search(page: Page, query: string): Promise<void> {
  await page.locator('input[aria-label^="Fuzzy search"]').fill(query)
}

test('a romaji query filters a kana catalog (title, artist and album alike)', async ({ page }) => {
  await bootWithKanaCatalog(page)
  expect(await rowIds(page)).toEqual(['navidrome-jp-1', 'navidrome-jp-2', 'navidrome-en-1'])

  // Kunrei-shiki (the headline case: `tuyu` → ツユ) and Hepburn agree.
  await search(page, 'tuyu')
  await expect.poll(() => rowIds(page)).toEqual(['navidrome-jp-1'])
  await search(page, 'tsuyu')
  await expect.poll(() => rowIds(page)).toEqual(['navidrome-jp-1'])

  // The album's kana is reachable too, and ties keep library order.
  await search(page, 'kurabe')
  await expect.poll(() => rowIds(page)).toEqual(['navidrome-jp-1', 'navidrome-jp-2'])

  // Artist: ヨルシカ by its reading.
  await search(page, 'yorushika')
  await expect.poll(() => rowIds(page)).toEqual(['navidrome-jp-2'])

  // Kana typed directly still works, and Latin search is unchanged.
  await search(page, 'つゆ')
  await expect.poll(() => rowIds(page)).toEqual(['navidrome-jp-1'])
  await search(page, 'golden')
  await expect.poll(() => rowIds(page)).toEqual(['navidrome-en-1'])

  // A latin-only word does NOT reach an unrelated kana row (no invented match).
  await search(page, 'ramen')
  await expect(page.getByText('No songs match the current filters')).toBeVisible()
  await expect.poll(() => rowIds(page)).toEqual([])

  // Clearing restores the whole library.
  await search(page, '')
  await expect.poll(() => rowIds(page)).toEqual(['navidrome-jp-1', 'navidrome-jp-2', 'navidrome-en-1'])
})
