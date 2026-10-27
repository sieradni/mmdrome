/**
 * Credential-health ledger (pure, DOM/fetch-free, injectable clock).
 *
 * WHY: before this module, every periodic caller (boot connect, scrobble legs,
 * feedback pushes, lyrics fetches) re-sent credentials on its own schedule —
 * so wrong/revoked credentials produced a steady request stream against the
 * server "as so". Navidrome 0.64.1 additionally RATE-LIMITS failed Subsonic
 * logins server-side, so a spamming client can throttle itself into longer
 * outages. The honest treatment: an AUTHORITATIVE rejection means stop.
 *
 * Two error classes:
 *  - `unhealthy` (Subsonic code 40, "Wrong username or password"): a
 *    DETERMINISTIC failure — no backoff timer fixes wrong credentials.
 *    Recorded once per baseKey; every gated caller short-circuits until the
 *    user changes credentials or a connect SUCCEEDS.
 *  - transient (code 0 / network / anything else): NOT tracked here. Callers
 *    with their own retry policy (scrobbleFlush backoff, next boot's connect)
 *    already handle them; a network blip must never park the credentials.
 *
 * Verdict classification: the same code-40 knowledge answers "was this a
 * rejection or just an outage?" (`classifyConnectFailure`) — the connect
 * results and the surfaces that report a failed connect read it, so a rejected
 * password is never described as the device being offline.
 *
 * Clearing: `markAuthSuccess` (any successful connect) or `resetCredentials`
 * (the user committed new credentials — identity = the same `baseKey`
 * primitive the library cache uses, `baseUrl|username`). A baseKey change
 * needs no reset: ledger entries are keyed per baseKey and a new key starts
 * healthy.
 *
 * Test seam: `__setAuthHealthClockForTests` swaps the clock (no fake timers
 * needed — the module is otherwise stateless per baseKey).
 */

export type AuthHealth = 'healthy' | 'unhealthy'

/**
 * The verdict a failed connect carries — were the credentials REJECTED, or is
 * the server simply unreachable? The two need opposite user copy (fix the
 * password vs check the connection), so nothing that reports a failed connect
 * may collapse them into one message.
 *
 * - Subsonic code 40 is the server's authoritative rejection — the same signal
 *   `recordAuthOutcome` parks on. It is checked FIRST so a rejection that also
 *   arrives with a status cannot be read as connectivity.
 * - HTTP 401/403 mean the same thing when the code is absent: a Subsonic call
 *   reports them through the transport branch (code 0), and a WebDAV PROPFIND
 *   has only the status. A reverse proxy answering 401 in front of a healthy
 *   server is still a credential rejection from the user's point of view.
 * - Everything else (network error, timeout, 5xx, malformed body) is
 *   `unreachable`: a retry may work, and the copy must not send the user to
 *   re-type a password that is fine.
 */
export type ConnectFailure = 'auth' | 'unreachable'

export function classifyConnectFailure(subsonicCode?: number, httpStatus?: number): ConnectFailure {
  if (subsonicCode === 40) return 'auth'
  if (httpStatus === 401 || httpStatus === 403) return 'auth'
  return 'unreachable'
}

interface LedgerEntry {
  state: 'unhealthy'
  sinceMs: number
  /** The server's message when the rejection was recorded (for the UI copy). */
  detail: string
}

const ledger = new Map<string, LedgerEntry>()

let nowFn: () => number = () => Date.now()

/** Test seam: swap the clock; call with no args to restore. */
export function __setAuthHealthClockForTests(next?: () => number): void {
  nowFn = next ?? (() => Date.now())
}

/** Test seam: clear the whole ledger between tests. */
export function __resetAuthHealthForTests(): void {
  ledger.clear()
}

/**
 * Records the outcome of an authenticated attempt. Call at the ONE choke
 * point that sees every Subsonic response: `subsonicCode` is the parsed
 * `subsonic-response.error.code` (0 = transport/HTTP-level). A code 40 is
 * the server's authoritative "credentials rejected" — everything else is
 * transient by definition here.
 *
 * Returns whether this call PARKED the key (`'parked'` — the first code 40
 * for this baseKey), found it already parked (`'already-parked'`), or ignored
 * the outcome (`'ignored'` — transient). The caller logs the one-time
 * `'parked'` transition as a danger event; repeat rejections stay silent in
 * the ring (the ledger dedupes them anyway).
 */
export function recordAuthOutcome(baseKey: string, subsonicCode: number, detail = ''): 'parked' | 'already-parked' | 'ignored' {
  if (subsonicCode === 40) {
    const existing = ledger.get(baseKey)
    // Keep the FIRST rejection's timestamp (the `sinceMs` is diagnostics;
    // re-recording would slide the window and hide real outage duration).
    if (existing) return 'already-parked'
    ledger.set(baseKey, { state: 'unhealthy', sinceMs: nowFn(), detail })
    return 'parked'
  }
  // Any non-40 outcome (success or transient failure) does NOT clear an
  // unhealthy state — only an explicit SUCCESSFUL connect does (below).
  // A network blip must not resurrect spammed credentials, and a gated
  // scrobble leg never reaches the server to produce an outcome anyway.
  return 'ignored'
}

/**
 * Marks a SUCCESSFUL authenticated connect: the credentials work again.
 * Clears the unhealthy state for the baseKey.
 */
export function markAuthSuccess(baseKey: string): void {
  ledger.delete(baseKey)
}

/** The user committed new credentials for this server — start clean. */
export function resetCredentials(baseKey: string): void {
  ledger.delete(baseKey)
}

/** The ONE identity string shared by the recording side (navidromeApi's
 *  response choke point) and the gating side (scrobble/feedback/lyrics
 *  callers) — same primitive the library cache uses for server identity. */
export function authBaseKey(baseUrl: string, username: string): string {
  return `${baseUrl.trim()}|${username.trim()}`
}

/** May requests with these credentials hit the server right now? */
export function credentialsHealthy(baseKey: string): boolean {
  return !ledger.has(baseKey)
}

/** UI/diagnostic read: the unhealthy entry's detail, or undefined when healthy. */
export function authUnhealthyDetail(baseKey: string): string | undefined {
  return ledger.get(baseKey)?.detail
}
