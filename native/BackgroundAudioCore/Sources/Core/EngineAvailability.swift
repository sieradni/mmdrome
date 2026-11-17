import Foundation

/// Whether the engine may be asked to start, and whether the user has been
/// TOLD it is unavailable. `EngineRecoveryPolicy` answers "what should happen
/// after this failure"; this core answers "what may happen next at all".
///
/// WHY the two are separate (2026-11-17 field dump): the engine kept emitting
/// `rebuild start failed — recovery remains pending` while the player sat
/// paused at 0:00 with a fully loaded bar. The ladder itself was bounded, but
/// its surfaced flag was not durable — an interruption `.ended` cleared
/// `engineUnavailable`, fired `onEngineRecovered` (so JS cleared the restart
/// banner without a single successful start) and zeroed the failure run. Every
/// following Play then re-walked retry → rebuild → failed start, forever, with
/// the graph being torn down each time. The same flag also GATED starts, so a
/// deliberate Play while surfaced was silently dropped — the dead end the user
/// reported as "I could not play anything".
///
/// The model:
///   • `surfaced`      — JS was told the engine is unavailable. Cleared ONLY by
///                       a successful start (which is also what authorizes the
///                       `engineRecovered` announcement).
///   • `startGateClosed` — automatic attempts are blocked (stop thrashing).
///                       Re-opened by an interruption ending, an explicit user
///                       Play/restart, or a media-services invalidation, so an
///                       attempt CAN prove the engine healthy again.
///   • `rebuildsSinceHealthy` — a rebuild budget that survives run resets. A
///                       session invalidation storm, an interruption flap, or a
///                       user tapping Play cannot authorize unlimited graph
///                       teardowns; past the budget every failure surfaces.
///
/// Pure and dependency-free (`swift test`-hostable, E5).
public struct EngineAvailability: Equatable {

    /// How many full graph rebuilds one healthy-start window may authorize.
    /// A rebuild is expensive (torn-down graph, fresh nodes, re-activation) and
    /// has never been evidence that a THIRD one will succeed: past this bound a
    /// failure surfaces for the user's explicit restart instead.
    public static let maximumRebuildsSinceHealthy = 3

    /// 1-based count of consecutive failed start attempts in the current run.
    public private(set) var consecutiveFailures = 0
    /// Rebuilds authorized since the last successful start.
    public private(set) var rebuildsSinceHealthy = 0
    /// The user has been told (or must be told) the engine is unavailable.
    public private(set) var surfaced = false
    /// Automatic start attempts are blocked.
    public private(set) var startGateClosed = false

    public init() {}

    /// True when `ensureEngineRunning` must short-circuit an AUTOMATIC attempt.
    /// An explicit Play/restart is still allowed to open the gate (see
    /// `userRequestedStart`) — that is the difference this core exists to keep.
    public var blocksAutomaticStart: Bool { startGateClosed }

    /// Record one successful start. Clears the run, the rebuild budget and the
    /// gate.
    /// - Returns: true when the user must be told the engine recovered, i.e. a
    ///   previously surfaced engine actually started. Recovery is NEVER
    ///   announced from any other edge (interruption end included).
    @discardableResult
    public mutating func recordStartSuccess() -> Bool {
        consecutiveFailures = 0
        rebuildsSinceHealthy = 0
        startGateClosed = false
        let announce = surfaced
        surfaced = false
        return announce
    }

    /// Record one failed start attempt and return the ladder's decision.
    ///
    /// The decision comes from `EngineRecoveryPolicy` (the ONE ladder); this
    /// type only enforces the durable rebuild budget on top of it: a `.rebuild`
    /// past `maximumRebuildsSinceHealthy` degrades to `.surfaceUnavailable`.
    public mutating func recordStartFailure(
        _ failure: EngineFailureKind,
        interruptionActive: Bool
    ) -> EngineRecoveryAction {
        // An attempt happened, so the gate was open for it.
        startGateClosed = false
        consecutiveFailures += 1
        let action = EngineRecoveryPolicy.decide(
            failure: failure,
            interruptionActive: interruptionActive,
            consecutiveFailures: consecutiveFailures)
        guard action == .rebuild else { return action }
        guard rebuildsSinceHealthy < Self.maximumRebuildsSinceHealthy else {
            return .surfaceUnavailable
        }
        rebuildsSinceHealthy += 1
        return action
    }

    /// Close the gate and mark the engine surfaced.
    /// - Returns: true when this is a NEW surface (the caller should notify JS
    ///   exactly once); false when it was already surfaced.
    @discardableResult
    public mutating func surface() -> Bool {
        startGateClosed = true
        guard !surfaced else { return false }
        surfaced = true
        return true
    }

    /// An AVAudioSession interruption ended. The failure cause a real
    /// interruption produces is gone, so a fresh run may attempt a start —
    /// but a surfaced engine STAYS surfaced until a start actually succeeds.
    /// (The old engine cleared its surfaced flag here, which told JS "recovered"
    /// without evidence and let the ladder restart from zero on every flap.)
    public mutating func interruptionEnded() {
        consecutiveFailures = 0
        startGateClosed = false
    }

    /// A deliberate Play / explicit restart: the user's strongest evidence of
    /// intent. Grants a fresh ladder run and opens the gate. Deliberately does
    /// NOT clear `surfaced` (only a successful start may) and does NOT clear
    /// the rebuild budget (the durable thrash bound).
    public mutating func userRequestedStart() {
        consecutiveFailures = 0
        startGateClosed = false
    }

    /// `mediaServicesWereReset` / `WereLost`: the services themselves are new,
    /// so an attempt is warranted. Opens the gate and grants a fresh run; the
    /// rebuild budget keeps a notification storm from tearing down the graph
    /// without bound.
    public mutating func servicesInvalidated() {
        consecutiveFailures = 0
        startGateClosed = false
    }
}
