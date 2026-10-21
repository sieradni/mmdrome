import { test, expect } from '@playwright/test'

test('push dialog supports keyboard navigation and clear accessible changes', async ({ page }) => {
  await page.goto('/mmdrome/?uiPreview')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeFocused()
  await expect(dialog).toHaveAccessibleDescription(/Updates only rating and loved tags/)
  await expect(dialog.getByRole('img', { name: 'Rating: 60 to 100 out of 100', exact: true })).toBeVisible()
  await expect(dialog.getByRole('img', { name: 'Loved: not loved to loved', exact: true })).toBeVisible()
  const discard = dialog.getByRole('button', { name: /Discard pending edit/ }).first()
  const rect = await discard.boundingBox()
  expect(rect!.width).toBe(32)
  expect(rect!.height).toBe(32)
  // Row stops first: art and title open the details view, then the × discard.
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Show details for Everything In Its Right Place', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Everything In Its Right Place', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(discard).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(discard).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(dialog).toBeFocused()
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('push controls remain usable with enlarged text on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/mmdrome/?uiPreview')
  await page.addStyleTag({ content: 'html { font-size: 32px !important; }' })
  const dialog = page.getByRole('dialog')
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await dialog.getByRole('button', { name: /Discard pending edit/ }).first().click()
  for (const name of ['Discard', 'Keep', 'Close preview']) {
    const button = dialog.getByRole('button', { name, exact: true })
    await button.scrollIntoViewIfNeeded()
    const rect = await button.boundingBox()
    expect(rect!.height).toBeGreaterThanOrEqual(44)
    expect(rect!.x).toBeGreaterThanOrEqual(0)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(390)
  }
})
