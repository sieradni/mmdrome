/**
 * Tiny, hand-built, taglib-wasm-parseable MP3 fixture generator for the e2e
 * suite (File Matching auditor / rescan heal flows run against the REAL
 * browser taglib, so the mock WebDAV server must serve bytes the wasm parse
 * accepts). Format rationale:
 *
 * - MP3 with ID3v2.3 text frames + real MPEG1 Layer-III audio frames was the
 *   first hand-crafted format the bundled wasm accepted (a metadata-only FLAC
 *   was rejected as INVALID_FORMAT — its valid() check wants audio frames).
 *   The ID3 tag carries lowercase-mapped keys (title/artist/album/…) which the
 *   app's case-insensitive property lookup (D?) picks up, so `properties()`
 *   surfaces TITLE/ARTIST/ALBUM/TRACKNUMBER.
 * - Duration: MPEG frames are 0.2 s of silence, so taglib reports <1 s and the
 *   reader drops duration (no signal) — no bogus duration-conflicts.
 * - Files stay well under the 262 KiB initial Range chunk, so the whole file
 *   is returned in one GET (no Range math in the reader) while still clearing
 *   taglib's 1 KiB minimum-buffer gate.
 *
 * A Node unit test (tests/fixtureParse.test.ts) parses every fixture through
 * taglib-wasm as a regression guard — if a taglib upgrade ever rejects these
 * bytes, that test fails with a real error instead of an opaque e2e timeout.
 */

/** ID3v2.3 tag: 10-byte header + one frame per value + `padLen` zero padding
 *  appended AFTER the frames (header size spans them both — the byte layout
 *  empirically accepted by the bundled taglib-wasm). */
function id3v23(frames: Record<string, string>, padLen: number): Buffer {
  const enc = new TextEncoder()
  const body: Buffer[] = []
  for (const [id, value] of Object.entries(frames)) {
    // Frame = 10-byte header (id + big-endian body length, v2.3) + body
    // (1 byte text-encoding 3 = UTF-8 + the value).
    const frameBody = Buffer.concat([Buffer.from([3]), Buffer.from(enc.encode(value))])
    const head = Buffer.alloc(10)
    head.write(id, 0, 'ascii')
    head.writeUInt32BE(frameBody.length, 4)
    body.push(head, frameBody)
  }
  const framesBuf = Buffer.concat(body)
  const pad = Buffer.alloc(padLen, 0)
  const total = 10 + framesBuf.length + pad.length
  const sz = Buffer.alloc(4)
  const v = total - 10 // syncsafe 28-bit
  sz[0] = (v >> 21) & 0x7f
  sz[1] = (v >> 14) & 0x7f
  sz[2] = (v >> 7) & 0x7f
  sz[3] = v & 0x7f
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), sz, framesBuf, pad])
}

/** One MPEG1 Layer III frame: 128 kbps, 44.1 kHz, stereo, zeroed payload. */
function mpegFrame(): Buffer {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00])
  const frameLen = Math.floor((144 * 128000) / 44100) // 417
  return Buffer.concat([header, Buffer.alloc(frameLen - 4, 0)])
}

export interface FixtureTrack {
  title: string
  artist: string
  album?: string
  track?: number
  /** Audio frame count — varies the byte size so fixtures never size-tie. */
  frames?: number
}

/** Deterministic parseable MP3 bytes for one library track. */
export function buildMp3Fixture(track: FixtureTrack): Buffer {
  const frames = track.frames ?? 8
  // Zero padding well past taglib's 1 KiB minimum-buffer gate.
  const id3 = id3v23({
    TIT2: track.title,
    TPE1: track.artist,
    TALB: track.album ?? 'Album X',
    TRCK: String(track.track ?? 1),
  }, 2048)
  const audio = Buffer.concat(Array.from({ length: frames }, () => mpegFrame()))
  return Buffer.concat([id3, audio])
}

/** Full relative path (against the WebDAV base) for a fixture's file. */
export function fixtureFilePath(title: string): string {
  return `${title}.mp3`
}
