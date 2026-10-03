import Foundation

/// A rolling counter for the retry ladder's BRANCH decisions (2026-10-02g).
///
/// WHY this exists. `TransferCutRetryPolicy` (2026-10-02f) made the retry
/// ladder branch on the transfer-cut attribution, but nothing OBSERVED that
/// branch: a field dump could see the decision's inputs (the `cut=` bracket on
/// a failure line) and the shape of the retry log lines, yet had no
/// accumulated count to prove the new path ever fires — or, worse, that it
/// fires on every retry because the attribution is systematically
/// `churnUnlikely`. A decision that is never counted is a decision nobody can
/// verify.
///
/// Two numbers matter and they are DIFFERENT:
///   - `decided` — the strategy chosen at schedule time (the engine's call).
///   - `enactedFreshConnection` — pools actually rotated (the loader's
///     execution). They can legitimately differ: a `freshConnectionSoon`
///     decision whose attempt takes URLSession's opaque-resumeData shape keeps
///     the shared session by design, so it is counted as a decision but not as
///     an enactment. Reporting both makes that gap visible instead of hiding it
///     behind one number.
///
/// `recent` is the ROLLING window (newest last): the totals say whether the
/// branch fires at all, the ORDER says whether it flips — a run of `fresh`
/// after a run of `resume` is a different story from an even mix.
///
/// Pure value type, no clocks, no engine state — `swift test`-hostable (E5).
public struct TransferRetryBranchStats: Equatable, Sendable {
    /// How many recent decisions are retained (newest last).
    public static let recentWindow = 20

    /// Decisions taken at schedule time.
    public private(set) var scheduled: Int = 0
    private(set) var freshConnectionSoon: Int = 0
    private(set) var resumeAfterBackoff: Int = 0
    private(set) var standard: Int = 0
    /// The rolling window of strategy raw values, newest LAST.
    public private(set) var recent: [String] = []

    public init() {}

    /// Record ONE scheduling decision.
    public mutating func record(strategy: TransferRetryStrategy) {
        scheduled += 1
        switch strategy {
        case .freshConnectionSoon: freshConnectionSoon += 1
        case .resumeAfterBackoff: resumeAfterBackoff += 1
        case .standard: standard += 1
        }
        recent.append(strategy.rawValue)
        if recent.count > Self.recentWindow {
            recent.removeFirst(recent.count - Self.recentWindow)
        }
    }

    /// Start a FRESH observation window (2026-10-02h). The HUD's Clear all
    /// button calls this so a field session can begin counting again without a
    /// relaunch — the previous totals are discarded wholesale, not decayed.
    /// The ENACTMENT counter lives in the loader and is reset beside this one
    /// (see `NativeAudioEngine.resetRetryBranchStats`); resetting only the
    /// decision side would leave a summary line whose two halves describe
    /// different windows.
    public mutating func reset() {
        scheduled = 0
        freshConnectionSoon = 0
        resumeAfterBackoff = 0
        standard = 0
        recent.removeAll()
    }

    /// One short, greppable line for the HUD and the Copy dump.
    /// `enactedFreshConnection` comes from the LOADER (the only place that
    /// knows a pool was actually rotated), so it is passed in rather than
    /// estimated here.
    public func summaryLine(enactedFreshConnection: Int) -> String {
        let rolling = recent.isEmpty ? "—" : recent.map(Self.shortLabel).joined(separator: ",")
        return "retry: \(scheduled) decided (fresh \(freshConnectionSoon), resume \(resumeAfterBackoff), standard \(standard)) · fresh enacted \(enactedFreshConnection) · recent \(rolling)"
    }

    /// The dump payload shape lives here, beside the fields, so the HUD, the
    /// Copy dump and any future reader cannot drift from the type.
    public func snapshot(enactedFreshConnection: Int) -> [String: Any] {
        [
            "scheduled": scheduled,
            "freshConnectionSoon": freshConnectionSoon,
            "resumeAfterBackoff": resumeAfterBackoff,
            "standard": standard,
            "freshConnectionEnacted": enactedFreshConnection,
            "recent": recent,
            "summary": summaryLine(enactedFreshConnection: enactedFreshConnection),
        ]
    }

    /// The rolling window's compact spelling — the raw value is kept in
    /// `recent` so a dump greps against the same strings the log lines use.
    public static func shortLabel(_ raw: String) -> String {
        switch raw {
        case "freshConnectionSoon": return "fresh"
        case "resumeAfterBackoff": return "resume"
        default: return "std"
        }
    }
}
