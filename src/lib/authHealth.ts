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
 */
export function recordAuthOutcome(baseKey: string, subsonicCode: number, detail = ''): void {
  if (subsonicCode === 40) {
    const existing = ledger.get(baseKey)
    // Keep the FIRST rejection's timestamp (the `sinceMs` is diagnostics;
    // re-recording would slide the window and hide real outage duration).
    if (existing) return
    ledger.set(baseKey, { state: 'unhealthy', sinceMs: nowFn(), detail })
    return
  }
  // Any non-40 outcome (success or transient failure) does NOT clear an
  // unhealthy state — only an explicit SUCCESSFUL connect does (below).
  // A network blip must not resurrect spammed credentials, and a gated
  // scrobble leg never reaches the server to produce an outcome anyway.
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
