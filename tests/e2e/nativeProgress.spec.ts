import { test, expect } from '@playwright/test'
import { build } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

let directory: string
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mmdrome-native-progress-'))
  await build({ configFile: false, plugins: [svelte()],
    resolve: { conditions: ['browser'], alias: { $lib: resolve('src/lib') } },
    build: { outDir: directory, minify: false,
      lib: { entry: resolve('tests/e2e/nativeProgressHarness.ts'), formats: ['es'], fileName: () => 'probe.js' } } })
})
test.afterAll(async () => {
  if (!directory) return
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !basename(directory).startsWith('mmdrome-native-progress-')) {
    throw new Error('Refusing cleanup outside the temporary probe directory')
  }
  await rm(directory, { recursive: true, force: true })
})

test('native percentage-first events fill the actual SeekBar before completion', async ({ page }) => {
  await page.route('**/native-progress-probe', (route) => route.fulfill({
    contentType: 'text/html', body: '<html><body><script type="module" src="/native-progress-probe.js"></script></body></html>',
  }))
  await page.route('**/native-progress-probe.js', async (route) => route.fulfill({
    contentType: 'text/javascript', body: await readFile(join(directory, 'probe.js'), 'utf8'),
  }))
  await page.goto('/native-progress-probe')
  const loaded = page.getByTestId('seek-loaded')
  for (const progress of [0.1, 0.5, 0.9]) {
    await page.evaluate((progress) => {
      (window as unknown as { emitNativeProgress: (e: unknown) => void }).emitNativeProgress({ trackId: 'active', state: 'progress', progress })
    }, progress)
    await expect(loaded).toHaveAttribute('style', `width: ${progress * 100}%;`)
  }
  await page.evaluate(() => {
    const emit = (window as unknown as { emitNativeProgress: (e: unknown) => void }).emitNativeProgress
    emit({ trackId: 'active', state: 'done' })
    emit({ trackId: 'active', state: 'progress', progress: 0.2 })
  })
  await expect(loaded).toHaveAttribute('style', 'width: 100%;')
})
