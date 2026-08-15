import { test, expect } from '@playwright/test'
import { bootApp } from './boot'

// Boots the production bundle (served by the webServer in playwright.config.ts)
// and asserts the app mounts and finishes its async init with no console
// errors and no uncaught exceptions. Complements the Node suites: they run
// source ESM (where a module-eval cycle throws a TDZ ReferenceError), while
// this exercises the bundled output (where such a cycle resolves to
// `undefined` and only fails at runtime).

test('app mounts and boots with no console errors', async ({ page }) => {
  // The header search input renders as soon as the Svelte shell is mounted —
  // an early signal that the bundle evaluated — checked before the async boot
  // chain (initStores → initEqStore → taglib wasm → playbackManager.init)
  // finishes, which `data-app-ready` marks.
  await bootApp(page, {
    beforeReady: async () => {
      await expect(page.locator('input[placeholder^="Fuzzy Search"]')).toBeVisible()
    },
  })
})
