import { saveQueue, type PlayQueueState } from './db'
import { dbgAlways } from './debugLog'

const reported = new Set<string>()

/**
 * Fire-and-forget queue persistence, made visible once per source per session
 * (A3, 2026-10-09; the 2026-10-08 dump showed 20 unhandled `AbortError`
 * rejections across 13/17 advances — every one of them an unhandled promise
 * rejection with no line in the ring to correlate it with).
 *
 * The in-memory store stays authoritative — a failed write is a staleness bug,
 * never a playback bug — but it must be NAMED: the first failure per call site
 * logs one info line (with the error's own name, so an AbortError is not read
 * as a duplicate), and later failures from the same source stay silent so a
 * reconnect storm cannot flood the dump. The `source` label is per call site
 * on purpose: it is the evidence the next dump needs to attribute the cluster.
 */
export function persistQueue(source: string, q: Omit<PlayQueueState, 'id'>): void {
  saveQueue(q).catch((err: unknown) => {
    const name = (err as { name?: string })?.name ?? 'Error'
    if (reported.has(source)) return
    reported.add(source)
    dbgAlways(
      'sync',
      `queue persist failed (${source}): ${name} — in-memory queue unchanged; further ${source} failures suppressed this session`,
    )
  })
}
