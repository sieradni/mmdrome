import { test, expect, type Locator, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// The custom context menu in the REAL bundle (2026-11-04). Pins the three
// input paths (right-click, touch long-press, Shift+F10), the shared menu
// primitive (placement, keyboard traversal, focus return, dismissal), and the
// commands reaching the same code the row buttons use: queue insertion,
// row-scoped removal, whole-album enqueue, and the single feedback commit path.
//
// The two GESTURE contracts (2026-11-07) are pinned on the element a finger
// actually hits, never the wrapper: a long press opens the menu from the row's
// own play <button> (and from a queue row's), holds past any fixed window still
// swallow their release click, an outside press swallows rather than
// click-through, and a control that owns its long press (mini player transport)
// still keeps it.

async function bootWithMockLibrary(page: Page): Promise<void> {
  await installNavidromeMock(page)
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await expect(page.locator('[data-track-id]').first()).toBeVisible({ timeout: 15_000 })
}

/** Library rows only — the queue overlay renders its own [data-track-id] rows. */
const rows = (page: Page) => page.locator('main [data-track-id]')
const menu = (page: Page) => page.getByRole('menu', { name: 'Track actions' })

async function openQueue(page: Page): Promise<void> {
  await page.locator('div.ui-island[role="button"]').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
}

test('right-click opens the track menu and Add to queue queues that track', async ({ page }) => {
  await bootWithMockLibrary(page)
  await expect(rows(page)).toHaveCount(3)

  await rows(page).first().click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  // A library row offers the play/program commands, not row-scoped queue ones.
  await expect(menu(page).getByRole('menuitem', { name: 'Play now' })).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: 'Play next' })).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: 'Remove from queue' })).toHaveCount(0)

  await menu(page).getByRole('menuitem', { name: 'Add to queue' }).click()
  await expect(menu(page)).toHaveCount(0)

  await openQueue(page)
  const userRows = page.locator('[aria-label="User queue"] [data-entry-id]')
  await expect(userRows).toHaveCount(1)
  await expect(userRows.first()).toContainText('Midnight Drive')
})

test('keyboard: Shift+F10 opens, arrows move, Escape closes and returns focus', async ({ page }) => {
  await bootWithMockLibrary(page)
  const first = rows(page).first()
  await first.focus()
  await page.keyboard.press('Shift+F10')

  await expect(menu(page)).toBeVisible()
  // Focus starts on the first command and roving traversal moves it. `select`
  // is the multi-select entry point and sits directly under Play.
  await expect(menu(page)).toHaveAttribute('aria-activedescendant', 'ctx-menu-root-play')
  await page.keyboard.press('ArrowDown')
  await expect(menu(page)).toHaveAttribute('aria-activedescendant', 'ctx-menu-root-select')
  await page.keyboard.press('ArrowDown')
  await expect(menu(page)).toHaveAttribute('aria-activedescendant', 'ctx-menu-root-playNext')
  await page.keyboard.press('Home')
  await expect(menu(page)).toHaveAttribute('aria-activedescendant', 'ctx-menu-root-play')

  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(first).toBeFocused()
})

const touchHold = (pointerId: number, point: { clientX: number; clientY: number }) => ({
  pointerType: 'touch',
  pointerId,
  isPrimary: true,
  button: 0,
  bubbles: true,
  ...point,
})

const playTarget = (page: Page, index = 0) => rows(page).nth(index).locator('button').first()

/** The click a browser generates from a pointer release. Playwright's
 *  `dispatchEvent('click')` defaults to `detail: 0`, the same shape as a
 *  keyboard/AT/programmatic activation — which the app deliberately never
 *  swallows — so a trailing-click case has to look like a real pointer click. */
const releaseClick = (target: Locator) =>
  target.dispatchEvent('click', { bubbles: true, detail: 1 })

/** A touch long press on the element a finger lands on. It deliberately does
 *  NOT deliver the release click: several cases need the swallow still armed
 *  afterwards, which is what a browser that suppresses the click after a
 *  long-press callout leaves behind (iOS). */
async function longPress(page: Page, target: Locator, pointerId: number): Promise<void> {
  const box = await target.boundingBox()
  expect(box).not.toBeNull()
  const point = { clientX: box!.x + 20, clientY: box!.y + 12 }
  await target.dispatchEvent('pointerdown', touchHold(pointerId, point))
  await expect(menu(page)).toBeVisible({ timeout: 3000 })
  await target.dispatchEvent('pointerup', touchHold(pointerId, point))
}

test('touch long-press opens the menu from the row itself and swallows the trailing click', async ({ page }) => {
  await bootWithMockLibrary(page)
  const row = rows(page).first()
  // The finger lands on the row's play <button>, which covers almost the whole
  // row — not on the wrapper the trigger is mounted on. Dispatching on the
  // wrapper would pass while a real phone long-press was a dead zone.
  const play = row.locator('button').first()
  const box = await play.boundingBox()
  expect(box).not.toBeNull()
  const point = { clientX: box!.x + 30, clientY: box!.y + 12 }

  await play.dispatchEvent('pointerdown', touchHold(1, point))
  await expect(menu(page)).toBeVisible({ timeout: 3000 })

  // Lift the finger and deliver the synthetic click mobile browsers emit after
  // a long press: it must not press the row (play it) behind the open menu.
  await play.dispatchEvent('pointerup', touchHold(1, point))
  await releaseClick(play)
  await expect(menu(page)).toBeVisible()
  // Wait past the click's dispatch before claiming the absence of playback:
  // the state could otherwise flip after the assertion already passed.
  await page.waitForTimeout(200)
  await expect(page.getByText('Not playing')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
})

test('a long press swallows only its own click: choosing a command still runs it', async ({ page }) => {
  await bootWithMockLibrary(page)
  const play = rows(page).first().locator('button').first()
  const box = await play.boundingBox()
  expect(box).not.toBeNull()
  const point = { clientX: box!.x + 30, clientY: box!.y + 12 }

  await play.dispatchEvent('pointerdown', touchHold(5, point))
  await expect(menu(page)).toBeVisible({ timeout: 3000 })
  await play.dispatchEvent('pointerup', touchHold(5, point))
  await releaseClick(play)

  // The menu's own tap is a NEW gesture: the swallow must have disarmed, or
  // every command would be dead after a long-press opening.
  await menu(page).getByRole('menuitem', { name: 'Play now' }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(page.getByTestId('mini-player')).toContainText('Midnight Drive')
})

test('a long hold past the old fixed window still swallows its release click', async ({ page }) => {
  await bootWithMockLibrary(page)
  const row = rows(page).nth(1)
  const play = row.locator('button').first()
  const box = await play.boundingBox()
  expect(box).not.toBeNull()
  const point = { clientX: box!.x + 30, clientY: box!.y + 12 }

  await play.dispatchEvent('pointerdown', touchHold(2, point))
  await expect(menu(page)).toBeVisible({ timeout: 3000 })
  // The menu opened at 500 ms; the old suppression expired 700 ms after that,
  // so a hold this long used to leak the click and play the row.
  await page.waitForTimeout(1400)

  await play.dispatchEvent('pointerup', touchHold(2, point))
  await releaseClick(play)
  await expect(menu(page)).toBeVisible()
  await page.waitForTimeout(200)
  await expect(page.getByText('Not playing')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
})

test('a press outside the menu dismisses it and is not click-through', async ({ page }) => {
  await bootWithMockLibrary(page)

  // A control far from the panel: the press must only dismiss.
  await rows(page).first().click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(page.locator('[data-album]')).toHaveCount(0)
  await expect(rows(page).first()).toBeVisible()

  // Another row's action button: the menu must not queue behind the press.
  await rows(page).first().click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.getByRole('button', { name: 'Add to queue' }).nth(2).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(page.getByTestId('mini-player')).toContainText('Queue is empty')
})

test('queue rows open their menu from the play target too', async ({ page }) => {
  await bootWithMockLibrary(page)
  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  await addButtons.nth(0).click()
  await addButtons.nth(1).click()
  await openQueue(page)

  const inner = page.locator('[aria-label="User queue"] [data-entry-id]').first().locator('button').first()
  const box = await inner.boundingBox()
  expect(box).not.toBeNull()
  const point = { clientX: box!.x + 25, clientY: box!.y + 10 }

  await inner.dispatchEvent('pointerdown', touchHold(3, point))
  await expect(menu(page)).toBeVisible({ timeout: 3000 })
  await expect(menu(page).getByRole('menuitem', { name: 'Remove from queue' })).toBeVisible()

  await inner.dispatchEvent('pointerup', touchHold(3, point))
  await releaseClick(inner)
  // The release click must not press the queue row behind the menu.
  await page.waitForTimeout(200)
  await expect(page.getByTestId('mini-player')).toContainText('Not playing')
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
})

test('a control that owns its own long press keeps it: mini player transport', async ({ page }) => {
  await bootWithMockLibrary(page)
  await rows(page).first().click()
  await expect(page.getByTestId('mini-player')).toContainText('Midnight Drive')

  // `getByRole` name matching is substring-based, so the island wrapper's
  // composed name ("Midnight Drive … Previous track Play / Pause Next track")
  // also matches — `exact` is what selects the transport control itself.
  const playPause = page.getByTestId('mini-player').getByRole('button', { name: 'Play / Pause', exact: true })
  const box = await playPause.boundingBox()
  expect(box).not.toBeNull()
  const point = { clientX: box!.x + 4, clientY: box!.y + 4 }

  await playPause.dispatchEvent('pointerdown', touchHold(4, point))
  await page.waitForTimeout(900)
  await expect(menu(page)).toHaveCount(0)
  await playPause.dispatchEvent('pointerup', touchHold(4, point))
})

test('rating submenu writes through feedback and reflects the stored value', async ({ page }) => {
  await bootWithMockLibrary(page)
  await rows(page).first().click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Rating' }).click()

  const submenu = page.getByRole('menu', { name: 'Rating' })
  await expect(submenu).toBeVisible()
  await submenu.getByRole('menuitemcheckbox', { name: 'Set rating to 80' }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(submenu).toHaveCount(0)

  // Re-open: the checked state comes from the metadata cache the commit wrote.
  await rows(page).first().click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Rating' }).click()
  await expect(
    page.getByRole('menu', { name: 'Rating' }).getByRole('menuitemcheckbox', { name: 'Set rating to 80' }),
  ).toHaveAttribute('aria-checked', 'true')
})

test('queue row menu removes exactly the pressed row', async ({ page }) => {
  await bootWithMockLibrary(page)
  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  await addButtons.nth(0).click()
  await addButtons.nth(1).click()

  await openQueue(page)
  const userRows = page.locator('[aria-label="User queue"] [data-entry-id]')
  await expect(userRows).toHaveCount(2)

  await userRows.first().click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: 'Move to next' })).toBeVisible()
  await menu(page).getByRole('menuitem', { name: 'Remove from queue' }).click()

  await expect(userRows).toHaveCount(1)
})

test('album cell menu queues the whole album', async ({ page }) => {
  await bootWithMockLibrary(page)
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
  const cell = page.locator('[data-album="Nightdrive"]')
  await expect(cell).toBeVisible()

  await cell.click({ button: 'right' })
  const albumMenu = page.getByRole('menu', { name: 'Album actions' })
  await expect(albumMenu).toBeVisible()
  await expect(albumMenu.getByRole('menuitem', { name: 'Play album' })).toBeVisible()
  await albumMenu.getByRole('menuitem', { name: 'Add to queue' }).click()

  await openQueue(page)
  await expect(page.locator('[aria-label="User queue"] [data-entry-id]')).toHaveCount(2)
})

test('player surfaces: the mini player and Now Playing open the current track menu', async ({ page }) => {
  await bootWithMockLibrary(page)
  const mini = page.getByTestId('mini-player')
  await expect(mini).toContainText('Not playing')
  // Nothing to target: the trigger is disabled, so no empty custom menu opens.
  await mini.click({ button: 'right' })
  await expect(menu(page)).toHaveCount(0)

  await rows(page).first().click()
  await expect(mini).toContainText('Midnight Drive')

  await mini.click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: /^(Play now|Restart|Resume)$/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  // A plain tap still reaches the player: only a long press swallows its click.
  await mini.click()
  await expect(page.getByTestId('now-playing-track')).toBeVisible()

  await page.getByTestId('now-playing-track').click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await menu(page).getByRole('menuitem', { name: 'Details' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('keyboard and programmatic activation are never swallowed', async ({ page }) => {
  await bootWithMockLibrary(page)
  const albums = page.getByRole('button', { name: 'Albums', exact: true })
  const songs = page.getByRole('button', { name: 'Songs', exact: true })

  // Keyboard open → Escape → the next control still activates normally.
  await rows(page).first().focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await albums.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-album]').first()).toBeVisible()

  // Leave the pointer swallow ARMED the way iOS can (the long press opens the
  // menu, the release produces no click at all), then activate by KEYBOARD.
  await songs.click()
  await expect(rows(page).first()).toBeVisible()
  await longPress(page, playTarget(page), 6)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await albums.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-album]').first()).toBeVisible()

  // Same armed state, activated PROGRAMMATICALLY this time.
  await songs.click()
  await expect(rows(page).first()).toBeVisible()
  await longPress(page, playTarget(page), 7)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await albums.evaluate((el) => (el as HTMLElement).click())
  await expect(page.locator('[data-album]').first()).toBeVisible()
})

test('right-click still opens the surface menu over the opted-out controls', async ({ page }) => {
  await bootWithMockLibrary(page)

  // The mini player transport opts out of the LONG PRESS only; the island's
  // right-click menu is unchanged.
  await rows(page).first().click()
  await expect(page.getByTestId('mini-player')).toContainText('Midnight Drive')
  await page
    .getByTestId('mini-player')
    .getByRole('button', { name: 'Play / Pause', exact: true })
    .click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  // The queue drag handle keeps its pointer gesture, not its menu: the row's
  // menu still opens on a right-click over it.
  await page.getByRole('button', { name: 'Add to queue' }).first().click()
  await openQueue(page)
  const handle = page
    .locator('[aria-label="User queue"] [data-entry-id]')
    .first()
    .locator('[data-no-context-menu]')
  await handle.click({ button: 'right' })
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('menuitem', { name: 'Move to next' })).toBeVisible()
})

test('a swallowed outside tap leaves the very next tap working', async ({ page }) => {
  await bootWithMockLibrary(page)
  const albums = page.getByRole('button', { name: 'Albums', exact: true })

  await rows(page).first().click({ button: 'right' })
  await expect(menu(page)).toBeVisible()

  // First tap: dismissal only, nothing underneath runs.
  await albums.click()
  await expect(menu(page)).toHaveCount(0)
  await expect(page.locator('[data-album]')).toHaveCount(0)

  // The immediate next tap on the SAME control is a fresh gesture.
  await albums.click()
  await expect(page.locator('[data-album]').first()).toBeVisible()
})

test('two consecutive long presses both open the menu', async ({ page }) => {
  await bootWithMockLibrary(page)
  const first = playTarget(page)
  await longPress(page, first, 9)
  await releaseClick(first)
  await page.waitForTimeout(200)
  await expect(page.getByText('Not playing')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  // The second gesture targets another row and must open its own request.
  const second = playTarget(page, 1)
  await longPress(page, second, 10)
  await expect(menu(page).getByText('Golden Hour')).toBeVisible()
  await releaseClick(second)
  await page.waitForTimeout(200)
  await expect(page.getByText('Not playing')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('the swallow never survives a fresh primary pointerdown', async ({ page }) => {
  await bootWithMockLibrary(page)
  // Long press, then lift WITHOUT the click a browser may skip: the swallow is
  // still armed when the menu is dismissed with Escape.
  await longPress(page, playTarget(page), 11)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  // A normal click is a new primary pointerdown: it disarms, then acts.
  await playTarget(page, 1).click()
  await expect(page.getByTestId('mini-player')).toContainText('Golden Hour')
})

test('album detail header opens the same album menu as its grid cell', async ({ page }) => {
  await bootWithMockLibrary(page)
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
  await page.locator('[data-album="Nightdrive"]').click()
  await expect(page.getByRole('button', { name: 'Play all' })).toBeVisible()

  await page.locator('h2').filter({ hasText: 'Nightdrive' }).click({ button: 'right' })
  const albumMenu = page.getByRole('menu', { name: 'Album actions' })
  await expect(albumMenu).toBeVisible()
  await expect(albumMenu.getByRole('menuitem', { name: 'Play album' })).toBeVisible()
  await albumMenu.getByRole('menuitem', { name: 'Add to queue' }).click()

  await openQueue(page)
  await expect(page.locator('[aria-label="User queue"] [data-entry-id]')).toHaveCount(2)
})
