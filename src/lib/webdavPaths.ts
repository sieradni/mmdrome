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
 * WebDAV `If` condition grammar (RFC 4918 §10.4.1): `[ entity-tag ]`.
 *
 * The bracketed form is the one sabre/dav parses (`[^\]]*` capture), so an
 * etag containing `]` — or one that is not a quoted tag at all — CANNOT be
 * expressed here. Callers must fall back to another guard rather than emit a
 * header some servers answer with 400.
 */
const IF_TAG_ETAG = /^(?:W\/)?"[^"\]]*"$/

/**
 * HTTP `entity-tag` grammar (RFC 9110 §8.8.3): `[ weak ] DQUOTE *etagc DQUOTE`,
 * where `etagc` is `%x21 / %x23-7E / obs-text`. Broader than the WebDAV `If`
 * form — `]` and `[` are legal here — which is why an etag the tagged list
 * cannot carry can still guard a request through `If-Match`.
 */
const HTTP_ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7E\x80-\uFFFF]*"$/

/** Control characters are not transportable in a header value, in any grammar. */
const HEADER_UNSAFE = /[\u0000-\u001f\u007f]/

/** True when `etag` can be carried by a WebDAV `If` tagged list. */
export function expressibleIfEtag(etag: string | null | undefined): boolean {
  return !!etag && IF_TAG_ETAG.test(etag) && !HEADER_UNSAFE.test(etag)
}

/** True when `etag` can be carried by an HTTP `If-Match` / `If-None-Match`. */
export function isHttpEntityTag(etag: string | null | undefined): boolean {
  return !!etag && HTTP_ENTITY_TAG.test(etag) && !HEADER_UNSAFE.test(etag)
}

/**
 * Conditional-MOVE precondition (RFC 4918 §10.4.1 tagged list):
 * `If: <destination-url> (["etag"])`.
 *
 * `If-Match` is evaluated against the request URI — for a temp-file MOVE that
 * is the `.mmdrome-tmp` source (`Server::checkPreconditions` in sabre/dav), so
 * a destination etag there 412s a guarded row on that class of server. The
 * tagged `If` list scopes the check to the destination URI instead, which is
 * why it is the FIRST rung of the write's precondition ladder
 * (`webdavPreconditions.ts`); `If-Match` remains available further down it for
 * servers that evaluate untagged preconditions against the destination.
 * Returns `null` when the ETag or URL cannot be safely expressed in the
 * grammar (unquoted, contains `]` or control chars).
 */
export function webdavIfHeader(destinationUrl: string, etag: string | null | undefined): string | null {
  if (!etag || /[<>\s]/.test(destinationUrl)) return null
  if (!expressibleIfEtag(etag)) return null
  return `<${destinationUrl}> ([${etag}])`
}
