/**
 * Structured debug logging with OPT-IN verbose domains (2026-09-19).
 *
 * The native engine records danger + info transitions ALWAYS and verbose
 * flow only for HUD-enabled domains (`setDebugDomains`). This module is the
 * JS counterpart with the same shape so the Copy dump reads as ONE model:
 *
 *  - `dbg(domain, msg)` — a `debug`-level entry: recorded ONLY when the
 *    domain is enabled. Library-level verbosity (tag probes, matching
 *    scores, sync pipeline decisions) lives here — a full-library scan must
 *    be silent by default and exhaustive when asked.
 *  - `dbgAlways(domain, msg)` — an `info`-level entry: always recorded into
 *    the ring (cheap, rare transitions). Use for cross-cutting decisions
 *    the dump must always be able to verify; NOT for hot loops.
 *
 * Domains: `tags` (metadata scanner probes/matches), `sync` (Navidrome load
 * pipeline), `playback` (manager decisions not on the bridge trail), plus
 * the native domains (loader/crossfade/queue/preload/engine/session/artwork)
 * shared for the HUD toggles. The persisted set (localStorage
 * `mmdrome:debugDomains`, comma-separated) is merged with the `?debug=`
 * query param (CSV; bare `?debug` = every domain) so a support URL can
 * pre-enable a domain without HUD navigation.
 *
 * The ring (hard-capped) rides the HUD Copy dump as `jsEvents`. console.debug
 * fires alongside so an attached inspector sees the live stream.
 */

export interface JsDebugEvent {
  t: number
  domain: string
  level: 'danger' | 'info' | 'debug'
  msg: string
}

const RING_LIMIT = 1000
// Native-ring parity (NativeEventLog capacity 1000): a several-hour listening
// session at ~5 info events per track must not evict the danger verdict the
// post-mortem needs. The Copy dump caps what it embeds; the ring holds more.

const entries: JsDebugEvent[] = []

const DOMAINS_KEY = 'mmdrome:debugDomains'

let active: Set<string> = new Set(readPersisted())

function readPersisted(): string[] {
  try {
    const raw = localStorage.getItem(DOMAINS_KEY)
    return raw ? raw.split(',').map((d) => d.trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function readQueryDomains(): string[] | 'all' | null {
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('debug')
    if (raw === null) return null
    const list = raw.split(',').map((d) => d.trim()).filter(Boolean)
    return list.length === 0 ? 'all' : list
  } catch {
    return null
  }
}

/** Effective enabled set = persisted ∪ query. Re-evaluated lazily so a
 *  support URL works even before any HUD interaction. */
function enabledDomains(): Set<string> | 'all' {
  const query = readQueryDomains()
  if (query === 'all') return 'all'
  const merged = new Set(active)
  if (query) for (const d of query) merged.add(d)
  return merged
}

export function isDebugEnabled(domain: string): boolean {
  const enabled = enabledDomains()
  return enabled === 'all' || enabled.has(domain)
}

/** All currently-known domain names (persisted ∪ query ∪ the fixed native
 *  + JS domain taxonomy) — the HUD toggle row renders from this. */
export function knownDomains(): string[] {
  const native = ['loader', 'crossfade', 'queue', 'preload', 'engine', 'session', 'artwork', 'network']
  const js = ['tags', 'sync', 'playback', 'bg', 'global']
  const extras = [...readPersisted()]
  const query = readQueryDomains()
  if (Array.isArray(query)) extras.push(...query)
  return [...new Set([...native, ...js, ...extras])]
}

export function enabledDomainsList(): string[] {
  const enabled = enabledDomains()
  return enabled === 'all' ? knownDomains() : [...enabled].sort()
}

/** Persists the HUD's domain selection and returns the effective list. */
export function setEnabledDomains(domains: string[]): string[] {
  active = new Set(domains)
  try {
    localStorage.setItem(DOMAINS_KEY, domains.join(','))
  } catch { /* private mode — session-only */ }
  return enabledDomainsList()
}

function push(domain: string, level: JsDebugEvent['level'], msg: string): void {
  entries.push({ t: Date.now(), domain, level, msg })
  if (entries.length > RING_LIMIT) entries.shift()
}

/** Debug-level: recorded only when `domain` is enabled. The hot-path cost
 *  when disabled is one Set lookup + string arg evaluation by the caller —
 *  callers must not interpolate expensive work into the call. */
export function dbg(domain: string, msg: string): void {
  if (!isDebugEnabled(domain)) return
  push(domain, 'debug', msg)
  console.debug(`[${domain}] ${msg}`)
}

/** Info-level: always recorded (rare transitions only — never hot loops). */
export function dbgAlways(domain: string, msg: string): void {
  push(domain, 'info', msg)
  console.info(`[${domain}] ${msg}`)
}

/** Danger-level: always recorded — a gate verdict or failure the dump must
 *  be able to verify. Same contract as the native log's danger level. */
export function dbgDanger(domain: string, msg: string): void {
  push(domain, 'danger', msg)
  console.warn(`[${domain}] ${msg}`)
}

export function jsDebugEventsSnapshot(): JsDebugEvent[] {
  return [...entries]
}

export function clearJsDebugEvents(): void {
  entries.length = 0
}

let globalCatchesInstalled = false

/** Global catch-alls (2026-09-20): an UNCAUGHT exception or rejection was
 *  invisible to diagnostics unless the HUD happened to be open when
 *  console.error fired — a crash-shaped failure needs no console call to
 *  exist. Installs `window.error` + `unhandledrejection` handlers that
 *  record into the ring (danger) once per page load. Idempotent; safe to
 *  call from any entry point. */
export function installGlobalDebugCatches(): void {
  if (globalCatchesInstalled) return
  globalCatchesInstalled = true
  try {
    window.addEventListener('error', (e) => {
      // Resource-load errors (img/script) also ride 'error' but carry no
      // ErrorEvent info — record them only with a message.
      const msg = e instanceof ErrorEvent ? e.message : String((e as any)?.target?.constructor?.name ?? 'resource error')
      dbgDanger('global', `uncaught error: ${msg} @ ${e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : 'unknown'}`)
    })
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason
      const name = r instanceof Error ? `${r.name}: ${r.message}` : String(r)
      dbgDanger('global', `unhandled rejection: ${name}`)
    })
  } catch { /* non-browser import (tests) — nothing to catch */ }
}
