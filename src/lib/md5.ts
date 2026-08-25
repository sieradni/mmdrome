/**
 * Pure RFC 1321 MD5 over the UTF-8 encoding of `input` (TextEncoder), returned
 * as lowercase hex. Zero-dependency so both the Subsonic auth-token path
 * (`navidromeApi`) and the Last.fm request-signing path (`lastfmCore`) share
 * one implementation — pinned by test vectors including non-ASCII input.
 */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]

export function md5(input: string): string {
  const data = new TextEncoder().encode(input)
  const len = data.length

  const paddedLen = Math.ceil((len + 9) / 64) * 64
  const bytes = new Uint8Array(paddedLen)
  bytes.set(data)
  bytes[len] = 0x80

  const bitLen = len * 8
  bytes[paddedLen - 8] = bitLen & 0xff
  bytes[paddedLen - 7] = (bitLen >>> 8) & 0xff
  bytes[paddedLen - 6] = (bitLen >>> 16) & 0xff
  bytes[paddedLen - 5] = (bitLen >>> 24) & 0xff

  const blocks = paddedLen / 64

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476

  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n))

  for (let blk = 0; blk < blocks; blk++) {
    const off = blk * 64
    const M = new Uint32Array(16)
    for (let i = 0; i < 16; i++) {
      M[i] = bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24)
    }

    let AA = a, BB = b, CC = c, DD = d

    for (let i = 0; i < 64; i++) {
      let f: number, g: number
      if (i < 16) { f = (b & c) | (~b & d); g = i }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      f = (f + a + MD5_K[i] + M[g]) >>> 0
      a = d; d = c; c = b; b = (b + rotl(f, MD5_S[i])) >>> 0
    }
    a = (a + AA) >>> 0; b = (b + BB) >>> 0; c = (c + CC) >>> 0; d = (d + DD) >>> 0
  }

  return [a, b, c, d].map(n => {
    const b0 = n & 0xff
    const b1 = (n >>> 8) & 0xff
    const b2 = (n >>> 16) & 0xff
    const b3 = (n >>> 24) & 0xff
    return b0.toString(16).padStart(2, '0') + b1.toString(16).padStart(2, '0') + b2.toString(16).padStart(2, '0') + b3.toString(16).padStart(2, '0')
  }).join('')
}
