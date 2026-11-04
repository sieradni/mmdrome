import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// The custom context menu in the REAL bundle (2026-11-04). Pins the three
// input paths (right-click, touch long-press, Shift+F10), the shared menu
// primitive (placement, keyboard traversal, focus return, dismissal), and the
// commands reaching the same code the row buttons use: queue insertion,
// row-scoped removal, whole-album enqueue, and the single feedback commit path.

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
  // Focus starts on the first command and roving traversal moves it.
  await expect(menu(page)).toHaveAttribute('aria-activedescendant', 'ctx-menu-root-play')
  await page.keyboard.press('ArrowDown')
  await expect(menu(page)).toHaveAttribute('aria-activedescendant', 'ctx-menu-root-playNext')
  await page.keyboard.press('Home')
  await expect(menu(page)).toHaveAttribute('aria-activedescendant', 'ctx-menu-root-play')

  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(first).toBeFocused()
})

test('touch long-press opens the menu and swallows the trailing click', async ({ page }) => {
  await bootWithMockLibrary(page)
  const row = rows(page).first()
  const box = await row.boundingBox()
  expect(box).not.toBeNull()
  const point = { clientX: box!.x + 40, clientY: box!.y + 20 }

  await row.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
    button: 0,
    bubbles: true,
    ...point,
  })
  await expect(menu(page)).toBeVisible({ timeout: 3000 })

  // Lift the finger and deliver the synthetic click mobile browsers emit after
  // a long press: it must not press the row (play it) behind the open menu.
  await row.dispatchEvent('pointerup', {
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
    button: 0,
    bubbles: true,
    ...point,
  })
  await row.dispatchEvent('click', { bubbles: true })
  await expect(menu(page)).toBeVisible()
  await expect(page.getByText('Not playing')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
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
