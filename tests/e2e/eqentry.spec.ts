import { test, expect } from '@playwright/test'
import { bootSongLibrary } from './thumbflowHelpers'
import {
  EQ_SONG,
  enableDebugHud,
  expectEngineMatchesControls,
  gotoEqualizer,
  openEqualizerFromSettings,
  readEngineEq,
} from './eqHelpers'

// The Equalizer's entry points (2026-10-25c). Its only way in used to be the
// mini-bar → Now Playing → Options sheet, which does not exist until a track is
// loaded — so everything the EQ does was gated behind pressing play. Settings
// is the surface that always exists; it opens the SAME overlay the options
// sheet opens (one view, one piece of open state in App), and the EQ's back
// button returns to whichever surface opened it.

test('the Equalizer opens from Settings with nothing playing, and the engine follows', async ({ page }) => {
  await enableDebugHud(page)
  await bootSongLibrary(page, EQ_SONG)
  // Nothing played yet: no current track, so the options sheet is unreachable.
  await expect(page.getByText('Not playing')).toBeVisible()

  await openEqualizerFromSettings(page)
  await expect(page.locator('[data-eq-preset-select]')).toBeVisible()

  // A preset switch with no audio graph and no track: the engine still records
  // the applied config, which is what a later track load builds its graph from.
  await page.locator('[data-eq-preset-select]').selectOption('bass_boost')
  await expect(page.getByRole('slider', { name: '31 Hz band' })).toHaveAttribute('aria-valuenow', '6')
  const engine = await expectEngineMatchesControls(page)
  expect(engine.preampDb, 'the preset preamp is applied').toBe(-3)
})

test('closing the EQ returns to the surface that opened it, and both entries share its state', async ({ page }) => {
  await bootSongLibrary(page, EQ_SONG)

  // From Settings: back lands on the Playback section it came from.
  await openEqualizerFromSettings(page)
  await page.locator('[data-eq-preset-select]').selectOption('bass_boost')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open Equalizer' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0)

  // From the mini-bar options sheet (the path that always worked): the SAME EQ,
  // still on the preset chosen a moment ago, and back returns to that sheet.
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  await gotoEqualizer(page)
  await expect(page.locator('[data-eq-preset-select]')).toHaveValue('bass_boost')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Options', exact: true })).toBeVisible()
})

test('the EQ home button always lands on the library', async ({ page }) => {
  await bootSongLibrary(page, EQ_SONG)
  await openEqualizerFromSettings(page)

  // Opened from Settings, closing alone would land back on Settings — the home
  // button says "Library", so it goes there.
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(page.locator('[data-track-id]').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Equalizer' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0)
})

test('a bypassed EQ says so in its Settings row', async ({ page }) => {
  await enableDebugHud(page)
  await bootSongLibrary(page, EQ_SONG)
  await openEqualizerFromSettings(page)

  await expect(page.getByText('Bypassed', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Active' }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  const row = page.getByTestId('open-equalizer')
  await expect(row.getByText('Bypassed', { exact: true })).toBeVisible()
  // The row's badge is a read of the same store the engine applies.
  expect((await readEngineEq(page)).bypassed).toBe(true)
})
