/**
 * Bounded LRU "recently heard" window that shapes the auto-queue fill.
 *
 * Owned exclusively by queueManager: `inscribeRecent` is the single write path
 * (a track enters the window the moment it leaves the active slot — ended,
 * skipped, or removed from a queue). `replenishAutoQueue`/`rebuildAutoQueue`
 * exclude the window from fresh fills and re-admit its members only when the
 * eligible pool runs short (rotation instead of starvation).
 *
 * Persisted inside the playQueue row, so the anti-repeat memory survives
 * restarts; `sanitizeRecent` is the load-time dedupe + cap.
 *
 * TWO numbers (2026-11-01):
 *  - `RECENT_LIMIT` is the DEFAULT HORIZON — how many plays count as "recent",
 *    overridable by the user through Settings → Playback (`autoQueueRecentLimit`).
 *  - `RECENT_LIMIT_MAX` is the STORAGE cap. The window is kept up to the max
 *    and the horizon is applied at READ time (`effectiveRecent`), so shrinking
 *    the setting and raising it again RECOVERS the history instead of having
 *    silently discarded it. A destructive trim would make the setting one-way.
 */

export const RECENT_LIMIT = 100
export const RECENT_LIMIT_MAX = 500
export const RECENT_LIMIT_MIN = 0

/**
 * Pure LRU inscription: removes any earlier occurrence of `trackId`, appends it
 * as the newest entry, and caps at `limit` by dropping the OLDEST entries.
 * Array order is exactly recency order (newest last), duplicates never waste
 * cap space, and re-playing a cooled-down track refreshes its recency.
 */
export function inscribeRecent(arr: string[], trackId: string, limit = RECENT_LIMIT_MAX): string[] {
  if (arr[arr.length - 1] === trackId) return arr
  const next = arr.filter((id) => id !== trackId)
  next.push(trackId)
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * Load-time sanitizer: dedupes keeping the LAST occurrence (newest position)
 * and caps at `limit` keeping the newest entries. Tolerates legacy or foreign
 * persisted data (old `historyQueue` rows, duplicate inscriptions).
 */
export function sanitizeRecent(arr: string[] | undefined, limit = RECENT_LIMIT_MAX): string[] {
  if (!arr || arr.length === 0) return []
  const seen = new Set<string>()
  const deduped: string[] = []
  for (let i = arr.length - 1; i >= 0; i--) {
    const id = arr[i]
    if (seen.has(id)) continue
    seen.add(id)
    deduped.push(id)
  }
  deduped.reverse()
  return deduped.length > limit ? deduped.slice(deduped.length - limit) : deduped
}

/** Clamps a user-chosen horizon into the storable band. */
export function clampRecentLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return RECENT_LIMIT
  return Math.min(RECENT_LIMIT_MAX, Math.max(RECENT_LIMIT_MIN, Math.round(limit)))
}

/**
 * The exclusion set the fill sees: the newest `limit` entries of the stored
 * window. `limit >= length` returns the window untouched; `0` disables the
 * cool-down entirely (nothing is held back).
 */
export function effectiveRecent(ids: readonly string[], limit: number): string[] {
  const n = clampRecentLimit(limit)
  if (n === 0) return []
  if (ids.length <= n) return [...ids]
  return ids.slice(ids.length - n)
}
