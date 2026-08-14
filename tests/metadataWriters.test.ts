import { test } from 'node:test'
import assert from 'node:assert/strict'
import { metadataCache, settings, seedNavidromeFeedback, type Track } from '../src/stores/appState'
import { commitFeedback } from '../src/lib/feedbackService'
import { db, type LocalMetadataStore } from '../src/lib/db'

// No IndexedDB under Node — capture the Dexie writes instead.
const putWrites: LocalMetadataStore[] = []
Object.getPrototypeOf(db.localMetadata).put = (async (m: LocalMetadataStore) => {
  putWrites.push(m)
}) as never

const bulkWrites: LocalMetadataStore[] = []
Object.getPrototypeOf(db.localMetadata).bulkPut = (async (items: LocalMetadataStore[]) => {
  bulkWrites.push(...items)
}) as never

const track: Track = {
  trackId: 'navidrome-t1',
  title: 'T',
  artist: 'A',
  album: 'Al',
  duration: 120,
  fileType: 'mp3',
  comments: 'comment',
}

function seed(existing: LocalMetadataStore): void {
  metadataCache.set(new Map([[existing.trackId, existing]]))
  settings.set({})
}

function existingRow(over: Partial<LocalMetadataStore> = {}): LocalMetadataStore {
  return {
    trackId: 'navidrome-t1',
    rating: 50,
    loved: false,
    fileType: 'mp3',
    syncStatus: 'synced',
    lastModifiedLocally: 1,
    webdavPath: '/m/a.mp3',
    webdavBase: 'u|user',
    matchSource: 'manual',
    ignored: true,
    ...over,
  }
}

test('commitFeedback (webdav) preserves matchSource + ignored on a rating edit', () => {
  seed(existingRow())
  putWrites.length = 0
  commitFeedback(track, 80, true)
  assert.equal(putWrites.length, 1)
  const meta = putWrites[0]
  assert.equal(meta.rating, 80)
  assert.equal(meta.loved, true)
  assert.equal(meta.syncStatus, 'pending_sync')
  assert.equal(meta.matchSource, 'manual')
  assert.equal(meta.ignored, true)
})

test('commitFeedback (navidrome) preserves matchSource + ignored on a rating edit', () => {
  seed(existingRow())
  settings.set({ ratingSource: 'navidrome' })
  putWrites.length = 0
  commitFeedback(track, 80, true)
  assert.equal(putWrites.length, 1)
  const meta = putWrites[0]
  assert.equal(meta.syncStatus, 'synced')
  assert.equal(meta.matchSource, 'manual')
  assert.equal(meta.ignored, true)
})

test('seedNavidromeFeedback preserves matchSource + ignored', () => {
  seed(existingRow())
  bulkWrites.length = 0
  seedNavidromeFeedback([{ ...track, starred: true, userRating: 5 }])
  assert.equal(bulkWrites.length, 1)
  assert.equal(bulkWrites[0].matchSource, 'manual')
  assert.equal(bulkWrites[0].ignored, true)
})

test('commitFeedback preserves an unset (undefined) matching intent', () => {
  seed(existingRow({ matchSource: undefined, ignored: undefined }))
  putWrites.length = 0
  commitFeedback(track, 30, false)
  assert.equal(putWrites.length, 1)
  assert.equal(putWrites[0].matchSource, undefined)
  assert.equal(putWrites[0].ignored, undefined)
})
