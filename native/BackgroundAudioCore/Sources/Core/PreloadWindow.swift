import Foundation

/// Pure derivation of the VISIBLE preload window: the track ids the engine's
/// sequential prefetch chain is (or was last) filling, walked in queue order
/// from the playing row. Replaces the old JS-pushed `setPreloadWindow` set —
/// that push rode BEFORE each snapshot bridge call, and every snapshot path
/// (`setQueue`/`setQueueAndPlay`/`refreshQueue`) reset the stored window to
/// nil AFTER, so the engine permanently ran unsynced and the instant
/// completion hook (nil = "report nothing" under the old guard) silently
/// dropped almost every `done` — the "only one row ever shows preloaded"
/// report (2026-09-14). The engine owns the queue, active index and loop
/// mode, so deriving here is ordering-proof and needs no bridge round-trip.
///
/// Mirrors `prefetchUpcoming`'s walk exactly (next-first, wrap under
/// loop-all, never the playing row itself) so the reported window can never
/// disagree with what is actually downloading.
public func preloadWindowIndexes(
    activeIndex: Int,
    trackCount: Int,
    count: Int,
    loopAll: Bool
) -> [Int] {
    guard count > 0, trackCount > 0 else { return [] }
    var out: [Int] = []
    var seen = Set<Int>()
    var cursor = activeIndex
    while out.count < count {
        var next = cursor + 1
        if next >= trackCount {
            guard loopAll else { break }
            next = 0
        }
        guard next != activeIndex, seen.insert(next).inserted else { break }
        out.append(next)
        cursor = next
    }
    return out
}
