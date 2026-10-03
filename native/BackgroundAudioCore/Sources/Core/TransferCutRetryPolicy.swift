import Foundation

/// The retry LADDER's branch on the transfer-cut attribution (2026-10-02f).
///
/// WHY the ladder branches. `TransferCutCorrelation` answers *why* a transfer
/// was cut: a REPORTED network transition (`churnSuspected`) or a stable local
/// path pointing at the server / reverse-proxy keep-alive lead
/// (`churnUnlikely`). The two causes want OPPOSITE retry shapes:
///
///   - **churnUnlikely** — the local path never changed, so the suspect object
///     is the pooled keep-alive connection the request was sent on (the far end
///     closed it, and the client reused it). Retrying on the SAME pool re-uses
///     the same socket class and can reproduce the cut byte-for-byte. The
///     useful response is a short backoff plus a request that cannot inherit
///     that socket.
///   - **churnSuspected** — the path is the variable and it has (presumably)
///     settled. The transfer should keep its existing timing and its resume
///     substrate: the bytes already delivered are on disk, and a Range/opaque
///     resume carries them forward. Re-issuing on a fresh connection here buys
///     nothing and pays a handshake.
///
/// This is a pure DECISION, deliberately separated from the transport that
/// enacts it (the engine's retry scheduler and the loader's session rotation),
/// so the branch is unit-testable without a network stack and the two sites
/// cannot disagree about what `churnUnlikely` means.
public enum TransferRetryStrategy: String, Sendable {
    /// A stable local path with a server/proxy-side cut: retry promptly, on a
    /// connection that cannot inherit the suspect pooled socket.
    case freshConnectionSoon
    /// A REPORTED network transition: keep the existing resume timing.
    case resumeAfterBackoff
    /// Not a transport cut (an app-side gate verdict), or no attribution at
    /// all (a non-transport failure, or a pre-taxonomy caller): existing
    /// behavior, unchanged.
    case standard
}

public enum TransferCutRetryPolicy {
    /// The short backoff for a fresh-connection retry. Deliberately much
    /// shorter than the ladder's standard spacing: the cut was NOT caused by
    /// the path being unavailable, so there is nothing to wait for — the
    /// connection is simply replaced.
    public static let freshConnectionDelaySeconds: TimeInterval = 0.5

    /// The strategy for one failure's attribution. `nil` (no attribution) and
    /// `notTransport` (an app-side verdict about the bytes) both map to
    /// `.standard`, so a caller that has not adopted the taxonomy keeps its
    /// previous behavior exactly.
    public static func strategy(for cut: CutAttribution?) -> TransferRetryStrategy {
        switch cut {
        case .churnUnlikely: return .freshConnectionSoon
        case .churnSuspected: return .resumeAfterBackoff
        case .notTransport, .none: return .standard
        }
    }

    /// True when the retry must not reuse the suspect pooled connection.
    /// Named for the ENACTMENT so the decision's intent is visible at the call
    /// site.
    public static func requiresFreshConnection(for cut: CutAttribution?) -> Bool {
        strategy(for: cut) == .freshConnectionSoon
    }

    /// The backoff for a retry, given the ladder's standard spacing. A
    /// fresh-connection retry takes the SHORT delay; every other attribution
    /// keeps the standard one. Clamped with `min` so a caller whose standard
    /// spacing is already shorter than the fresh constant never waits LONGER
    /// for the fresh case.
    public static func delaySeconds(
        for cut: CutAttribution?,
        standardDelaySeconds: TimeInterval
    ) -> TimeInterval {
        guard requiresFreshConnection(for: cut) else { return standardDelaySeconds }
        return min(freshConnectionDelaySeconds, standardDelaySeconds)
    }
}
