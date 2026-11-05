/**
 * D-03: pure formatter for the native event-ring saturation line.
 *
 * The native ring publishes two hygiene counters now (coalescedDebug,
 * debugEvictedForHeadroom) alongside the older `dropped`. This formatter is
 * the ONE place that renders them, so the HUD line and any future consumer
 * agree on the wording. An older native build omits the new counters — the
 * line then degrades to the dropped-only shape. Pure, import-free (F2).
 */

export interface RingSaturationPage {
  dropped: number
  coalescedDebug?: number
  debugEvictedForHeadroom?: number
}

/** Defaults to 0, matching the non-native/failure fallbacks. */
export function coalescedDebugOf(page: RingSaturationPage): number {
  return page.coalescedDebug ?? 0
}

/** Defaults to 0, matching the non-native/failure fallbacks. */
export function debugEvictedForHeadroomOf(page: RingSaturationPage): number {
  return page.debugEvictedForHeadroom ?? 0
}

export function formatRingSaturationLine(page: RingSaturationPage): string {
  const base = `ring dropped ${page.dropped}`
  if (page.coalescedDebug === undefined && page.debugEvictedForHeadroom === undefined) {
    return base
  }
  return `${base} · coalesced ${coalescedDebugOf(page)} · headroom-evict ${debugEvictedForHeadroomOf(page)}`
}
