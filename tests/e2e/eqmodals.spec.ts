import { test, expect, type Page } from '@playwright/test'
import { bootSongLibrary } from './thumbflowHelpers'
import { EQ_SONG, openEqualizerFromSettings } from './eqHelpers'

// The EQ dialogs used to be a second, hand-rolled modal: a `fixed inset-0 z-50`
// overlay with `role="dialog" aria-modal="true"`. The attribute was untrue in
// practice — the audit measured focus still on the trigger OUTSIDE it and 42
// background buttons still tabbable — because nothing but a native `<dialog>`
// opened with showModal() actually contains focus and inerts the background.
// They now render through ModalShell (the app's one modal primitive).
//
// These are the audit's own measurements on the built bundle: after opening a
// dialog the active element is inside it, no background control can take focus,
// Tab never escapes, and closing returns focus to the button that opened it.

/** What the audit measured, taken from the live page. */
async function modalProbe(page: Page) {
  return page.evaluate(() => {
    const modal = document.querySelector('dialog:modal')
    const active = document.activeElement
    if (!modal) return { modalDialogs: 0, focusInside: false, backgroundFocusable: -1 }
    // Inertness is UA-level (no attribute to read), so probe it the way a user
    // would: try to focus each visible background control and see if it takes.
    let backgroundFocusable = 0
    const candidates = document.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
    )
    for (const el of candidates) {
      if (modal.contains(el) || el.getClientRects().length === 0) continue
      el.focus()
      if (document.activeElement === el) backgroundFocusable++
    }
    ;(modal as HTMLElement).focus()
    return {
      modalDialogs: document.querySelectorAll('dialog:modal').length,
      focusInside: Boolean(active && modal.contains(active)),
      backgroundFocusable,
    }
  })
}

test('the band editor is a real modal: focus enters, the background is inert, focus returns to the trigger', async ({ page }) => {
  await bootSongLibrary(page, EQ_SONG)
  await openEqualizerFromSettings(page)

  const trigger = page.getByRole('button', { name: '1k', exact: true })
  await trigger.click()
  await expect(page.getByRole('dialog', { name: 'Band · 1k Hz' })).toBeVisible()

  const probe = await modalProbe(page)
  expect(probe.modalDialogs, 'one native modal dialog').toBe(1)
  expect(probe.focusInside, 'focus starts inside the dialog').toBe(true)
  expect(probe.backgroundFocusable, 'no control behind the dialog can take focus').toBe(0)

  // Tab can never reach the EQ behind it.
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('Tab')
    expect((await modalProbe(page)).focusInside, `focus escaped after ${i + 1} tabs`).toBe(true)
  }

  // Escape closes it and hands focus back to the button that opened it.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('a graph-dot band editor is a real modal too, and hands focus back to the dot (SVG trigger)', async ({ page }) => {
  await bootSongLibrary(page, EQ_SONG)
  await openEqualizerFromSettings(page)

  // The dot is the PRIMARY way into the band editor and it is an SVG
  // `<g tabindex="0">`, not a button: a pointer tap does not focus it by
  // itself, and ModalShell's old `instanceof HTMLElement` guard refused to
  // hand focus back to it — closing the editor dropped focus on <body>.
  const dot = page.locator('svg g[data-eq-handle][aria-label^="Parametric band 2k Hz"]')
  await dot.click()
  await expect(page.getByRole('dialog', { name: 'Band · 2k Hz' })).toBeVisible()

  const probe = await modalProbe(page)
  expect(probe.modalDialogs, 'one native modal dialog').toBe(1)
  expect(probe.focusInside, 'focus starts inside the dialog').toBe(true)
  expect(probe.backgroundFocusable, 'no control behind the dialog can take focus').toBe(0)

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(dot, 'focus returns to the SVG dot that opened it').toBeFocused()
})

test('the four EQ dialogs still work end to end on the shared shell', async ({ page }) => {
  await bootSongLibrary(page, EQ_SONG)
  await openEqualizerFromSettings(page)

  // 1. Band editor.
  await page.getByRole('button', { name: '1k', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Band · 1k Hz' })
  await editor.getByRole('button', { name: '+6', exact: true }).click()
  await editor.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('slider', { name: '1k Hz band' })).toHaveAttribute('aria-valuenow', '6')

  // 2. Add band: the dialog's own Add inserts a band and opens its editor.
  const bandCount = await page.getByRole('slider', { name: /Hz band/ }).count()
  await page.getByRole('button', { name: '+ Add Band' }).click()
  await page.getByRole('dialog', { name: 'Add band' }).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /^Band ·/ })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('slider', { name: /Hz band/ })).toHaveCount(bandCount + 1)

  // 3. Save.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const save = page.getByRole('dialog', { name: 'Save preset' })
  await save.getByPlaceholder('New preset name…').fill('Modal Probe')
  await save.getByRole('button', { name: 'Save as New' }).click()
  await expect(page.locator('[data-eq-preset-select]')).toHaveValue(/^user_/)

  // 4. Unsaved changes: an edit then a preset switch asks first.
  await page.getByRole('button', { name: '2k', exact: true }).click()
  await page.getByRole('button', { name: '+3', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await page.locator('[data-eq-preset-select]').selectOption('bass_boost')

  const switchDialog = page.getByRole('dialog', { name: 'Unsaved changes' })
  await expect(switchDialog).toBeVisible()
  await switchDialog.getByRole('button', { name: /Keep editing/ }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(
    page.locator('[data-eq-preset-select]'),
    'Keep leaves the selection on the edited preset'
  ).toHaveValue(/^user_/)
})

test('the import panel is inline, not a dialog, and still applies above the shell rewrite', async ({ page }) => {
  await bootSongLibrary(page, EQ_SONG)
  await openEqualizerFromSettings(page)

  await page.getByRole('button', { name: 'Import' }).click()
  await page
    .getByPlaceholder(/Paste AutoEQ/)
    .fill('Preamp: -4 dB\nFilter 1: ON PK Fc 1000 Hz Gain 6 dB Q 0.7')
  await page.getByRole('button', { name: 'Apply' }).click()

  // A clean paste closes the panel; nothing was turned into a dialog.
  await expect(page.getByRole('button', { name: 'Import' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('slider', { name: '1k Hz band' })).toHaveAttribute('aria-valuenow', '6')
})
