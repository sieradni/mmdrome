import { test, expect } from '@playwright/test'
import { bootSongLibrary } from './thumbflowHelpers'

test('shuffle plays every eligible song before recycling and keeps the active row at the boundary', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const size = 8
  await bootSongLibrary(page, Array.from({ length: size }, (_, i) => ({
    id: `continuation-${i}`, title: `Continuation ${i}`, artist: 'Test Artist', album: 'Test Album',
    duration: 180, track: i + 1, suffix: 'mp3', bitRate: 320, size: 8000000,
    albumId: 'continuation-album', path: `Music/Test/Track ${i}.mp3`,
  })))
  await page.locator('[data-track-id]').first().click()
  const mini = page.locator('div.ui-island[role="button"]').first()
  await expect(mini).toContainText('Continuation')
  await mini.click()
  await page.getByRole('button', { name: 'Toggle shuffle' }).click()
  await page.getByRole('button', { name: 'Close player' }).click()
  // Read the real persisted queue rather than a private app-store hook.
  const queueState = () => page.evaluate(async () => {
    const names = await indexedDB.databases()
    const name = names.find(db => db.name?.includes('mmdrome'))?.name
    if (!name) throw new Error('app database not found')
    return new Promise<{ userQueue: string[]; autoQueue: string[]; activeIndex: number }>((resolve, reject) => {
      const open = indexedDB.open(name)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const request = db.transaction('playQueue').objectStore('playQueue').getAll()
        request.onerror = () => { db.close(); reject(request.error) }
        request.onsuccess = () => { db.close(); resolve(request.result[0]) }
      }
    })
  })
  const first = await queueState()
  const heard = new Set([first.userQueue[first.activeIndex]])
  const next = page.locator('div[role="button"]', { has: page.getByRole('button', { name: 'Next track' }) }).getByRole('button', { name: 'Next track' })
  for (let step = 0; step < size * 2; step++) {
    const before = await queueState()
    const target = before.autoQueue[0]
    expect(target).toBeTruthy()
    if (heard.size < size) expect(heard.has(target), `premature repeat at ${step}`).toBe(false)
    await next.click()
    await expect.poll(async () => {
      const q = await queueState()
      return q.userQueue[q.activeIndex]
    }).toBe(target)
    const after = await queueState()
    expect(after.activeIndex).toBe(after.userQueue.length - 1)
    expect(new Set(after.userQueue).size).toBe(after.userQueue.length)
    if (before.autoQueue[1]) expect(after.autoQueue[0]).toBe(before.autoQueue[1])
    heard.add(target)
  }
  expect(heard.size).toBe(size)
  expect(errors).toEqual([])
})
