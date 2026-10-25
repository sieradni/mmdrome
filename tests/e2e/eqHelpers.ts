import { expect, type Page } from '@playwright/test'
import { bootSongLibrary } from './thumbflowHelpers'
import { openSettingsSection } from './libraryHarness'

// Shared harness for the two EQ specs: one song, the route into the Equalizer,
// and the two readings every EQ assertion compares — the CONTROLS (band slider
// aria values) and the ENGINE's own applied config (the app's diagnostic dump,
// which reads audioManager.getEngineDebugState). A spec that compares both is
// asserting the requirement the EQ work exists for: what the UI shows is what
// the audio runs.

export const EQ_SONG = [
  {
    id: 'eq1',
    title: 'EQ Probe',
    artist: 'Artist A',
    album: 'Album X',
    duration: 180,
    track: 1,
    year: 2024,
    genre: 'Test',
    suffix: 'mp3',
    bitRate: 320,
    size: 8000000,
    starred: 'false',
    created: '2024-01-01T00:00:00Z',
    albumId: 'eqal',
    path: 'Music/Album X/EQ Probe.mp3',
  },
]

/** The HUD's Copy dump is the app's own engine readout; enabling the HUD before
 *  boot makes it available without touching the audio path. */
export async function enableDebugHud(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('mmdrome:debugHud', '1'))
}

/** Navigate to the Equalizer from an already-booted library (also used after
 *  a reload, where the mock routes and IndexedDB are still in place). */
export async function gotoEqualizer(page: Page): Promise<void> {
  await expect(page.locator('[data-track-id]').first()).toBeVisible({ timeout: 20_000 })
  await page.locator('[data-track-id]').first().click()
  // The mini bar is the container that opens Now Playing; the Options entry
  // lives there (the mini bar itself only carries transport buttons). Click
  // its artwork corner so no nested transport button swallows the click.
  const miniBar = page.getByRole('button', { name: /EQ Probe Artist A Previous track/ })
  await expect(miniBar).toBeVisible({ timeout: 20_000 })
  await miniBar.click({ position: { x: 8, y: 8 } })
  const options = page.getByRole('button', { name: 'Options', exact: true })
  await expect(options).toBeEnabled({ timeout: 20_000 })
  await options.click()
  await page.getByRole('button', { name: 'Equalizer' }).click()
  await expect(page.getByRole('button', { name: 'Import' })).toBeVisible()
}

export async function openEqualizer(page: Page): Promise<void> {
  await bootSongLibrary(page, EQ_SONG)
  await gotoEqualizer(page)
}

/** Settings → Playback → Equalizer: the entry that needs NO loaded track, so it
 *  is also the one that opens an EQ with no web audio graph behind it. */
export async function openEqualizerFromSettings(page: Page): Promise<void> {
  await openSettingsSection(page, 'playback')
  await page.getByRole('button', { name: 'Open Equalizer' }).click()
  await expect(page.getByRole('button', { name: 'Import' })).toBeVisible()
}

export async function relaunch(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
}

/** The controls' own report: every band's gain and the preamp. */
export async function readUiEq(page: Page): Promise<{ gains: number[]; preampDb: number }> {
  const gains = await page
    .getByRole('slider', { name: /Hz band/ })
    .evaluateAll((els) => els.map((el) => Number(el.getAttribute('aria-valuenow'))))
  const preampDb = Number(
    await page.getByRole('slider', { name: 'Preamp' }).getAttribute('aria-valuenow')
  )
  return { gains, preampDb }
}

export interface EngineEq {
  bands: { type: string; frequency: number; gain: number; q: number; enabled: boolean; curve: string }[]
  preampDb: number
  bypassed: boolean
  convolver: boolean
}

/** The ENGINE's applied EQ, from the app's Copy dump (captured at copy time). */
export async function readEngineEq(page: Page): Promise<EngineEq> {
  const dump = await page.evaluate(() => {
    const w = window as unknown as { __debugHudText?: string }
    w.__debugHudText = undefined
    const copy = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Copy'
    )
    if (!copy) throw new Error('DebugHud Copy button missing — call enableDebugHud before boot')
    copy.click()
    const text = w.__debugHudText
    return text ? (JSON.parse(text).engineDebug as unknown) : null
  })
  if (!dump) throw new Error('the dump carried no engineDebug (web engine state)')
  const state = dump as {
    eqBands: EngineEq['bands']
    eqPreampDb: number
    eqBypassed: boolean
    convolverActive: boolean
  }
  return {
    bands: state.eqBands,
    preampDb: state.eqPreampDb,
    bypassed: state.eqBypassed,
    convolver: state.convolverActive,
  }
}

/** Both readings, compared: the engine applies exactly the values the controls
 *  show. The one assertion every EQ transition has to pass. */
export async function expectEngineMatchesControls(page: Page): Promise<EngineEq> {
  const ui = await readUiEq(page)
  const engine = await readEngineEq(page)
  expect(engine.bands.map((b) => b.gain), 'engine band gains == slider values').toEqual(ui.gains)
  expect(engine.preampDb, 'engine preamp == preamp slider').toBe(ui.preampDb)
  return engine
}
