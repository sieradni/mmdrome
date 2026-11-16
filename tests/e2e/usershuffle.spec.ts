import { test, expect, type Page } from '@playwright/test'
import { bootSongLibrary } from './thumbflowHelpers'

/**
 * The real-surface pin for the USER-QUEUE SHUFFLE (2026-11-14). Everything
 * below the pixels is already pinned by `tests/userQueueShuffle.test.ts`
 * (permutation rules), `tests/userQueueShuffleManager.test.ts` (the switch and
 * the wrap write) and `tests/userQueueShufflePersistence.test.ts` (the saved
 * row). What only a real bundle can prove is the promise the user was given:
 * the pill renders ON the `Up next <n> ———` header row, pressing it reorders
 * the visible list without interrupting playback, and a repeat-all pass that
 * finishes its last song re-enters in a shuffled order.
 *
 * Harness notes (copied from proven specs, no new tooling):
 *  - the queue is read from the REAL persisted `playQueue` row, like
 *    `queueContinuation.spec.ts` — no private app-store hook;
 *  - media elements are `new Audio()` (never in the DOM), so they are
 *    instrumented before any app code runs (`offline-advance.spec.ts`) to prove
 *    the audible track keeps playing across the press;
 *  - the natural end-of-pass needs a track that can actually FINISH: the
 *    default Navidrome mock declares ≈74 h of audio, so scenario 2 serves its
 *    own short WAV through the same `stream.view` route (a truthful header, so
 *    Chromium fires `ended`).
 */

const SONGS = Array.from({ length: 6 }, (_, i) => ({
  id: `ush-${i}`,
  title: `Ush Song ${i}`,
  artist: 'Ush Artist',
  album: 'Ush Album',
  duration: 180,
  track: i + 1,
  suffix: 'mp3',
  bitRate: 320,
  size: 8000000,
  albumId: 'ush-album',
  path: `Music/Ush/Track ${i}.mp3`,
}))

/** Library ids arrive prefixed by the Navidrome mapping (`navidrome-ush-2`). */
const titleOf = (trackId: string): string => {
  const bare = trackId.replace(/^navidrome-/, '')
  return SONGS.find((s) => s.id === bare)?.title ?? bare
}

/** 8 kHz 16-bit mono PCM silence with a TRUTHFUL header: it really ends. */
function makeWav(seconds: number): Buffer {
  const sampleRate = 8000
  const data = Buffer.alloc(seconds * sampleRate * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** Long enough for the setup clicks, short enough to reach a natural end. */
const SHORT_WAV = makeWav(6)

/** Records every media src assignment + the live elements (the engine's a/b
 *  pair is `new Audio()`, so nothing is reachable from the DOM). */
async function instrumentMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __mediaEls: HTMLMediaElement[] }
    w.__mediaEls = []
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      set(v: string) {
        if (!w.__mediaEls.includes(this)) w.__mediaEls.push(this)
        desc.set!.call(this, v)
      },
      get() {
        return desc.get!.call(this)
      },
    })
  })
}

/** The playhead of the element that is actually PLAYING (a paused crossfade
 *  standby must never feed the "still playing" assertion). */
function playingMediaTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const els = (window as unknown as { __mediaEls?: HTMLMediaElement[] }).__mediaEls ?? []
    let t = 0
    for (const el of els) if (!el.paused && el.currentTime > t) t = el.currentTime
    return t
  })
}

type PersistedQueue = { userQueue: string[]; autoQueue: string[]; activeIndex: number }

/** The real persisted queue row (the app's own saveQueue target). */
function persistedQueue(page: Page): Promise<PersistedQueue> {
  return page.evaluate(async () => {
    const names = await indexedDB.databases()
    const name = names.find((d) => d.name?.includes('mmdrome'))?.name
    if (!name) throw new Error('app database not found')
    return new Promise<{ userQueue: string[]; autoQueue: string[]; activeIndex: number }>((resolve, reject) => {
      const open = indexedDB.open(name)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const request = db.transaction('playQueue').objectStore('playQueue').getAll()
        request.onerror = () => { db.close(); reject(request.error) }
        request.onsuccess = () => {
          const row = request.result[0]
          db.close()
          resolve(row ?? { userQueue: [], autoQueue: [], activeIndex: -1 })
        }
      }
    })
  })
}

/** A persisted preference row (`persisted()` writes `{ key, value }`). */
function settingValue<T>(page: Page, key: string): Promise<T | undefined> {
  return page.evaluate(async (k: string) => {
    const names = await indexedDB.databases()
    const name = names.find((d) => d.name?.includes('mmdrome'))?.name
    if (!name) throw new Error('app database not found')
    return new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open(name)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const request = db.transaction('userSettings').objectStore('userSettings').get(k)
        request.onerror = () => { db.close(); reject(request.error) }
        request.onsuccess = () => {
          const row = request.result as { value?: unknown } | undefined
          db.close()
          resolve(row?.value)
        }
      }
    })
  }, key) as Promise<T | undefined>
}

/** The user-queue row order as RENDERED (dom order = the listed order). */
function domUserOrder(page: Page): Promise<string[]> {
  return page.$$eval('[aria-label="User queue"] [data-track-id]', (els) =>
    els.map((el) => el.getAttribute('data-track-id') ?? ''),
  )
}

/** The play target of a user row (the row wrapper itself is not interactive). */
function userRowPlay(page: Page, index: number) {
  return page.locator('[aria-label="User queue"] [data-track-id]').nth(index).locator('button').first()
}

type HeaderLayout = { ruleIndex: number; pillIndex: number; pillInHeader: boolean }

/** Geometry facts about the `Up next` header row: does it carry the pill, and
 *  does the pill sit AFTER the flex-1 rule (the Auto refresh button's slot)? */
function upNextHeaderLayout(page: Page): Promise<HeaderLayout | null> {
  return page.evaluate(() => {
    const header = [...document.querySelectorAll<HTMLElement>('[role="heading"]')].find((h) =>
      (h.textContent ?? '').trim().startsWith('Up next'),
    )
    if (!header) return null
    const kids = [...header.children] as HTMLElement[]
    const ruleIndex = kids.findIndex((k) => k.classList.contains('flex-1') && k.classList.contains('h-0.5'))
    const pill = header.querySelector<HTMLElement>('[data-testid="shuffle-user-queue"]')
    return { ruleIndex, pillIndex: pill ? kids.indexOf(pill) : -1, pillInHeader: pill !== null }
  })
}

async function openQueue(page: Page): Promise<void> {
  await page.getByTestId('mini-player').click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await expect(page.getByRole('button', { name: 'Close queue' })).toBeVisible()
  await page.waitForTimeout(500)
}

test('the shuffle pill sits on the Up next header, is gated on a non-empty queue, and pressing it permutes only the upcoming rows', async ({ page }) => {
  test.setTimeout(120_000)
  await instrumentMedia(page)
  await bootSongLibrary(page, SONGS)
  await page.waitForTimeout(600)

  // ── Gating: with NO user rows the header (and so the pill) does not exist.
  await openQueue(page)
  await expect(page.getByText('Queue is empty')).toBeVisible()
  await expect(page.locator('[data-testid="shuffle-user-queue"]')).toHaveCount(0)
  expect(await upNextHeaderLayout(page), 'no Up next header without user rows').toBeNull()
  await page.getByRole('button', { name: 'Close queue' }).click()
  // The idle mini player opens the QUEUE surface directly (no player overlay),
  // so the player close button may not exist here — only dismiss it if it does.
  const closePlayer = page.getByRole('button', { name: 'Close player' })
  if (await closePlayer.isVisible().catch(() => false)) await closePlayer.click()

  // ── Build a real queue: song 0 plays, four more rows are queued behind it.
  await page.locator('[data-track-id]').first().click()
  await expect(page.getByTestId('mini-player')).toContainText(titleOf('ush-0'))
  const add = page.getByRole('button', { name: 'Add to queue' })
  for (const i of [1, 2, 3, 4]) await add.nth(i).click()
  await expect.poll(async () => (await persistedQueue(page)).userQueue.length).toBe(5)
  await openQueue(page)

  // ── Placement + switch state.
  const layout = await upNextHeaderLayout(page)
  expect(layout, 'the Up next header renders for a non-empty user queue').not.toBeNull()
  expect(layout!.pillInHeader, 'the pill is a child of the Up next header row').toBe(true)
  expect(layout!.ruleIndex, 'the header carries its flex-1 rule').toBeGreaterThanOrEqual(0)
  expect(layout!.pillIndex, 'the pill sits AFTER the rule, like the Auto refresh button').toBeGreaterThan(layout!.ruleIndex)
  const pill = page.locator('[data-testid="shuffle-user-queue"]')
  await expect(pill).toHaveAttribute('aria-pressed', 'false')

  // ── Put the audible row MID-queue so "prefix untouched" has teeth.
  await userRowPlay(page, 2).click()
  await expect.poll(async () => (await persistedQueue(page)).activeIndex).toBe(2)
  await expect(page.getByTestId('queue-now-playing')).toContainText(titleOf('ush-2'))

  const before = await domUserOrder(page)
  const storedBefore = await persistedQueue(page)
  expect(before, 'the rendered list IS the persisted user section').toEqual(storedBefore.userQueue)
  expect(before.slice(0, 3), 'rows 0-2 are the started song, the queued row and the tapped row').toEqual(
    storedBefore.userQueue.slice(0, 3),
  )
  const beforeTime = await playingMediaTime(page)

  // ── The press.
  await pill.click()
  await expect(pill).toHaveAttribute('aria-pressed', 'true')

  const after = await domUserOrder(page)
  expect(after.slice(0, 3), 'the played rows AND the audible row keep their positions').toEqual(before.slice(0, 3))
  expect([...after].sort(), 'the section is a permutation of the same songs (multiset preserved)').toEqual([...before].sort())
  expect(after.slice(3), 'the upcoming rows really reordered').not.toEqual(before.slice(3))
  expect([...after.slice(3)].sort()).toEqual([...before.slice(3)].sort())

  // ── The press persisted the switch and touched neither the anchor nor playback.
  await expect.poll(() => settingValue<boolean>(page, 'userQueueShuffle')).toBe(true)
  expect((await persistedQueue(page)).activeIndex, 'the audible row is still the anchor').toBe(2)
  await expect(page.getByTestId('queue-now-playing')).toContainText(titleOf('ush-2'))
  await expect.poll(() => playingMediaTime(page), { timeout: 15_000 }).toBeGreaterThan(beforeTime)
})

test('a repeat-all pass that finishes its last song re-enters shuffled and never with the finished song', async ({ page }) => {
  test.setTimeout(150_000)
  await instrumentMedia(page)
  await bootSongLibrary(page, SONGS)
  // Serve a track that can END (the shared mock's header declares ~74 h).
  // Registered after the mock, so it wins (Playwright routes are LIFO).
  await page.route('**/stream.view*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: SHORT_WAV,
    }),
  )
  await page.waitForTimeout(600)

  // ── Queue of four rows, then repeat-all (none → one → all).
  await page.locator('[data-track-id]').first().click()
  await expect(page.getByTestId('mini-player')).toContainText(titleOf('ush-0'))
  const add = page.getByRole('button', { name: 'Add to queue' })
  for (const i of [1, 2, 3]) await add.nth(i).click()
  await expect.poll(async () => (await persistedQueue(page)).userQueue.length).toBe(4)

  await page.getByTestId('mini-player').click()
  const loop = page.getByRole('button', { name: 'Toggle loop' })
  await loop.click() // none → one
  await loop.click() // one  → all
  await expect.poll(() => settingValue<string>(page, 'loopMode')).toBe('all')

  // ── The auto tail must be OUT of the way: otherwise the row after the last
  //    user row is a suggestion and the pass never ends.
  await page.getByRole('button', { name: 'Open queue' }).click()
  await expect(page.getByRole('button', { name: 'Close queue' })).toBeVisible()
  await page.getByTestId('toggle-auto-queue').click()
  await expect(page.getByTestId('toggle-auto-queue')).toHaveText('Turn on')
  await expect.poll(async () => (await persistedQueue(page)).autoQueue.length).toBe(0)

  // ── Shuffle ON (this also shuffles the tail once), then make the LAST row
  //    the audible one so its natural end is the end of the PASS.
  const pill = page.locator('[data-testid="shuffle-user-queue"]')
  await pill.click()
  await expect(pill).toHaveAttribute('aria-pressed', 'true')
  const before = await persistedQueue(page)
  const lastIndex = before.userQueue.length - 1
  const finishedId = before.userQueue[lastIndex]
  await userRowPlay(page, lastIndex).click()
  await expect.poll(async () => (await persistedQueue(page)).activeIndex).toBe(lastIndex)
  await expect(page.getByTestId('queue-now-playing')).toContainText(titleOf(finishedId))

  // ── The wrap: the last song ends (~6 s) and repeat-all re-enters at row 0.
  await expect
    .poll(async () => {
      const q = await persistedQueue(page)
      return q.activeIndex === 0 && q.userQueue[0] !== finishedId
    }, { timeout: 40_000, intervals: [250, 500] })
    .toBe(true)

  const wrapped = await persistedQueue(page)
  expect(wrapped.userQueue.length, 'a wrap shuffles, it never drops rows').toBe(before.userQueue.length)
  expect([...wrapped.userQueue].sort(), 'the new pass is a permutation of the same songs').toEqual([...before.userQueue].sort())
  expect(wrapped.userQueue, 'the new pass is a FRESH order').not.toEqual(before.userQueue)
  expect(wrapped.userQueue[0], 'the pass does not re-open with the song that just finished').not.toBe(finishedId)
  expect(await settingValue<boolean>(page, 'userQueueShuffle'), 'the switch stays on through the wrap').toBe(true)

  // ── And the new first row is what the engine is actually playing.
  await expect(page.getByTestId('queue-now-playing')).toContainText(titleOf(wrapped.userQueue[0]))
  await expect.poll(() => playingMediaTime(page), { timeout: 20_000 }).toBeGreaterThan(0.3)
})
