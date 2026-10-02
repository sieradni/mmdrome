import Foundation

/// Pure decisions for the sequential prefetch walk (`prefetchUpcoming`).
///
/// The walk visits queue rows next-first, one download PER ROW, completing
/// before the next starts. Two phases:
///
/// 1. **DEDUPE STEP (Phase 1, 2026-10-02).** `step(seen:next:)` returns both
///    dedupe-set snapshots a caller needs — `advancedSet` (row marked seen)
///    for walking on, `retrySet` (pre-insert) for re-attempting. Passing the
///    post-insert set to a retry tripped the already-seen guard and silently
///    no-op'd it (the "preload stops on the 3rd upcoming" report).
///
/// 2. **PARK-AND-DRAIN (Phase 3, 2026-10-02).** The old retry slept INSIDE the
///    serial walk, so one poisoning row held every row behind it for ~4.5 s
///    (3 attempts × 1.5 s) — on a churning link that is the difference between
///    "the window lags" and "the window is empty". The chain now PARKS a failed
///    row and advances the primary walk IMMEDIATELY; once the walk is
///    exhausted it DRAINS the parked rows, oldest first, rotating a still-
///    failing row to the back so the others get a turn. One download is in
///    flight at a time throughout (the bandwidth discipline).
///
/// `State` is a plain value threaded through the engine's async recursion, so
/// the whole decision surface is `swift test`-hostable (E5: CI compiles and
/// tests this; there is no local Swift toolchain).
public enum PrefetchChain {

    // MARK: - Dedupe step (Phase 1)

    /// One walk step's dedupe-set snapshots.
    public struct Step: Equatable {
        /// The set to pass when RE-ATTEMPTING `next` (does not contain `next`).
        public let retrySet: Set<Int>
        /// The set to pass when WALKING ON past `next` (contains `next`).
        public let advancedSet: Set<Int>
    }

    /// DECISION for one step: the snapshots to visit `next`, or nil when the
    /// row is ALREADY seen (the walk must stop — no revisit, no duplicate
    /// download).
    public static func step(seen: Set<Int>, next: Int) -> Step? {
        guard !seen.contains(next) else { return nil }
        var advanced = seen
        advanced.insert(next)
        return Step(retrySet: seen, advancedSet: advanced)
    }

    // MARK: - Park-and-drain chain (Phase 3)

    /// A row the primary walk passed over after a failure, awaiting drain.
    public struct Parked: Equatable, Sendable {
        /// Queue row index of the failed download.
        public var index: Int
        /// Failed attempts spent on this row so far (1 after the first walk try).
        public var attempts: Int
        public init(index: Int, attempts: Int) {
            self.index = index
            self.attempts = attempts
        }
    }

    /// The whole chain's dedupe + parked state, threaded through the engine.
    public struct State: Equatable, Sendable {
        public var seen: Set<Int>
        public var parked: [Parked]
        public init(seen: Set<Int> = [], parked: [Parked] = []) {
            self.seen = seen
            self.parked = parked
        }
    }

    /// The next thing the chain must do.
    public enum Action: Equatable, Sendable {
        /// Download the primary-walk row at `index`.
        case download(index: Int)
        /// Re-attempt the parked row at `index` (this will be attempt number
        /// `attempt`, 1-based).
        case retry(index: Int, attempt: Int)
        /// Nothing left: the walk is done and no parked row can be retried.
        case finished
    }

    /// DECISION for the chain's next step.
    ///
    /// The primary walk leads while it has an unseen candidate inside the
    /// window (`seen.count < totalCount` AND `step` accepts the candidate).
    /// Only when the walk cannot advance does the drain run: the FIRST parked
    /// row with attempts remaining. `walkCandidate` is caller-owned (it
    /// encodes loop-mode wrapping) — pass nil at the end of the queue.
    public static func nextAction(
        state: State,
        totalCount: Int,
        maxAttempts: Int,
        walkCandidate: Int?
    ) -> Action {
        if state.seen.count < totalCount, let candidate = walkCandidate,
           step(seen: state.seen, next: candidate) != nil {
            return .download(index: candidate)
        }
        for parked in state.parked where parked.attempts < maxAttempts {
            return .retry(index: parked.index, attempt: parked.attempts + 1)
        }
        return .finished
    }

    /// Apply a PRIMARY-WALK download outcome. The row is always marked seen
    /// (so the walk never revisits it); a failure with retries available is
    /// PARKED for the drain. `maxAttempts <= 1` means retries are disabled —
    /// the failure simply walks on.
    public static func applyDownload(
        state: State,
        index: Int,
        success: Bool,
        maxAttempts: Int
    ) -> State {
        var next = state
        next.seen.insert(index)
        if !success, maxAttempts > 1 {
            next.parked.append(Parked(index: index, attempts: 1))
        }
        return next
    }

    /// Apply a DRAIN retry outcome for the parked row at `index`.
    ///
    /// - success OR the attempt count reached `maxAttempts` → drop the row
    ///   (done, or given up).
    /// - otherwise → the row is rotated to the BACK of the parked list with
    ///   the spent attempt recorded, so other parked rows get a turn before
    ///   it is retried again.
    public static func applyRetry(
        state: State,
        index: Int,
        attempt: Int,
        success: Bool,
        maxAttempts: Int
    ) -> State {
        var next = state
        guard let pos = next.parked.firstIndex(where: { $0.index == index }) else { return next }
        if success || attempt >= maxAttempts {
            next.parked.remove(at: pos)
        } else {
            var row = next.parked.remove(at: pos)
            row.attempts = attempt
            next.parked.append(row)
        }
        return next
    }
}
