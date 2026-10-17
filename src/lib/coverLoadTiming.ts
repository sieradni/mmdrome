/** One measurement per armed URL, including replacements in a reused row. */
export function createCoverLoadTiming(now: () => number = () => performance.now()) {
  let pending: { url: string; start: number } | null = null
  return {
    begin(url: string | null): void {
      pending = url === null ? null : { url, start: now() }
    },
    finish(url: string | null): number | null {
      if (pending === null || url !== pending.url) return null
      const elapsed = Math.max(0, now() - pending.start)
      pending = null
      return elapsed
    },
  }
}
