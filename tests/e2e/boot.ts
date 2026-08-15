import { expect, type Page } from '@playwright/test'

/**
 * Boots the production bundle and races the app's deterministic
 * `data-app-ready` signal against any captured console/page error, so a boot
 * failure fails fast with its real message instead of a generic timeout.
 * Extracted from the three specs that used to each carry their own copy — the
 * error-racing subtlety (settling the rejection promise so a late error can't
 * become an unhandled rejection) is easy to get wrong when duplicated.
 */
export async function bootApp(page: Page, opts: { beforeReady?: () => Promise<void> } = {}): Promise<void> {
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
  if (opts.beforeReady) await opts.beforeReady()

  await Promise.race([
    expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 }),
    firstError,
  ])
  expect(errors, 'app boot produced console errors').toEqual([])
}
