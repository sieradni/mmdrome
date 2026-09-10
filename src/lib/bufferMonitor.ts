/**
 * Buffer monitor — thin adapter that mirrors the active element's buffered
 * TimeRanges into the `bufferedRanges` store for the shared SeekBar.
 *
 * Design notes:
 * - Node-safe: no DOM access at import time; elements arrive via injection.
 * - Web-only by call-site gating (native has no HTMLAudio element — the
 *   store simply stays empty there and the SeekBar degrades to no gray layer).
 * - Writes are change-gated (ranges rounded to 0.1 s) so the 1 s poll never
 *   re-renders the player when nothing moved.
 * - Reads the CURRENT active element on every sample (the a/b crossfade
 *   switch flips it), but listens on all injected elements for prompt updates.
 */

import { normalizeBufferedRanges, type BufferedRange } from './loadStatus'
import { bufferedRanges } from '../stores/loadStatus'

export interface BufferMonitorDeps {
  /** All elements that can carry the current track (a/b foreground pair). */
  getElements: () => HTMLAudioElement[]
  /** The element currently driving playback/output. */
  getActiveElement: () => HTMLAudioElement | null
  /** Metadata duration (A1 truth) for range normalization. */
  getDuration: () => number
  pollMs?: number
}

function snapshotKey(ranges: BufferedRange[]): string {
  return ranges.map((r) => `${r.start.toFixed(1)}-${r.end.toFixed(1)}`).join(',')
}

export function setupBufferMonitor(deps: BufferMonitorDeps): () => void {
  const pollMs = deps.pollMs ?? 1000
  let lastKey = ''
  let disposed = false

  const sample = (): void => {
    if (disposed) return
    let ranges: BufferedRange[] = []
    try {
      const el = deps.getActiveElement()
      if (el) ranges = normalizeBufferedRanges(el.buffered, deps.getDuration())
    } catch {
      ranges = []
    }
    const key = snapshotKey(ranges)
    if (key !== lastKey) {
      lastKey = key
      bufferedRanges.set(ranges)
    }
  }

  const onEmptied = (): void => {
    lastKey = ''
    bufferedRanges.set([])
  }

  const elements = deps.getElements()
  for (const el of elements) {
    el.addEventListener('progress', sample)
    el.addEventListener('loadedmetadata', sample)
    el.addEventListener('emptied', onEmptied)
  }
  sample()
  const timer = setInterval(sample, pollMs)

  return () => {
    disposed = true
    clearInterval(timer)
    for (const el of elements) {
      el.removeEventListener('progress', sample)
      el.removeEventListener('loadedmetadata', sample)
      el.removeEventListener('emptied', onEmptied)
    }
  }
}
