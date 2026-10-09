import Foundation

/// What went wrong when the engine tried to (re)start. Kept as a small enum so
/// the escalation rule is testable without an AVAudioSession or an
/// AVAudioEngine — the call sites classify, the policy decides.
public enum EngineFailureKind: String, Sendable {
    /// `AVAudioSession.setActive(true)` threw. The session could not be
    /// activated (an interruption still owns the session, or it expired /
    /// media services are churning). `AVAudioSessionErrorCodeSessionNotActive`
    /// (`'!ses'`, OSStatus 561210739) is the field signature.
    case sessionNotActive
    /// The session activated (or already was) but `AVAudioEngine.start()`
    /// threw. `com.apple.coreaudio.avfaudio error -50` is the field
    /// signature — a start against an inactive/invalid graph.
    case startFailed
    /// `AVAudioSession.mediaServicesWereReset`/`WereLost` (or an expired
    /// session code): the audio services were torn down underneath the app.
    /// Apple's own guidance is to reinitialize every audio resource, so this
    /// kind always wants a rebuild.
    case mediaServicesReset
}

/// What the engine should do about one failure. Deliberately separates the
/// DECISION from the machinery that enacts it (`NativeAudioEngine` owns the
/// timers, the session and the graph), so the ladder is unit-testable and the
/// surface/retry boundary cannot silently drift.
public enum EngineRecoveryAction: Equatable, Sendable {
    /// Nothing to rebuild yet (a transient interruption, or the first couple
    /// of failures): try again after the delay. The engine schedules the
    /// attempt; JS is not told anything.
    case retryLater(delaySeconds: TimeInterval)
    /// The graph may be invalid — tear the whole audio stack down and rebuild
    /// it (session re-activate + fresh engine/nodes). Bounded: see
    /// `maximumConsecutiveFailures`.
    case rebuild
    /// Automatic recovery has been tried and failed enough times. Stop
    /// thrashing and surface a distinct "engine unavailable" signal so JS can
    /// offer the user an explicit restart instead of silently skipping the
    /// queue.
    case surfaceUnavailable
}

/// The bounded escalation ladder for an audio engine that cannot start.
///
/// WHY this exists (2026-10-04 field dump): an interruption left the
/// AVAudioSession inactive; `ensureEngineRunning()` swallowed the
/// `setActive` failure and re-attempted `engine.start()` on a dead session,
/// which failed with `-50` forever. The graph was built ONCE at init and
/// never rebuilt, so every subsequent play failed identically and only a
/// relaunch recovered — and the JS retry ladder walked row after row, each
/// failing the same way. This core encodes the missing ladder:
///
///   - While an interruption ACTUALLY owns the session (the activation
///     itself fails with `sessionNotActive`), never rebuild and never surface —
///     nothing will succeed until the interruption ends, so wait. Other
///     failure kinds PROVE the interruption is over and must escalate; see
///     `interruptionBlocksRecovery` for the 2026-10-08 stale-flag why.
///   - Otherwise: retry a couple of times with a short backoff (a transient
///     session failure often clears on its own), then REBUILD once (the
///     `mediaServicesReset` kind rebuilds on the first failure, because the
///     services themselves were invalidated), then surface.
public enum EngineRecoveryPolicy {

    // MARK: - Known OSStatus codes

    /// `AVAudioSessionErrorCodeSessionNotActive` — `'!ses'` = 0x21736573.
    /// The field signature: `The operation couldn't be completed. (OSStatus
    /// error 561210739.)`.
    public static let sessionNotActiveOSStatus = 561210739
    /// `AVAudioSessionErrorCodeExpiredSession` — `'!exp'` = 0x21657870.
    public static let expiredSessionOSStatus = 560298096
    /// `AVAudioSessionErrorCodeMediaServicesFailed` — `'!msr'` = 0x216D7372.
    public static let mediaServicesFailedOSStatus = 560821106

    // MARK: - The ladder's shape

    /// After this many consecutive failures the engine stops retrying and
    /// surfaces `surfaceUnavailable`. Counted per uninterrupted failure run;
    /// any success (or an interruption ending, or a user-requested restart)
    /// resets it to zero.
    public static let maximumConsecutiveFailures = 4
    /// The failure number at which the ladder escalates to a full rebuild.
    public static let rebuildAtFailureNumber = 3
    /// First retry spacing (failure 1).
    public static let firstRetryDelaySeconds: TimeInterval = 0.5
    /// Second retry spacing (failure 2).
    public static let secondRetryDelaySeconds: TimeInterval = 1.0
    /// Spacing while an interruption is active. Deliberately constant: the
    /// only thing that can change the outcome is the interruption ending,
    /// which is event-driven, not timer-driven.
    public static let interruptionRetryDelaySeconds: TimeInterval = 1.0

    // MARK: - Classification

    /// Classify an `AVAudioSession` activation error. A non-OSStatus error
    /// (or an unrecognized code) is treated as `.sessionNotActive` — the
    /// caller invoked this from the activation site, and the safe assumption
    /// is a transient session problem, not a reason to skip recovery.
    public static func classifySessionError(_ error: NSError) -> EngineFailureKind {
        guard error.domain == NSOSStatusErrorDomain else { return .sessionNotActive }
        if error.code == expiredSessionOSStatus || error.code == mediaServicesFailedOSStatus {
            return .mediaServicesReset
        }
        return .sessionNotActive
    }

    // MARK: - The decision

    /// Whether an active interruption is a legitimate reason to keep WAITING.
    ///
    /// Only `sessionNotActive` is consistent with a genuinely active
    /// interruption: re-activating the session mid-interruption is exactly the
    /// thing that fails with `'!ses'`. The other kinds PROVE the interruption
    /// is over — `startFailed` means `setActive` had already SUCCEEDED (the
    /// session was activatable), and `mediaServicesReset` invalidates the
    /// whole stack and wants a rebuild regardless of any flag.
    ///
    /// WHY this is not `interruptionActive` alone (2026-10-08 field dump): the
    /// flag can go STALE — the dump shows 9 `.began` edges with 0 `.ended`
    /// while playback provably continued for ~1 h (iOS simply never delivered
    /// the end edge). The old unconditional wait branch then turned every
    /// later failure into `retryLater(1 s)` forever, silently disarming the
    /// ladder on exactly the session that most needed a rebuild.
    public static func interruptionBlocksRecovery(
        failure: EngineFailureKind,
        interruptionActive: Bool
    ) -> Bool {
        return interruptionActive && failure == .sessionNotActive
    }

    /// The action for one failure.
    ///
    /// - Parameters:
    ///   - failure: what failed (see `EngineFailureKind`).
    ///   - interruptionActive: whether an AVAudioSession interruption is
    ///     currently in progress. It blocks recovery only for a
    ///     `sessionNotActive` failure — see `interruptionBlocksRecovery`.
    ///   - consecutiveFailures: 1-based count of consecutive start failures
    ///     INCLUDING this one.
    public static func decide(
        failure: EngineFailureKind,
        interruptionActive: Bool,
        consecutiveFailures: Int
    ) -> EngineRecoveryAction {
        if interruptionBlocksRecovery(failure: failure, interruptionActive: interruptionActive) {
            return .retryLater(delaySeconds: interruptionRetryDelaySeconds)
        }
        if consecutiveFailures >= maximumConsecutiveFailures {
            return .surfaceUnavailable
        }
        // A reset/lost media-services session invalidates the whole graph —
        // rebuild on the first failure rather than waiting for the ladder.
        if failure == .mediaServicesReset {
            return .rebuild
        }
        if consecutiveFailures >= rebuildAtFailureNumber {
            return .rebuild
        }
        return .retryLater(delaySeconds: retryDelay(forFailureNumber: consecutiveFailures))
    }

    /// The backoff for the retry-later rungs. Failure 1 is short (a transient
    /// session hiccup usually clears immediately); failure 2 waits longer.
    public static func retryDelay(forFailureNumber failureNumber: Int) -> TimeInterval {
        failureNumber <= 1 ? firstRetryDelaySeconds : secondRetryDelaySeconds
    }
}
