import { test, expect } from '@playwright/test'

// Boots the production bundle (served by the webServer in playwright.config.ts)
// and asserts the app mounts and finishes its async init with no console
// errors and no uncaught exceptions. Complements the Node suites: they run
// source ESM (where a module-eval cycle throws a TDZ ReferenceError), while
// this exercises the bundled output (where such a cycle resolves to
// `undefined` and only fails at runtime).

test('app mounts and boots with no console errors', async ({ page }) => {
  const errors: string[] = []
  let onFirstError: (err: Error) => void = () => {}
  const firstError = new Promise<never>((_resolve, reject) => {
    onFirstError = reject
  })
  // A rejection after the race below has already settled on "ready" must not
  // surface as an unhandled rejection.
  void firstError.catch(() => {})

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      errors.push(`console.error: ${text}`)
      onFirstError(new Error(`console.error during boot: ${text}`))
    }
  })
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`)
    onFirstError(new Error(`pageerror during boot: ${err.message}`))
  })

  await page.goto('/mmdrome/', { waitUntil: 'networkidle' })

  // The header search input renders as soon as the Svelte shell is mounted.
  await expect(page.locator('input[placeholder^="Fuzzy Search"]')).toBeVisible()

  // App.svelte sets `data-app-ready` only after onMount's async boot chain
  // (initStores → initEqStore → taglib wasm → playbackManager.init) resolves;
  // on a boot failure it stays absent. Race "ready" against the first
  // captured error so a boot failure fails fast with its real message instead
  // of a generic `[data-app-ready]` timeout.
  await Promise.race([
    expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 }),
    firstError,
  ])

  // A "ready" win can still race a just-fired error — assert the log is clean.
  expect(errors, 'app boot produced console errors').toEqual([])
})
