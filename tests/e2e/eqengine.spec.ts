import { test, expect } from '@playwright/test'
import {
  enableDebugHud,
  expectEngineMatchesControls,
  gotoEqualizer,
  openEqualizer,
  readEngineEq,
  readUiEq,
  relaunch,
  waitForPersistedSetting,
} from './eqHelpers'

// The ENGINE side of the EQ (2026-10 audit defect): a preset switch and a
// preset DELETION moved the controls and the session store but pushed nothing,
// so audioManager kept the previous preset until the next track load — and on
// iOS until relaunch (the native push ran at boot only).
//
// Every transition now reaches the audio through one subscription, so this spec
// asserts the engine's own applied config after each one, not just the sliders.
// The engine state comes from the app's Copy dump (audioManager
// getEngineDebugState), which is the same readout a bug report carries.

test('a preset switch is what the engine applies, and so is deleting that preset', async ({ page }) => {
  await enableDebugHud(page)
  await openEqualizer(page)

  await expectEngineMatchesControls(page)

  await page.locator('[data-eq-preset-select]').selectOption('bass_boost')
  await expect(page.getByRole('slider', { name: '31 Hz band' })).toHaveAttribute('aria-valuenow', '6')
  await expectEngineMatchesControls(page)

  // A different preset with the SAME band set (only gains move): the engine is
  // updated band by band, and must still end on the new preset.
  await page.locator('[data-eq-preset-select]').selectOption('v_shape')
  await expect(page.getByRole('slider', { name: '31 Hz band' })).toHaveAttribute('aria-valuenow', '5')
  await expectEngineMatchesControls(page)

  // Save that preset as a user preset, then delete it: the fallback (Flat) must
  // reach the engine too — the audit's second measured hole.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByPlaceholder('New preset name…').fill('Engine Probe')
  await page.getByRole('button', { name: 'Save as New' }).click()
  await expect(page.locator('[data-eq-preset-select]')).toHaveValue(/^user_/)
  await expectEngineMatchesControls(page)

  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('[data-eq-preset-select]')).toHaveValue('flat')
  const engine = await expectEngineMatchesControls(page)
  expect(engine.bands.every((b) => b.gain === 0), 'flat means flat in the engine').toBe(true)
})

test('a bypassed EQ is still bypassed in the engine after a reload', async ({ page }) => {
  await enableDebugHud(page)
  await openEqualizer(page)
  await page.locator('[data-eq-preset-select]').selectOption('bass_boost')
  await page.getByRole('button', { name: 'Active' }).click()
  await expect(page.getByRole('button', { name: 'Bypassed' })).toBeVisible()
  // The bypass is a fire-and-forget `persisted` store: reload only once its row
  // is durable, or this test races a kill instead of the restore it pins.
  await waitForPersistedSetting(page, 'eq_bypassed', true)

  await relaunch(page)
  await gotoEqualizer(page)

  // The boot push happens before any audio graph exists after a reload, so this
  // also pins that a pre-graph bypass is recorded rather than dropped.
  const engine = await readEngineEq(page)
  expect(engine.bypassed, 'the restored bypass reached the engine').toBe(true)
  expect(engine.preampDb, 'a bypassed engine applies 0 dB').toBe(0)

  // Un-bypassing restores the restored preset's preamp in the engine too — the
  // values that came back from disk, not defaults.
  await page.getByRole('button', { name: 'Bypassed' }).click()
  const restored = await expectEngineMatchesControls(page)
  expect(restored.bypassed).toBe(false)
  expect(restored.preampDb, 'the restored preset preamp').toBe(-3)
})

test('a mixed paste applies what parsed, warns about the rest, and reaches the engine', async ({ page }) => {
  await enableDebugHud(page)
  await openEqualizer(page)

  await page.getByRole('button', { name: 'Import' }).click()
  await page
    .getByPlaceholder(/Paste AutoEQ/)
    // Line 3 is the real AutoEQ shape this parser cannot read (no Q) — the
    // audit's case: the whole profile used to be rejected over it.
    .fill(
      'Preamp: -4 dB\nFilter 1: ON PK Fc 1000 Hz Gain 6 dB Q 0.7\nFilter 2 ON PK Fc 2000 Hz Gain 3 dB\nFilter 3: ON PK Fc 4000 Hz Gain -5 dB Q 1.0'
    )
  await page.getByRole('button', { name: 'Apply' }).click()

  await expect(page.getByText(/Applied everything it could read/)).toBeVisible()
  await expect(page.getByText(/Line 3: Unrecognized syntax/)).toBeVisible()

  // The readable bands are in the sound: the panel stays open, the EQ behind it
  // already changed, and the engine holds exactly what the sliders show.
  const engine = await expectEngineMatchesControls(page)
  expect(engine.bands.filter((b) => b.gain !== 0).map((b) => b.frequency)).toEqual([1000, 4000])
  expect(engine.preampDb, 'the preamp parsed too').toBe(-4)

  // Editing the paste drops the stale result line with the text it described.
  await page.getByPlaceholder(/Paste AutoEQ/).fill('Filter 1: ON PK Fc 500 Hz Gain 2 dB Q 1')
  await expect(page.getByText(/Applied everything it could read/)).toHaveCount(0)
})

test('a GraphicEQ line with no readable point does not change the shape of a parametric import', async ({ page }) => {
  await enableDebugHud(page)
  await openEqualizer(page)

  await page.getByRole('button', { name: 'Import' }).click()
  await page
    .getByPlaceholder(/Paste AutoEQ/)
    .fill('Filter 1: ON PK Fc 1000 Hz Gain 6 dB Q 0.7\nGraphicEQ: nothing here')
  await page.getByRole('button', { name: 'Apply' }).click()

  // The readable filter still lands on the standard grid (10 bands), not as a
  // one-band "graphic" import with no curve.
  const engine = await expectEngineMatchesControls(page)
  expect(engine.bands.map((b) => b.frequency)).toEqual([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000])
  expect(engine.bands.find((b) => b.frequency === 1000)?.gain).toBe(6)
  expect(engine.convolver, 'no curve stack, so the biquad path').toBe(false)
})

test('a paste where nothing parses, and an empty paste, apply nothing and say so', async ({ page }) => {
  await enableDebugHud(page)
  await openEqualizer(page)
  await page.locator('[data-eq-preset-select]').selectOption('bass_boost')
  const before = await readEngineEq(page)

  await page.getByRole('button', { name: 'Import' }).click()
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('No EQ filters found in that text.')).toBeVisible()

  await page.getByPlaceholder(/Paste AutoEQ/).fill('GraphicEQ: nothing here; also nothing')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('No EQ filters found in that text.')).toBeVisible()

  // Nothing was applied: the engine still runs the selected preset.
  const after = await readEngineEq(page)
  expect(after.bands.map((b) => b.gain)).toEqual(before.bands.map((b) => b.gain))
  expect(after.preampDb).toBe(before.preampDb)
})

test('a GraphicEQ body applies alongside unreadable lines', async ({ page }) => {
  await enableDebugHud(page)
  await openEqualizer(page)

  await page.getByRole('button', { name: 'Import' }).click()
  await page
    .getByPlaceholder(/Paste AutoEQ/)
    .fill('Preamp: -6 dB\nGraphicEQ: 20 -6; 1000 0; 20000 6\nFilter 9 ON PK Fc 3000 Hz Gain 2 dB')
  await page.getByRole('button', { name: 'Apply' }).click()

  await expect(page.getByText(/Applied everything it could read/)).toBeVisible()
  await expect(page.getByText(/Line 3: Unrecognized syntax/)).toBeVisible()

  const engine = await readEngineEq(page)
  expect(engine.convolver, 'the parsed curve still drives the convolver').toBe(true)
  expect(engine.bands.map((b) => b.frequency), 'the curve points that parsed').toEqual([20, 1000, 20000])
  expect(engine.preampDb).toBe(-6)
})

test('a per-band gain edit is live in the engine', async ({ page }) => {
  await enableDebugHud(page)
  await openEqualizer(page)

  // The band editor's quick chips route through the same edit path as a graph
  // drag (moveFilter) — the drag itself cannot be trusted in a headless click.
  await page.getByRole('button', { name: '1k', exact: true }).click()
  await page.getByRole('button', { name: '+6', exact: true }).click()
  // Close the band editor (the modal's own Close — the view header has one too).
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('slider', { name: '1k Hz band' })).toHaveAttribute('aria-valuenow', '6')

  const engine = await expectEngineMatchesControls(page)
  expect(engine.bands.find((b) => b.frequency === 1000)?.gain, 'the edited band is at +6 in the engine').toBe(6)
})

test('an import, Reset All and bypass all change what the engine runs', async ({ page }) => {
  await enableDebugHud(page)
  await openEqualizer(page)

  await page.getByRole('button', { name: 'Import' }).click()
  await page
    .getByPlaceholder(/Paste AutoEQ/)
    .fill('Preamp: -5 dB\nFilter 1: ON PK Fc 1000 Hz Gain 6 dB Q 0.7')
  await page.getByRole('button', { name: 'Apply' }).click()

  // Parametric import: merged onto the band grid, applied as biquads.
  let engine = await expectEngineMatchesControls(page)
  expect(engine.convolver, 'a parametric import stays on the biquad/worklet path').toBe(false)

  // GraphicEQ import: the curve stack IS the sound on web (convolver path).
  await page.getByRole('button', { name: 'Import' }).click()
  await page
    .getByPlaceholder(/Paste AutoEQ/)
    .fill('Preamp: -6 dB\nGraphicEQ: 20 -6; 1000 0; 20000 6')
  await page.getByRole('button', { name: 'Apply' }).click()
  engine = await readEngineEq(page)
  expect(engine.convolver, 'the imported curve drives the convolver').toBe(true)
  expect(engine.preampDb, 'the imported preamp').toBe(-6)

  await page.getByRole('button', { name: 'Reset All' }).click()
  engine = await expectEngineMatchesControls(page)
  expect(engine.preampDb, 'Reset All zeroes the preamp').toBe(0)

  // Bypass: nothing applies — the engine records bypass AND a 0 dB applied
  // preamp, so a bypassed EQ cannot stay 6 dB hot.
  await page.getByRole('button', { name: 'Active' }).click()
  await expect(page.getByRole('button', { name: 'Bypassed' })).toBeVisible()
  engine = await readEngineEq(page)
  expect(engine.bypassed).toBe(true)
  expect(engine.preampDb, 'a bypassed EQ applies no preamp').toBe(0)

  await page.getByRole('button', { name: 'Bypassed' }).click()
  const restored = await readEngineEq(page)
  expect(restored.bypassed).toBe(false)
  expect(restored.preampDb, 'un-bypassing restores the preamp the controls show').toBe(
    (await readUiEq(page)).preampDb
  )
})
