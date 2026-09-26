// Pins the pure stale-id pending-edit re-link planner (`planPendingRelink`,
// src/lib/pendingRelink.ts). A Navidrome id migration re-encodes every id
// while unpushed local edits stay keyed by the OLD id — the planner decides
// which live track can PROVE it is the same song, in evidence order:
// PATH (the stamped webdavPath — the file never changed) then METADATA
// (title+artist fold matching exactly one live track). The absolute rules:
// ambiguity is residue (never a coin flip), a live pending edit is never
// overwritten, an ignored live row is never a re-link target, and synced
// rows never participate.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPendingRelink, type PendingRelinkOrphan, type PendingRelinkLive, type PendingRelinkTrack } from '../src/lib/pendingRelink'

const BASE = 'u|user'

function orphan(id: string, over: Partial<PendingRelinkOrphan> = {}): PendingRelinkOrphan {
  return { trackId: id, rating: 60, loved: true, syncStatus: 'pending_sync', webdavPath: `/m/${id}.mp3`, webdavBase: BASE, ...over }
}

function live(id: string, over: Partial<PendingRelinkLive> = {}): PendingRelinkLive {
  return { trackId: id, rating: 0, loved: false, syncStatus: 'synced', ...over }
}

function track(id: string, title: string, artist: string, over: Partial<PendingRelinkTrack> = {}): PendingRelinkTrack {
  return { trackId: id, title, artist, ...over }
}

test('path evidence: an orphan with a stamped path moves onto the UNIQUE current-server row bound to that file', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1', { webdavPath: '/m/Song One.mp3', webdavBase: BASE })]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: '/m/Song One.mp3' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [{ fromTrackId: 'old-1', toTrackId: 'new-1', which: 'path' }])
  assert.deepEqual(d.unmatchedTrackIds, [])
})

test('path evidence is same-server: a binding stamped on a DIFFERENT base never owns the path', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1', { webdavPath: '/m/Song One.mp3', webdavBase: 'other|user' })]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: '/m/Song One.mp3' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [])
  assert.deepEqual(d.unmatchedTrackIds, ['old-1'])
})

test('path evidence is same-server for the ORPHAN too: a stale-base orphan is never claimed (cross-server relative-path coincidence)', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1', { webdavPath: '/m/Song One.mp3', webdavBase: BASE })]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: '/m/Song One.mp3', webdavBase: 'other|user' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [], 'the same RELATIVE path on another server names a different file')
  assert.deepEqual(d.unmatchedTrackIds, ['old-1'])
})

test('path evidence: TWO same-path rows (legacy double-bind on the new ids) is unsettled evidence — residue, never a pick', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A'), track('new-2', 'Other Song', 'Artist B')]
  const rows = new Map([
    ['new-1', live('new-1', { webdavPath: '/m/Song One.mp3', webdavBase: BASE })],
    ['new-2', live('new-2', { webdavPath: '/m/Song One.mp3', webdavBase: BASE })],
  ])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: '/m/Song One.mp3' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [])
  assert.deepEqual(d.unmatchedTrackIds, ['old-1'])
})

test('path evidence: an ignored row bound to the path is not an owner; a synced sibling bound to the SAME path still is', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A'), track('new-2', 'Other', 'B')]
  const rows = new Map([
    ['new-1', live('new-1', { webdavPath: '/m/Song One.mp3', webdavBase: BASE, ignored: true })],
    ['new-2', live('new-2', { webdavPath: '/m/Song One.mp3', webdavBase: BASE })],
  ])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: '/m/Song One.mp3' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [{ fromTrackId: 'old-1', toTrackId: 'new-2', which: 'path' }], 'ignored is excluded from the candidate set, so new-2 is the unique owner')
})

test('path evidence: the stamped path is STRONGER than metadata — no title fallback when the path cannot be proven', () => {
  // The path's owner cannot be established, but a live track shares the
  // orphan's (hypothetical) title fold. A stamped path whose owner is
  // unknown could belong to a DIFFERENT song than the title suggests —
  // claim nothing.
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1')]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: '/m/Unknown owner.mp3', title: 'Song One', artist: 'Artist A' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [])
  assert.deepEqual(d.unmatchedTrackIds, ['old-1'])
})

test('metadata evidence: a path-less orphan moves when its title+artist fold matches exactly one live track', () => {
  const tracks = [track('new-1', "Don't Stop Me Now", 'Queen')]
  const rows = new Map([['new-1', live('new-1')]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: undefined, webdavBase: undefined, title: "don't stop me now!", artist: 'QUEEN' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [{ fromTrackId: 'old-1', toTrackId: 'new-1', which: 'metadata' }])
})

test('metadata evidence: a fold shared by two live tracks is a tie — residue, never a coin flip', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A'), track('new-2', 'SONG ONE', 'artist a')]
  const rows = new Map([['new-1', live('new-1')], ['new-2', live('new-2')]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: undefined, title: 'Song One', artist: 'Artist A' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [])
  assert.deepEqual(d.unmatchedTrackIds, ['old-1'])
})

test('metadata evidence: no identity supplied → no claim (a bare LocalMetadataStore row cannot prove anything)', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1')]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: undefined })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [])
  assert.deepEqual(d.unmatchedTrackIds, ['old-1'])
})

test('a live row that is itself pending is NEVER overwritten — the orphan stays residue', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1', { syncStatus: 'pending_sync', webdavPath: '/m/Song One.mp3', webdavBase: BASE })]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: '/m/Song One.mp3' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [])
  assert.deepEqual(d.unmatchedTrackIds, ['old-1'])
})

test('an ignored live row is never a re-link target (the dismissal outranks the orphan)', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1', { ignored: true, webdavPath: '/m/Song One.mp3', webdavBase: BASE })]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: '/m/Song One.mp3' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [])
  assert.deepEqual(d.unmatchedTrackIds, ['old-1'])
})

test('non-pending orphans never participate (defensive: the caller feeds pending rows only)', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1')]])
  const byId = new Map([['old-1', orphan('old-1', { syncStatus: 'synced' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [])
  assert.deepEqual(d.unmatchedTrackIds, [], 'a synced orphan was pruned elsewhere — not even residue')
})

test('two orphans claiming the same owner: the plan emits both; the APPLIER arbitrates', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1', { webdavPath: '/m/Song One.mp3', webdavBase: BASE })]])
  // Both orphans stamp the SAME path — a legacy double-bind. The planner is
  // stateless per orphan (each sees the synced live row), so it emits both
  // moves; the applier's pending-guard lands the first and strands the
  // second as residue (the split of responsibility is the pin here).
  const byId = new Map([
    ['old-1', orphan('old-1', { webdavPath: '/m/Song One.mp3' })],
    ['old-2', orphan('old-2', { webdavPath: '/m/Song One.mp3' })],
  ])

  const d = planPendingRelink(['old-1', 'old-2'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [
    { fromTrackId: 'old-1', toTrackId: 'new-1', which: 'path' },
    { fromTrackId: 'old-2', toTrackId: 'new-1', which: 'path' },
  ])
  assert.deepEqual(d.unmatchedTrackIds, [])
})

test('an orphan already matching the path-owner id is skipped, not self-relinked', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1', { webdavPath: '/m/Song One.mp3', webdavBase: BASE })]])
  const byId = new Map([['new-1', orphan('new-1', { webdavPath: '/m/Song One.mp3' })]])

  const d = planPendingRelink(['new-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [], 'r.trackId !== orphanId excludes self')
  assert.deepEqual(d.unmatchedTrackIds, ['new-1'])
})

test('empty inputs: no orphans → empty decision', () => {
  const d = planPendingRelink([], [], new Map(), () => undefined, BASE)
  assert.deepEqual(d, { moves: [], unmatchedTrackIds: [] })
})

test('legacy orphans (no base stamp at all) still relink — the base-stamp guard only fires on a DIFFERENT base', () => {
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1', { webdavPath: '/m/Song One.mp3', webdavBase: BASE })]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: '/m/Song One.mp3', webdavBase: undefined })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [{ fromTrackId: 'old-1', toTrackId: 'new-1', which: 'path' }])
})

test('identity snapshot: a stamped commit-time title/artist relinks a PATH-LESS orphan by metadata', () => {
  // The field shape this lane exists for: the file was never scanned (no
  // webdavPath), but the pending row carries the identity snapshot stamped
  // at commit time — the planner claims the unique title+artist fold match.
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1')]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: undefined, webdavBase: undefined, title: 'SONG ONE!', artist: 'artist a' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [{ fromTrackId: 'old-1', toTrackId: 'new-1', which: 'metadata' }])
})

test('identity snapshot: a stamped identity does NOT let a stamped-path orphan fall through to metadata', () => {
  // A stamped path still outranks identity text even when the snapshot
  // exists — the stronger evidence either proves or stays residue.
  const tracks = [track('new-1', 'Song One', 'Artist A')]
  const rows = new Map([['new-1', live('new-1')]])
  const byId = new Map([['old-1', orphan('old-1', { webdavPath: '/m/nowhere.mp3', title: 'Song One', artist: 'Artist A' })]])

  const d = planPendingRelink(['old-1'], tracks, rows, (id) => byId.get(id), BASE)
  assert.deepEqual(d.moves, [])
  assert.deepEqual(d.unmatchedTrackIds, ['old-1'])
})
