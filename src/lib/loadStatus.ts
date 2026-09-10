/**
 * Load-status core — pure, DOM-free helpers behind the playback load UI
 * (buffered seek-bar layer, preload fills). F2: all policy lives here so it
 * can be unit-tested; the stores (`stores/loadStatus.ts`) and the adapters
 * (`bufferMonitor.ts`, `preloader.ts`) are thin interpreters over it.
 *
 * Honesty rules (the UI must never invent precision):
 * - Streamed bytes are unknowable — the element only exposes buffered TIME
 *   ranges. The seek bar renders those ranges, never a fake byte percent.
 * - Preload byte progress exists ONLY when the response carries a
 *   Content-Length; otherwise the entry stays indeterminate (`progress: null`)
 *   and the UI pulses instead of filling.
 */

export interface BufferedRange {
  start: number
  end: number
}

/** Minimal TimeRanges shape — the real `TimeRanges` satisfies this structurally. */
export interface BufferedSource {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

/**
 * Normalizes raw buffered ranges for display: drops non-finite/empty ranges,
 * clamps to [0, duration], sorts by start, and merges overlaps/touching
 * ranges. Returns [] when duration is unknown (nothing can be mapped).
 */
export function normalizeBufferedRanges(
  buffered: BufferedSource | null | undefined,
  duration: number,
): BufferedRange[] {
  if (!buffered || !(duration > 0) || !isFinite(duration)) return []
  const raw: BufferedRange[] = []
  for (let i = 0; i < buffered.length; i++) {
    let s: number
    let e: number
    try {
      s = buffered.start(i)
      e = buffered.end(i)
    } catch {
      continue
    }
    if (!isFinite(s) || !isFinite(e) || e <= s) continue
    s = Math.min(Math.max(s, 0), duration)
    e = Math.min(Math.max(e, 0), duration)
    if (e <= s) continue
    raw.push({ start: s, end: e })
  }
  // TimeRanges order is unspecified — sort before merging so an early range
  // can absorb a later overlapping one regardless of iteration order.
  raw.sort((a, b) => a.start - b.start)
  const out: BufferedRange[] = []
  for (const r of raw) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end
    } else {
      out.push({ ...r })
    }
  }
  return out
}

export interface RangeFill {
  /** Left offset as % of the track width. */
  left: number
  /** Width as % of the track width. */
  width: number
}

/** Maps normalized ranges to CSS percentages over `duration`. */
export function bufferedRangeFills(ranges: BufferedRange[], duration: number): RangeFill[] {
  if (!(duration > 0) || !isFinite(duration)) return []
  return ranges.map((r) => ({
    left: (r.start / duration) * 100,
    width: ((r.end - r.start) / duration) * 100,
  }))
}

/** Clamps a seek target into [0, duration] (duration<=0 → 0). */
export function clampSeekTime(value: number, duration: number): number {
  if (!(duration > 0) || !isFinite(duration)) return 0
  if (!isFinite(value)) return 0
  return Math.min(Math.max(value, 0), duration)
}

// --- Preload entries ---------------------------------------------------------

export type PreloadEntryState = 'fetching' | 'cached' | 'dead'

export interface PreloadEntry {
  state: PreloadEntryState
  /** 0..1 byte progress while fetching; null = indeterminate (no Content-Length). */
  progress: number | null
}

function clampProgress(p: number): number {
  if (!isFinite(p)) return 0
  return Math.min(Math.max(p, 0), 1)
}

export type PreloadEvent =
  | { type: 'start'; trackId: string }
  | { type: 'progress'; trackId: string; progress: number }
  | { type: 'done'; trackId: string }
  | { type: 'dead'; trackId: string }
  | { type: 'evict'; trackId: string }
  | { type: 'reset' }

/**
 * Immutable reducer for the preload status map (keyed by trackId).
 * - `start` (re)opens a fetching entry with indeterminate progress.
 * - `progress` only advances a fetching entry (stale events after done/dead
 *   are ignored by construction).
 * - `done` → cached with progress 1; `dead` sticks until evicted/reset.
 * - `evict` removes the entry (row left the window / retry reset / cleanup).
 */
export function applyPreloadEvent(
  map: Record<string, PreloadEntry>,
  event: PreloadEvent,
): Record<string, PreloadEntry> {
  if (event.type === 'reset') return {}
  const next: Record<string, PreloadEntry> = { ...map }
  switch (event.type) {
    case 'start': {
      const cur = next[event.trackId]
      // Same-reference early-outs: Svelte skips notifying when `update`
      // returns the identical object, so steady-state re-emits (a cached row
      // re-reported every 1 s poll tick) never re-render the queue.
      if (cur && cur.state === 'fetching' && cur.progress === null) return map
      next[event.trackId] = { state: 'fetching', progress: null }
      break
    }
    case 'progress': {
      const cur = next[event.trackId]
      if (!cur || cur.state !== 'fetching') break
      const p = clampProgress(event.progress)
      if (cur.progress === p) return map
      next[event.trackId] = { state: 'fetching', progress: p }
      break
    }
    case 'done': {
      const cur = next[event.trackId]
      if (cur && cur.state === 'cached') return map
      next[event.trackId] = { state: 'cached', progress: 1 }
      break
    }
    case 'dead': {
      const cur = next[event.trackId]
      if (cur && cur.state === 'dead') return map
      next[event.trackId] = { state: 'dead', progress: null }
      break
    }
    case 'evict':
      if (!(event.trackId in next)) return map
      delete next[event.trackId]
      break
  }
  return next
}

/**
 * Fill percent for ambient preload surfaces (queue-row tint, Now Playing
 * segments): cached → 100, fetching with known progress → p·100, everything
 * else → null (render indeterminate / nothing).
 */
export function preloadFillPercent(entry: PreloadEntry | undefined): number | null {
  if (!entry) return null
  if (entry.state === 'cached') return 100
  if (entry.state === 'fetching' && entry.progress !== null) return entry.progress * 100
  return null
}
