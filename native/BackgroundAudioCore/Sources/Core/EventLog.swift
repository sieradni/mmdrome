import Foundation

/// Structured engine event log — the native counterpart of the JS bridge
/// trail and the REPLACEMENT for bare `print()` diagnostics (2026-09-19).
///
/// Why: the engine's danger verdicts (premature-completion drops, evictions,
/// crossfade aborts, stale drops, engine-start failures) were `print()`ed to
/// the Xcode console — invisible to the user's Debug HUD Copy dump, which is
/// the ONLY feedback channel from a phone without a Mac attached. Every
/// danger must be verifiable from the dump, so the log rides the bridge
/// (`getDebugEvents`) instead of stdout.
///
/// Volume contract (organized, not a firehose):
///  - `danger`  — gate verdicts, failures, evictions, aborts. ALWAYS recorded.
///  - `info`    — state transitions (schedule/advance/finalize/abort/seek/
///                param changes). ALWAYS recorded — they are rare by design.
///  - `debug`   — verbose flow (per-download details, ramp internals, chain
///                steps). Recorded ONLY when the entry's domain is active
///                (`setDebugDomains`); write-time gated so an inactive domain
///                costs nothing and the dump stays clean. Library-level
///                verbosity (tags/scanning) lives JS-side under the same
///                domain model, also opt-in.
///
/// Pure data: no clocks, no singletons — the adapter injects a monotonic
/// timestamp. Pinned by EventLogTests (ring eviction, seq monotonicity,
/// domain gating, sinceSeq/limit reads).
public struct NativeEvent: Equatable, Sendable {
    public enum Level: String, Sendable {
        case danger, info, debug
    }

    public let seq: Int
    /// Monotonic seconds since process start (adapter-supplied) — ordering +
    /// gap sizing in the HUD, stable across the ring's lifetime.
    public let t: Double
    public let domain: String
    public let level: Level
    public let message: String
}

public struct NativeEventLog: Sendable {
    public let capacity: Int
    public private(set) var events: [NativeEvent] = []
    /// Monotonic across the log's lifetime (NOT reset by eviction) — the
    /// bridge watermark (`getDebugEvents(sinceSeq:)`) keys on it.
    public private(set) var nextSeq: Int = 0
    /// How many entries the ring evicted head-first — the HUD shows a
    /// "dropped N" marker so a full buffer is never mistaken for the truth.
    public private(set) var droppedCount: Int = 0
    public private(set) var activeDomains: Set<String> = []

    /// 1000 (2026-09-19, raised from 400): the ring must outlive a LONG
    /// session with the HUD closed — the post-mortem contract is "bug fires
    /// → user opens the HUD → the danger verdict is still there". At ~5 info
    /// events per track advance, 400 wrapped inside a 2–3 hour listening
    /// session; 1000 covers it with headroom (~100 KB memory).
    public init(capacity: Int = 1000, activeDomains: Set<String> = []) {
        self.capacity = capacity
        self.activeDomains = activeDomains
    }

    public mutating func setActiveDomains(_ domains: Set<String>) {
        activeDomains = domains
    }

    public mutating func add(now: Double, domain: String, level: NativeEvent.Level, _ message: String) {
        if level == .debug && !activeDomains.contains(domain) { return }
        if events.count >= capacity {
            events.removeFirst(1)
            droppedCount += 1
        }
        events.append(NativeEvent(seq: nextSeq, t: now, domain: domain, level: level, message: message))
        nextSeq += 1
    }

    /// Events newer than `sinceSeq` (the caller's watermark), oldest first,
    /// capped at `limit` from the NEWEST side so a first full pull never
    /// floods the bridge with stale rows.
    public func events(sinceSeq: Int, limit: Int = Int.max) -> [NativeEvent] {
        let newer = events.filter { $0.seq > sinceSeq }
        guard newer.count > limit else { return newer }
        return Array(newer.suffix(limit))
    }
}
