// Pins src/lib/md5.ts against independently computed vectors (.NET MD5):
// RFC 1321 classics plus a multi-byte CJK string proving the UTF-8 encoding
// path (TextEncoder) — a naive charCode-based implementation would diverge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { md5 } from '../src/lib/md5'

test('md5 RFC 1321 reference vectors', () => {
  assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72')
})

test('md5 hashes the UTF-8 encoding (multi-byte CJK input)', () => {
  // 坂本龍一
  assert.equal(md5('坂本龍一'), 'ef391869109377655143e30856f5830a')
})
