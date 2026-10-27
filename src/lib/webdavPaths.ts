/**
 * Single derivation for WebDAV URLs, Basic auth headers, temp-file naming,
 * and destination-scoped `If` preconditions. Kept Capacitor-free so pure cores
 * (`webdavAtomicWrite`) and Node tests share the exact wire rules with
 * `webdavUtils`.
 */

export const MMDROME_TMP_SUFFIX = '.mmdrome-tmp'

/** Trims surrounding whitespace and strips trailing slashes. */
export function normalizeUrl(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

/**
 * UTF-8 safe Basic Authorization header. Plain `btoa` throws
 * `InvalidCharacterError` on any character outside Latin1 (e.g. non-ASCII
 * Nextcloud passwords or usernames).
 */
export function authHeaders(user: string, token: string): Record<string, string> {
  const bytes = new TextEncoder().encode(`${user}:${token}`)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return { Authorization: `Basic ${btoa(binary)}` }
}

/**
 * Percent-encodes each path segment once (never the `/` separators, and never
 * double-encoding an already-escaped base URL). Also encodes any raw spaces or
 * non-URI characters in the base path while preserving existing `%XX` escapes,
 * so `@capacitor/ios`'s `HttpRequestHandler` (`urlString == urlString.removingPercentEncoding`
 * heuristic) never fails `URL(string:)` when a base and path mix raw and
 * percent-encoded segments.
 */
export function buildWebdavUrl(baseUrl: string, filePath: string): string {
  const safeBase = normalizeUrl(baseUrl).replace(
    /%(?:[0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/g,
    (m) => (m.startsWith('%') && m.length === 3 ? m : encodeURIComponent(m)),
  )
  const rel = filePath.replace(/^\/+/, '')
  if (!rel) return `${safeBase}/`
  const encodedPath = rel.split('/').map((s) => encodeURIComponent(s)).join('/')
  return `${safeBase}/${encodedPath}`
}

export function webdavTempPath(filePath: string, runToken?: string): string {
  const cleanToken = runToken?.replace(/[^A-Za-z0-9_-]/g, '') ?? ''
  return cleanToken ? `${filePath}.${cleanToken}${MMDROME_TMP_SUFFIX}` : `${filePath}${MMDROME_TMP_SUFFIX}`
}

export function isTempFile(filename: string): boolean {
  return filename.endsWith(MMDROME_TMP_SUFFIX)
}

/**
 * Conditional-MOVE precondition (RFC 4918 §10.4.1 tagged list):
 * `If: <destination-url> (["etag"])`.
 *
 * `If-Match` is evaluated against the request URI — for a temp-file MOVE that
 * is the `.mmdrome-tmp` source (`Server::checkPreconditions` in sabre/dav), so
 * sending the destination's ETag in `If-Match` 412s every guarded row. A
 * tagged `If` list scopes the ETag check to the destination URI instead.
 * Returns `null` when the ETag or URL cannot be safely expressed in the
 * grammar (unquoted, contains `]` or control chars), degrading to an honest
 * blind overwrite (`guarded: false`).
 */
export function webdavIfHeader(destinationUrl: string, etag: string | null | undefined): string | null {
  if (!etag || /[<>\s]/.test(destinationUrl)) return null
  if (!/^(?:W\/)?"[^"\]]*"$/.test(etag) || /[\u0000-\u001f\u007f]/.test(etag)) return null
  return `<${destinationUrl}> ([${etag}])`
}
