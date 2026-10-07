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

export interface StreamEpochTrailEvent {
  phase: 'open' | 'verdict' | 'closed'
  epoch?: number
  base?: number
  target?: number
  verdict?: string
  containerFrames?: number
  expectedFrames?: number
}

/**
 * The SEEK EPOCH actor's trail line (2026-10-07, Phase 2).
 *
 * The trail knows only `engage` and `refreshQueue` as positioners today, and a
 * multi-skip dump reads it to decide whether JS or the engine moved the
 * playhead. A server-offset epoch is a THIRD positioner — the engine starts a
 * new transfer at an arbitrary offset and re-bases the timeline on it — so it
 * must be named in the same timeline with `epoch` as the actor; otherwise the
 * next investigation blames the wrong side. Pure (no imports) so the formatter
 * is unit-pinned.
 */
export function epochTrailLine(event: StreamEpochTrailEvent): string {
  const parts: string[] = [`epoch ${event.phase}`]
  if (event.epoch != null) parts.push(`#${event.epoch}`)
  if (event.base != null) parts.push(`base=${event.base}s`)
  if (event.target != null) parts.push(`target=${event.target.toFixed(1)}s`)
  if (event.verdict) parts.push(`verdict=${event.verdict}`)
  if (event.containerFrames != null) parts.push(`container=${event.containerFrames}f`)
  if (event.expectedFrames != null) parts.push(`expected=${event.expectedFrames}f`)
  return parts.join(' ')
}

export function nativeBridgeTrailSnapshot(): NativeBridgeTrailEntry[] {
  return [...entries]
}

export function clearNativeBridgeTrail(): void {
  entries.length = 0
}
