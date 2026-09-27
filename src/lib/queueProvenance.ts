/**
 * Auto-queue fill provenance (2026-09-27) — which TIER (1 fresh / 2 cool-down
 * / 3 rotation) admitted each auto row at its most recent fill. The HUD Copy
 * dump renders the groups (`js.queueProvenance`), so a queue-replay report
 * shows exactly where each song came from: a tier-3-heavy dump is the
 * exhausted-pool signature; `unknown` rows entered the auto section WITHOUT a
 * fill (Dexie restore, drag-convert, clearQueue residue) — provenance is
 * genuinely unknown there, never invented.
 *
 * Hermetic (zero imports) like `nativeBridgeTrail`: the map is module state,
 * bounded by the auto queue itself — `syncFillProvenance` walks the CURRENT
 * auto queue and drops every id no longer queued, so a stale entry can never
 * outlive its row (rows removed between fills leave orphaned map entries, but
 * they are invisible — the dump groups only current queue rows — and the
 * next fill prunes them). A kept-prefix row RETAINS its original tier across
 * replenishes; a row's tier only changes when a FILL re-admits it.
 *
 * NOT persisted: the map dies with the session, and a restored queue is
 * honestly `unknown` until its next fill. Do NOT persist it (the playQueue
 * row's schema is a stability boundary for zero diagnostic gain) and do NOT
 * wire it into any playback behavior — it is a read-only diagnostic mirror.
 */

export type FillTier = 1 | 2 | 3

/** The pure plan's per-stage membership (`AutoQueueFillPlan.tiers`). */
export interface FillTiers {
  1: readonly string[]
  2: readonly string[]
  3: readonly string[]
}

/** Dump shape: queue-order id groups per tier + `unknown` for non-fill rows. */
export interface FillProvenanceGroups {
  1: string[]
  2: string[]
  3: string[]
  unknown: string[]
}

let provenance = new Map<string, FillTier>()

/**
 * Re-syncs the map to exactly the current auto queue after a fill. `freshTiers`
 * is the plan's per-stage membership (the rows THIS fill just sliced in — the
 * manager passes it verbatim from `planAutoQueueFill`): a fresh assignment
 * wins (a re-admitted row takes its LATEST tier), a retained kept-prefix row
 * keeps its old tier, and an id with no entry stays unknown (omitted). Ids no
 * longer in `autoQueue` are dropped.
 */
export function syncFillProvenance(autoQueue: readonly string[], freshTiers: FillTiers): void {
  const fresh = new Map<string, FillTier>()
  for (const id of freshTiers[1]) fresh.set(id, 1)
  for (const id of freshTiers[2]) fresh.set(id, 2)
  for (const id of freshTiers[3]) fresh.set(id, 3)
  const next = new Map<string, FillTier>()
  for (const id of autoQueue) {
    const tier = fresh.get(id) ?? provenance.get(id)
    if (tier !== undefined) next.set(id, tier)
  }
  provenance = next
}

/** The tier that admitted `trackId`, or null when it never came from a fill. */
export function fillTierOf(trackId: string): FillTier | null {
  return provenance.get(trackId) ?? null
}

/** Dump groups for the CURRENT auto queue, in queue order. */
export function fillProvenanceGroups(autoQueue: readonly string[]): FillProvenanceGroups {
  const groups: FillProvenanceGroups = { 1: [], 2: [], 3: [], unknown: [] }
  for (const id of autoQueue) {
    const tier = provenance.get(id)
    if (tier === 1 || tier === 2 || tier === 3) groups[tier].push(id)
    else groups.unknown.push(id)
  }
  return groups
}

/** Test/session reset. */
export function resetFillProvenance(): void {
  provenance = new Map()
}
