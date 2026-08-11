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
 */

export const RECENT_LIMIT = 100

/**
 * Pure LRU inscription: removes any earlier occurrence of `trackId`, appends it
 * as the newest entry, and caps at `limit` by dropping the OLDEST entries.
 * Array order is exactly recency order (newest last), duplicates never waste
 * cap space, and re-playing a cooled-down track refreshes its recency.
 */
export function inscribeRecent(arr: string[], trackId: string, limit = RECENT_LIMIT): string[] {
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
export function sanitizeRecent(arr: string[] | undefined, limit = RECENT_LIMIT): string[] {
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