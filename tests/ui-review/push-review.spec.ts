import { test, expect } from '@playwright/test'

for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 800], [1920, 1080]]) {
  test(`push review fits and centers at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.goto('/mmdrome/?uiPreview')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('push-thumbnail')).toHaveCount(3)
    await expect(dialog).toContainText('Radiohead · Kid A')
    await expect(dialog).not.toContainText('Everything In Its Right Place — Radiohead')
    await expect(dialog).toContainText('Updates only rating and loved tags.')
    await expect(dialog).not.toContainText('the audio is not re-encoded')
    await expect(dialog).not.toContainText('not the intended track')
    await expect(dialog).not.toContainText('Previous values are last-probed')
    const thumb = await dialog.getByTestId('push-thumbnail').first().boundingBox()
    expect(thumb!.height).toBe(64)
    expect(thumb!.width).toBe(64)
    const images = dialog.getByTestId('push-thumbnail').locator('img')
    await expect(images).toHaveCount(2)
    await expect.poll(() => images.evaluateAll((nodes) => nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0))).toBe(true)
    const rect = await dialog.boundingBox()
    expect(rect).not.toBeNull()
    expect(rect!.x).toBeGreaterThanOrEqual(15)
    expect(rect!.y).toBeGreaterThanOrEqual(15)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width - 15)
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(height - 15)
    // The pane is HEIGHT-CAPPED, not merely fit-checked: on iOS a
    // `100dvh`-tall confirm pane runs under the notch / home indicator /
    // Safari's bottom bar (its footer became unreachable) and leaves no
    // backdrop to tap. 80dvh keeps a slice of the screen it covers visible
    // above and below.
    expect(rect!.height).toBeLessThanOrEqual(height * 0.8 + 1)
    // No border and no outline: iOS Safari paints its own focus ring around
    // the focused dialog, which read as an unremovable colored border.
    await expect(dialog).toHaveCSS('border-top-width', '0px')
    await expect(dialog).toHaveCSS('outline-style', 'none')
    // Row art + title are the detail-view target (same as the library rows).
    await expect(dialog.getByTestId('push-title-button')).toHaveCount(3)
    await expect(dialog.getByTestId('push-thumbnail-button')).toHaveCount(3)
    await expect(dialog.getByRole('button', { name: 'Show details for Reckoner', exact: true })).toBeVisible()
    expect(Math.abs(rect!.x + rect!.width / 2 - width / 2)).toBeLessThan(2)
    expect(Math.abs(rect!.y + rect!.height / 2 - height / 2)).toBeLessThan(2)
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await expect(page.getByRole('button', { name: 'Write to files (demo)' })).toBeDisabled()
    await page.getByRole('button', { name: 'Close preview' }).click()
    await expect(dialog).toHaveCount(0)
    const opener = page.getByRole('button', { name: 'Review push changes' })
    await opener.click()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(opener).toBeFocused()
    await opener.click()
    await page.mouse.click(4, 4)
    await expect(dialog).toHaveCount(0)
    // …and the strips ABOVE and BELOW the pane are real, tappable backdrop
    // (the capped height is what keeps them reachable on a phone).
    await opener.click()
    const above = (await dialog.boundingBox())!
    expect(above.height).toBeGreaterThan(0)
    await page.mouse.click(width / 2, above.y / 2)
    await expect(dialog).toHaveCount(0)
    await opener.click()
    const below = (await dialog.boundingBox())!
    await page.mouse.click(width / 2, (below.y + below.height + height) / 2)
    await expect(dialog).toHaveCount(0)
  })
}

test('review rows explain real edits and support keep/discard without writes', async ({ page }) => {
  const writes: string[] = []
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url())
  })
  await page.goto('/mmdrome/?uiPreview')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('3 files will be updated')
  await expect(dialog).not.toContainText('New discovery')
  await expect(dialog).toContainText('★ 40 → 80')
  await expect(dialog.getByTestId('push-rating-icon').first()).toHaveCSS('color', 'rgb(250, 204, 21)')
  await expect(dialog.getByTestId('push-loved-icon').first()).toHaveClass('text-red-400')
  expect(await dialog.getByTestId('push-loved-icon').first().evaluate((node) => getComputedStyle(node).color)).not.toBe(await dialog.getByTestId('push-diff-loved-one').evaluate((node) => getComputedStyle(node).color))
  await page.getByRole('button', { name: 'Discard pending edit for Reckoner' }).click()
  await page.getByRole('button', { name: 'Keep', exact: true }).click()
  await expect(dialog).toContainText('Reckoner')
  await page.getByRole('button', { name: 'Discard pending edit for Reckoner' }).click()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(dialog).toContainText('2 files will be updated')
  await expect(dialog).not.toContainText('Reckoner')
  await page.getByRole('button', { name: 'Close preview' }).click()
  await page.getByRole('combobox').selectOption('idle')
  await expect(page.getByRole('button', { name: /Scanning file tags/ })).toHaveCount(0)
  const info = page.getByRole('button', { name: 'About this preview' })
  await info.hover()
  await expect(page.getByRole('tooltip')).toHaveText('About this preview')
  await info.click()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  expect(writes).toEqual([])
})
