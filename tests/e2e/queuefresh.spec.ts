import { test, expect, type Page } from '@playwright/test'
import { bootSongLibrary } from './thumbflowHelpers'

// D7 through the REAL bundle (2026-10-21f): a filter/sort edit is a FRESH
// CONTEXT, not a patch on the old tail. The two behaviors this spec proves are
// the ones a user can see:
//
//  1. The tail is RE-DERIVED from the pool under the new rules. The old
//     kept-prefix patch preserved the already-queued rows at the head and
//     appended the newly eligible ones, so widening a year filter left the
//     tail in the OLD order with the new songs stuck on the end. Here the
//     widened tail is globally ascending again â€” the rebuilt order, not the
//     patched one.
//  2. The audible row and its anchor are untouched: the rewrite only writes
//     the auto section (the audible row was promoted to the user section when
//     it started, which is D5/D7 working together).
//
// The cooled-window reset (D7.2) is pinned in `tests/queueManagerFill.test.ts`
// instead: in a library small enough for a browser assertion the fill's tier 2
// admits cooled rows anyway, so the reset is only observable in queue state.

const YEARS = 12

function yearLib(): Record<string, unknown>[] {
  return Array.from({ length: YEARS }, (_, i) => ({
    id: `fresh-${i}`,
    title: `Fresh ${2010 + i}`,
    artist: 'Fresh Artist',
    album: 'Fresh Album',
    duration: 180,
    track: i + 1,
    year: 2010 + i,
    genre: 'Test',
    suffix: 'mp3',
    bitRate: 320,
    size: 8000000,
    albumId: 'fresh-album',
    path: `Music/Fresh/Track ${i}.mp3`,
  }))
}

// The sync prefixes every server id — read the fixture's index back out.
const yearOf = (id: string): number => 2010 + Number(id.replace(/^navidrome-fresh-/, ''))

async function boot(page: Page): Promise<void> {
  await bootSongLibrary(page, yearLib())
  await page.waitForTimeout(900)
}

async function openQueue(page: Page): Promise<void> {
  await page.locator('div.ui-island[role="button"]').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.waitForTimeout(600)
}

/** Track ids of the mounted AUTO rows, in rendered order. */
async function autoIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="Auto queue"] .queue-track-item')].map(
      (el) => (el as HTMLElement).dataset.trackId ?? '',
    ),
  )
}

async function userIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="User queue"] .queue-track-item')].map(
      (el) => (el as HTMLElement).dataset.trackId ?? '',
    ),
  )
}

test('a filter edit REBUILDS the tail in the new order and never disturbs the audible row (D7 / G1+G2)', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await boot(page)

  // Play the LOWEST-year song: with the year-ascending auto sort its rank is
  // the head of the order, so the anchor rotation is a no-op and the rebuilt
  // tail is plainly ascending.
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1200)
  await openQueue(page)

  // Narrow first: years 2015..2020 (six of the twelve songs).
  await page.getByRole('button', { name: 'Auto queue filters' }).click()
  await page.getByRole('dialog', { name: 'Auto queue filters' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Year', exact: true }).click()
  await page.getByPlaceholder('From', { exact: true }).fill('2015')
  await page.getByPlaceholder('To', { exact: true }).fill('2020')
  await page.waitForTimeout(800)

  const narrow = await autoIds(page)
  expect(narrow.length, 'six matching years are suggested').toBe(6)
  expect(narrow.map(yearOf)).toEqual([2015, 2016, 2017, 2018, 2019, 2020])

  // Now WIDEN the lower bound. The old patch kept 2015..2020 at the head and
  // appended 2011..2014, leaving the tail out of order; a fresh context
  // re-derives the whole order.
  await page.getByPlaceholder('From', { exact: true }).fill('2010')
  await page.waitForTimeout(900)

  const widened = await autoIds(page)
  expect(widened.map(yearOf), 'the widened tail is the REBUILT ascending order').toEqual([
    2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020,
  ])

  // The rule change touched the tail only: the audible row is still the played
  // song, still the anchor, still alone in the user section.
  expect(await userIds(page)).toEqual(['navidrome-fresh-0'])
  const playing = page.locator('div.z-40 .ui-now-playing-row')
  await expect(playing).toHaveCount(1)
  await expect(playing).toHaveAttribute('data-track-id', 'navidrome-fresh-0')
  await expect(playing).toHaveAttribute('data-combined-index', '0')

  // The user-queued row is not suggested back to itself: the active id is the
  // one id the fill's rotation tier excludes.
  expect(widened.includes('navidrome-fresh-0')).toBe(false)

  expect(pageErrors).toEqual([])
})
