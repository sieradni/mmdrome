/**
 * Bounded diagnostic trail of the native bridge boundary (2026-09-16).
 *
 * The "skip jumps several songs ahead, landing on the last preloaded row"
 * report (recurrence of the 2026-09-14 skip-two investigation) has exactly
 * two candidate actors that static tracing could not discriminate:
 *  1. the ENGINE advancing twice (a completion/generation guard gap), or
 *  2. JS sending a far-out activeIndex via `engage`/`refreshQueue`
 *     (the only two bridge calls that can position the engine on an
 *     arbitrary row — every engine-internal advance is single-step).
 *
 * This trail records BOTH sides of the boundary in one timeline: the
 * queue-positioning bridge commands JS issued (cmd) and the engine events
 * that came back (event). On the next occurrence the Debug HUD Copy dump
 * answers the discriminator directly:
 *  - two `event trackChanged` entries with NO `cmd engage`/`cmd
 *    refreshQueue` between them → the engine advanced itself (a Swift
 *    guard gap — take the Xcode log too, it carries the completion prints);
 *  - an `event trackChanged` (old id) followed by `cmd engage@k`/`cmd
 *    refreshQueue@k` with a large k, then `event trackChanged` (the far id)
 *    → JS positioned the engine (a JS store/index bug).
 *
 * Pure data only — no imports (the nativeTransport suite runs under plain
 * node), no timestamps beyond Date.now(), hard-capped so a long session
 * cannot grow it unboundedly. Read via `nativeBridgeTrailSnapshot` (the
 * Debug HUD copy payload + panel); cleared from the HUD.
 */

export interface NativeBridgeTrailEntry {
  /** Wall-clock ms (Date.now()) — ordering + gap sizing in the HUD dump. */
  t: number
  kind: 'cmd' | 'event'
  /** Compact human-readable description (e.g. `engage[24]@3`, `trackChanged navidrome-xx`). */
  name: string
}

const LIMIT = 200

const entries: NativeBridgeTrailEntry[] = []

export function trailBridge(kind: NativeBridgeTrailEntry['kind'], name: string): void {
  entries.push({ t: Date.now(), kind, name })
  if (entries.length > LIMIT) entries.shift()
}

export function nativeBridgeTrailSnapshot(): NativeBridgeTrailEntry[] {
  return [...entries]
}

export function clearNativeBridgeTrail(): void {
  entries.length = 0
}
