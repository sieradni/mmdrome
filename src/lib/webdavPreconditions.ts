/**
 * Destination collision checking for the atomic WebDAV write: WHAT the
 * destination's validators are, WHICH guard a server will actually honour, and
 * the portable re-check that holds when it honours none.
 *
 * ## Why a ladder (field history 2026-10-27)
 *
 * No single precondition form is universally implemented, and a rejected one is
 * deterministic, not contention: the field report was 36 of 42 rows rejected
 * twice at the MOVE while every temp PUT in the same folders succeeded, because
 * the server refused the SHAPE of the guard. So the write walks a LADDER and
 * remembers the rung this server accepted for the rest of the run:
 *
 * 1. `If: <dest-url> (["etag"])` — the RFC 4918 tagged list, what sabre/dav
 *    (Nextcloud) evaluates against the tagged resource.
 * 2. `If-Match: <etag>` — HTTP core, evaluated against the request URI, so it
 *    guards the destination only where a MOVE resolves it there.
 * 3. `If-Unmodified-Since` — the date-based precondition (RFC 9110 §13.1.3).
 * 4. `revalidated` — no header at all; the re-check below is the whole guard.
 *
 * ## The portable half
 *
 * A ladder alone cannot be trusted: a server may ignore every precondition
 * (then the MOVE succeeds unguarded and the guard is a fiction), and a rejected
 * rung may be either a dialect rejection or a real concurrent write. Both
 * questions are answered by the SAME cheap read — `PROPFIND Depth: 0` on the
 * destination, immediately before the MOVE:
 *
 * - the destination's validators are UNCHANGED since the write read them ⇒ the
 *   412 was the server refusing our dialect, so the next rung may be tried
 *   with the SAME temp already on the server (the payload is not re-uploaded);
 * - they CHANGED ⇒ a writer really did land between our read and the rename,
 *   so the row is refused (`ConflictError`) and the caller re-reads the new
 *   bytes and re-tags THEM rather than clobbering them;
 * - the read cannot tell ⇒ refuse rather than weaken (`ConflictError`).
 *
 * The same read is the only guard available at the bottom rung, so an ordinary
 * server that implements no usable precondition still gets a real collision
 * check — it just gets no second line of defence, and the run says so
 * (`PreconditionKind` is reported per row).
 *
 * ## Where the validators come from
 *
 * From `PROPFIND` properties, never from the GET's response headers. `getetag`
 * is the same field the server itself compares in the MOVE precondition (sabre:
 * `$node->getETag()` for both), so guard and re-check read ONE value from ONE
 * source — no "the GET said `"a"`, the PROPFIND said `"b"`" ambiguity that would
 * have to guess between a concurrent write and a reformatted tag. It also
 * removes a real subset restriction: a GET's `ETag` is not CORS-safelisted, so a
 * web client on a server that omits `Access-Control-Expose-Headers: ETag` could
 * previously never guard a write at all; WebDAV properties arrive in the XML
 * body instead.
 */

import { expressibleIfEtag, isHttpEntityTag, webdavIfHeader } from './webdavPaths'

/**
 * The destination's validators as the SERVER publishes them. `contentLength`
 * is deliberately absent: a length is not a validator (RFC 9110 §8.6) and an
 * edit that keeps the byte count would read as "unchanged" — the dangerous
 * direction, because it would let a real concurrent write through.
 */
export interface DestinationValidators {
  etag?: string
  lastModified?: string
}

/**
 * How a committed write was protected:
 * - `tagged-if` / `if-match` / `if-unmodified-since`: the server enforced a
 *   precondition on the destination.
 * - `revalidated`: no precondition held, so only the pre-MOVE re-check did —
 *   honest about the reduced guarantee.
 * - `blind`: not even the re-check could compare validators (the server
 *   published none), so the rename was unverified.
 */
export type PreconditionKind =
  | 'tagged-if'
  | 'if-match'
  | 'if-unmodified-since'
  | 'revalidated'
  | 'blind'

/** A guard the write can SEND; `blind` is a report verdict, never a request. */
export type PreconditionRung = Exclude<PreconditionKind, 'blind'>

export type RevalidationResult = 'unchanged' | 'changed' | 'unknown'

const RUNG_ORDER: readonly PreconditionRung[] = [
  'tagged-if',
  'if-match',
  'if-unmodified-since',
  'revalidated',
]

const PROP_REQUEST =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>'
  + '<d:getetag/><d:getlastmodified/>'
  + '</d:prop></d:propfind>'

/** Body for the destination read: exactly the two validators, Depth: 0. */
export function propfindValidatorsBody(): string {
  return PROP_REQUEST
}

/**
 * HTTP-date → epoch ms, or `undefined` when the server sent something that is
 * not a date. Dates compare as instants so a reformatted but identical stamp
 * (`Mon, 01 Jan 2024 00:00:00 GMT` vs the same instant serialized with another
 * day name) still reads as unchanged.
 */
export function httpDateMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value.trim())
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * RFC 9110 §8.8.3.2: a weak tag and its strong form name the same
 * representation version, so `W/"x"` and `"x"` must compare EQUAL here. A
 * proxy that weakens a tag in transit (or a server that weakens it for one
 * response and not another) must not read as a concurrent write.
 */
function normalizedEtag(etag: string | undefined): string | undefined {
  const trimmed = etag?.trim()
  if (!trimmed) return undefined
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed
}

/**
 * Did the destination change between the two readings?
 *
 * `false` (unchanged) is only ever returned from a real comparison — `true`
 * (changed) and `'unknown'` both mean the caller must not proceed on the
 * assumption that nothing moved.
 */
export function validatorsChanged(
  before: DestinationValidators,
  after: DestinationValidators,
): boolean | 'unknown' {
  const beforeEtag = normalizedEtag(before.etag)
  const afterEtag = normalizedEtag(after.etag)
  if (beforeEtag && afterEtag) return beforeEtag !== afterEtag

  const beforeDate = httpDateMs(before.lastModified)
  const afterDate = httpDateMs(after.lastModified)
  if (beforeDate !== undefined && afterDate !== undefined) return beforeDate !== afterDate

  return 'unknown'
}

/**
 * The guards to try, in precedence order, filtered to those this destination's
 * validators can express. `startAt` resumes at the rung an earlier row already
 * proved this server accepts; a rung that is infeasible for THIS destination
 * (e.g. a row whose file has no etag) is skipped rather than blocking.
 */
export function planPreconditionLadder(
  validators: DestinationValidators | undefined,
  startAt?: PreconditionKind,
): PreconditionRung[] {
  const etag = validators?.etag?.trim()
  const from = RUNG_ORDER.indexOf(startAt === 'blind' || !startAt ? 'tagged-if' : startAt)
  return RUNG_ORDER.filter((rung, index) => {
    if (index < from) return false
    if (rung === 'tagged-if') return expressibleIfEtag(etag)
    if (rung === 'if-match') return isHttpEntityTag(etag)
    if (rung === 'if-unmodified-since') return httpDateMs(validators?.lastModified) !== undefined
    return true
  })
}

/** The headers a rung adds to the MOVE (empty for `revalidated`). */
export function movePreconditionHeaders(
  rung: PreconditionRung,
  destinationUrl: string,
  validators: DestinationValidators | undefined,
): Record<string, string> {
  const etag = validators?.etag?.trim()
  switch (rung) {
    case 'tagged-if': {
      const header = webdavIfHeader(destinationUrl, etag)
      return header ? { If: header } : {}
    }
    case 'if-match':
      return etag ? { 'If-Match': etag } : {}
    case 'if-unmodified-since': {
      const lastModified = validators?.lastModified?.trim()
      return lastModified ? { 'If-Unmodified-Since': lastModified } : {}
    }
    case 'revalidated':
      return {}
  }
}

const RESPONSE_BLOCK = /<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi

function propValue(block: string, prop: string): string | undefined {
  const match = new RegExp(`<(?:\\w+:)?${prop}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${prop}>`, 'i').exec(block)
  if (!match) return undefined
  const value = decodeXmlEntities(match[1]).trim()
  return value || undefined
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * The destination's validators out of a `Depth: 0` multistatus. Takes the first
 * response that carries any of the requested properties — the collection entry
 * some servers add alongside the resource carries none — and returns `null`
 * when no entry does, which callers treat as "no validators available" rather
 * than "the file is gone" (the HTTP status is what reports that).
 */
export function parseDestinationValidators(xml: string): DestinationValidators | null {
  for (const block of xml.match(RESPONSE_BLOCK) ?? []) {
    const etag = propValue(block, 'getetag')
    const lastModified = propValue(block, 'getlastmodified')
    if (etag || lastModified) return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) }
  }
  return null
}

/** The re-check verdict for the destination read that just came back. */
export function revalidationResult(
  before: DestinationValidators,
  after: DestinationValidators | null,
): RevalidationResult {
  if (!after) return 'unknown'
  const verdict = validatorsChanged(before, after)
  return verdict === true ? 'changed' : verdict === false ? 'unchanged' : 'unknown'
}
