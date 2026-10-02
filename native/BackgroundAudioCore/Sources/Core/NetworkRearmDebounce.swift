import Foundation

/// Pure trailing debounce for the native network-change prefetch re-arm
/// (Phase 4, 2026-10-02; plan
/// `docs/plans/2026-10-02-network-churn-and-prefetch-resilience.md`).
///
/// `NWPathMonitor` fires generously during interface churn (the 2026-10-02 dump
/// showed `isExpensive` flipping four times in ~8 s). Re-arming the prefetch
/// chain on every raw update would restart the walk repeatedly and defeat the
/// serial bandwidth discipline; this collapses a burst into ONE re-arm once the
/// path has been quiet for `windowMs`.
///
/// The state is a caller-held value: `noteChange(at:)` on each path update,
/// then `shouldFire(at:)` from a scheduled timer — it returns true exactly
/// once, when `windowMs` has elapsed since the LAST change. The caller
/// schedules its timer for `millisUntilEligible(at:)`, so a burst costs one
/// short timer per change and one re-arm.
///
/// Deliberately classification-free: this only says "the network changed and is
/// quiet now" — it carries no metered/cheap judgement, so no LDM semantics are
/// mirrored into Swift and the re-arm works backgrounded (no JS round trip).
///
/// Pure and `swift test`-hostable (E5) — no engine state, no clocks; `now` is
/// caller-supplied monotonic milliseconds.
public struct NetworkRearmDebounce {
    /// Trailing window: how long the path must be quiet before the re-arm fires.
    public static let defaultWindowMs: Int64 = 2500

    public let windowMs: Int64
    private var lastChangeAt: Int64?

    public init(windowMs: Int64 = NetworkRearmDebounce.defaultWindowMs) {
        self.windowMs = windowMs
        self.lastChangeAt = nil
    }

    /// True while a change is waiting out its window.
    public var isPending: Bool { lastChangeAt != nil }

    /// Record a path change at `now` (monotonic ms). Restarts the window.
    public mutating func noteChange(at now: Int64) {
        lastChangeAt = now
    }

    /// DECISION at `now`: has the window since the last change elapsed? Returns
    /// true ONCE, then goes idle. False while a change is pending inside the
    /// window (the caller reschedules for the remaining time).
    public mutating func shouldFire(at now: Int64) -> Bool {
        guard let last = lastChangeAt, now - last >= windowMs else { return false }
        lastChangeAt = nil
        return true
    }

    /// Milliseconds until the next eligible fire (0 = fire now), or nil when
    /// idle. The caller schedules its timer for exactly this.
    public func millisUntilEligible(at now: Int64) -> Int64? {
        guard let last = lastChangeAt else { return nil }
        return max(0, last + windowMs - now)
    }
}
