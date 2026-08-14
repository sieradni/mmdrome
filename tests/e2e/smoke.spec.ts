import { test, expect } from '@playwright/test'

// Boots the production bundle (served by the webServer in playwright.config.ts)
// and asserts the app mounts and finishes its async init with no console
// errors and no uncaught exceptions. Complements the Node suites: they run
// source ESM (where a module-eval cycle throws a TDZ ReferenceError), while
// this exercises the bundled output (where such a cycle resolves to
// `undefined` and only fails at runtime).

test('app mounts and boots with no console errors', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

  await page.goto('/mmdrome/', { waitUntil: 'networkidle' })

  // The header search input only renders once the Svelte shell is mounted.
  await expect(page.locator('input[placeholder^="Fuzzy Search"]')).toBeVisible()

  // Let the async boot chain settle (initStores → initEqStore → taglib wasm →
  // playbackManager.init) so late unhandled rejections surface before the
  // clean-console assertion.
  await page.waitForTimeout(1500)

  expect(errors, 'app boot produced console errors').toEqual([])
})
