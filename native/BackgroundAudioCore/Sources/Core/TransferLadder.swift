import Foundation

/// The transfer priority ladder — its HOLD half (2026-10-07, follow-up to
/// Phase 2 of `docs/plans/2026-10-07-seek-intent-and-stream-epochs.md`).
///
/// Verified facts this encodes (read from the source, not assumed):
///   • the prefetch walk is SERIAL — `PrefetchChain.nextAction` plus "one
///     download in flight at a time" (the walk's own contract);
///   • a direct-tap staged load deliberately never arms the walk — its writer
///     owns the bandwidth and the chain arms at the writer's completion;
///   • a seek EPOCH is a second user-initiated transfer and CAN begin while a
///     chain started by an earlier row is mid-walk — that is the one overlap
///     this hold closes (a seek never queues behind a prefetch, so only
///     bandwidth competition remains);
///   • the network re-arm's skip (`stagedSchedule == nil,
///     !hasActiveWriter`) covers an epoch only INCIDENTALLY, through
///     `hasActiveWriter` happening to count ephemeral epoch writers.
///
/// The rule: speculative bytes (queue-tail prefetch) never outrank a
/// user-initiated transfer. The walk is HELD while one is live and re-armed by
/// the settle edges (`rearmPrefetchIfIdle`), exactly like the staged-load
/// discipline that already exists.
///
/// Deliberately NOT here: cancellation-based PREEMPTION of an in-flight
/// prefetch. That needs the download lane's deliberate-cancel veto (a
/// cancelled `downloadTask` reads as a row failure today: `gone` tint,
/// retry-branch accounting, a park) and, per the plan's deferred register, a
/// measurement first.
///
/// Pure and dependency-free (`swift test`-hostable, E5).
public enum TransferLadder {

    /// Everything the hold reads. A plain value so the decision matrix is
    /// unit-testable without an engine.
    public struct UserTransfer: Equatable {
        /// A staged schedule owns the playing row (its writer may be between
        /// deliveries — the schedule is still waiting on its bytes).
        public var stagedActive: Bool
        /// A byte writer is in flight (row writer or epoch writer).
        public var writerLive: Bool
        /// A seek epoch exists — set from the moment the request is on the
        /// wire, BEFORE its first delivery (that window is precisely when a
        /// competing prefetch hurts most: it splits the link while the user is
        /// waiting for the epoch's header).
        public var epochOpen: Bool
        /// The ACTIVE row's own download task is in flight (the tap that
        /// started it is waiting on those bytes).
        public var activeLoadInFlight: Bool

        public init(
            stagedActive: Bool = false,
            writerLive: Bool = false,
            epochOpen: Bool = false,
            activeLoadInFlight: Bool = false
        ) {
            self.stagedActive = stagedActive
            self.writerLive = writerLive
            self.epochOpen = epochOpen
            self.activeLoadInFlight = activeLoadInFlight
        }
    }

    /// Why the walk is held. The value is the log label (and the reason a dump
    /// names), never a permission: every non-`.none` value means "do not start
    /// speculative bytes".
    public enum Hold: String, Equatable {
        case none
        case seekEpoch
        case stagedStream
        case activeLoad
    }

    /// THE predicate: does a user-initiated transfer own the link right now?
    /// The network re-arm's skip uses THIS (never `hasActiveWriter` directly),
    /// so an epoch in flight is held explicitly and a future refactor that
    /// narrows `hasActiveWriter` cannot silently start a prefetch mid-epoch.
    public static func ownsBandwidth(_ t: UserTransfer) -> Bool {
        t.epochOpen || t.stagedActive || t.writerLive || t.activeLoadInFlight
    }

    /// The reason label, with precedence for readability only (an epoch is the
    /// narrowest, most user-visible transfer; a staged stream is long-lived; an
    /// active download is the row's own load).
    public static func hold(_ t: UserTransfer) -> Hold {
        if t.epochOpen { return .seekEpoch }
        if t.stagedActive || t.writerLive { return .stagedStream }
        if t.activeLoadInFlight { return .activeLoad }
        return .none
    }

    /// May the prefetch walk issue its next row?
    public static func mayIssueNextPrefetch(_ t: UserTransfer) -> Bool {
        !ownsBandwidth(t)
    }
}
