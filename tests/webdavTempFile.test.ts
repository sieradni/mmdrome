// TODO 3.8a — the atomic-write temp naming is the SINGLE source for both the
// writer (`syncEngine.webdavPutAtomic`) and the orphan-cleanup detector
// (`metadataScanner.cleanupOrphanTempFiles`): the suffix lives in webdavUtils
// so the two can never drift, and these cases pin the FORMAT — a changed
// suffix would strand old orphans (crashed sessions' `.mmdrome-tmp` files)
// on servers forever.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webdavTempPath, isTempFile, MMDROME_TMP_SUFFIX } from '../src/lib/webdavUtils'

test('webdavTempPath appends the shared suffix to the target path', () => {
  assert.equal(webdavTempPath('Song.flac'), 'Song.flac.mmdrome-tmp')
  assert.equal(webdavTempPath('/dav/files/user/Song.flac'), '/dav/files/user/Song.flac.mmdrome-tmp')
  assert.equal(webdavTempPath('Song.flac'), `Song.flac${MMDROME_TMP_SUFFIX}`)
})

test('isTempFile detects exactly the write temp naming', () => {
  assert.equal(isTempFile('Song.flac.mmdrome-tmp'), true)
  assert.equal(isTempFile('/dav/files/user/Song.flac.mmdrome-tmp'), true)
  assert.equal(isTempFile('Song.flac'), false)
  assert.equal(isTempFile('Song.flac.tmp'), false, 'other tmp suffixes are not ours')
  assert.equal(isTempFile('Song.mmdrome-tmp.flac'), false, 'suffix must be terminal')
})
