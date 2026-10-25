import { test, expect } from '@playwright/test'
import { gotoEqualizer, openEqualizer, relaunch } from './eqHelpers'

// Proves the EQ view describes what the engine APPLIES (eqEffective), on the
// production bundle: a band parsed as OFF is drawn off in the graph, its
// per-band slider is inert (the engine skips it), and it stays reachable so it
// can be switched back on. Bypassing the EQ makes every band inert.
//
// The restart tests pin the store's single-owner model through a REAL reload:
// the working session is the only EQ state, the selection is derived from it,
// and both must come back from IndexedDB — an import (a base with no preset
// row) and a save that moves only the selection (unchanged values) are the two
// transitions a value-only or preset-only persist rule loses.
//
// What the ENGINE holds after each transition is pinned by eqengine.spec.ts.

test('a disabled band is drawn off, its slider inert, and it stays reachable', async ({ page }) => {
  await openEqualizer(page)

  await page.getByRole('button', { name: 'Import' }).click()
  await page
    .getByPlaceholder(/Paste AutoEQ/)
    .fill('Filter 1: ON PK Fc 1000 Hz Gain 6 dB Q 0.7\nFilter 2: OFF PK Fc 4000 Hz Gain -6 dB Q 1.0')
  await page.getByRole('button', { name: 'Apply' }).click()

  // The off band's control is dimmed out and cannot be dragged: its value is
  // not in effect, so the UI must not let it look live.
  const offSlider = page.getByRole('slider', { name: '4k Hz band (off)' })
  await expect(offSlider).toBeAttached()
  await expect(offSlider).toHaveAttribute('aria-disabled', 'true')

  // The on band is still live.
  await expect(page.getByRole('slider', { name: '1k Hz band' }).first()).toHaveAttribute(
    'aria-disabled',
    'false'
  )

  // Drawn (not invisible) as off, and tappable to switch it back on.
  await expect(page.locator('[aria-label*="4k Hz, off"]').first()).toBeAttached()
  await expect(page.getByRole('button', { name: '4k off' })).toBeEnabled()
})

test('an imported EQ survives a reload in both the controls and the applied state', async ({ page }) => {
  await openEqualizer(page)

  await page.getByRole('button', { name: 'Import' }).click()
  await page
    .getByPlaceholder(/Paste AutoEQ/)
    .fill('Preamp: -5 dB\nFilter 1: ON PK Fc 1000 Hz Gain 6 dB Q 0.7')
  await page.getByRole('button', { name: 'Apply' }).click()

  const preamp = page.getByRole('slider', { name: 'Preamp' })
  await expect(preamp).toHaveAttribute('aria-valuenow', '-5')
  // An import has no preset row: the select names the session base instead of
  // the preset the import replaced.
  const select = page.locator('[data-eq-preset-select]')
  await expect(select).toHaveValue('imported')

  await relaunch(page)
  await gotoEqualizer(page)

  // One restore write restored the session; the derived controls read it.
  await expect(page.getByRole('slider', { name: 'Preamp' })).toHaveAttribute('aria-valuenow', '-5')
  await expect(page.locator('[data-eq-preset-select]')).toHaveValue('imported')
  await expect(page.getByRole('slider', { name: '1k Hz band' }).first()).toHaveAttribute(
    'aria-valuenow',
    '6'
  )
})

test('a preset switch applies, and survives a reload as selection + state', async ({ page }) => {
  await openEqualizer(page)

  await page.locator('[data-eq-preset-select]').selectOption('bass_boost')
  await expect(page.getByRole('slider', { name: 'Preamp' })).toHaveAttribute('aria-valuenow', '-3')

  await relaunch(page)
  await gotoEqualizer(page)

  await expect(page.locator('[data-eq-preset-select]')).toHaveValue('bass_boost')
  await expect(page.getByRole('slider', { name: 'Preamp' })).toHaveAttribute('aria-valuenow', '-3')
  await expect(page.getByRole('slider', { name: '31 Hz band' })).toHaveAttribute('aria-valuenow', '6')
})

test('a save that only moves the selection survives a reload', async ({ page }) => {
  await openEqualizer(page)

  // Clean Flat session, no value edits: only the session base changes, so a
  // persist rule keyed on the values alone would forget the saved preset.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByPlaceholder('New preset name…').fill('Restart Probe')
  await page.getByRole('button', { name: 'Save as New' }).click()
  const select = page.locator('[data-eq-preset-select]')
  await expect(select).toHaveValue(/^user_/)

  await relaunch(page)
  await gotoEqualizer(page)

  const restored = page.locator('[data-eq-preset-select]')
  await expect(restored).toHaveValue(/^user_/)
  await expect(restored.locator('option:checked')).toHaveText('Restart Probe')
})

test('bypassing makes every band control inert', async ({ page }) => {
  await openEqualizer(page)

  await expect(page.getByRole('button', { name: 'Active' })).toBeVisible()
  await page.getByRole('button', { name: 'Active' }).click()
  await expect(page.getByRole('button', { name: 'Bypassed' })).toBeVisible()

  await expect(page.getByRole('slider', { name: 'Preamp' })).toHaveAttribute('aria-disabled', 'true')
  for (const slider of await page.getByRole('slider', { name: /Hz band/ }).all()) {
    await expect(slider).toHaveAttribute('aria-disabled', 'true')
  }
})
