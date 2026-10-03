import Foundation

/// Attributes a failed transfer to interface churn or to a stable local path
/// (2026-10-02e — the `cannot parse response` root-cause work).
///
/// The question this exists to answer, in the user's own terms: transfer cuts
/// repeat (`cannot parse response`, historically blamed on "flaky cellular"),
/// and there are exactly two candidate explanations that a field dump can
/// separate —
///
///   1. **Interface churn.** The path changed under an in-flight transfer
///      (Wi-Fi reassociation, Wi-Fi → cellular, a Wi-Fi Assist switch), the
///      socket died, and the failure is collateral. Churn predicts a NETWORK
///      TRANSITION shortly before the cut.
///   2. **A reverse-proxy / server-side keep-alive race.** The far end closed a
///      connection the client then reused, or reset mid-response — the path
///      never changed and nothing local explains it.
///
/// The discriminator is therefore not the error code (both produce -1017 /
/// -1005) but the TIME BETWEEN the last observed path transition and the cut.
/// this type makes that comparison once, in one place, so every failure line
/// carries the same verdict and the same numbers.
///
/// Deliberately generous window: collateral damage from a path change can
/// surface seconds later (DNS re-resolution, TCP retransmit timeouts), so the
/// default is 5 s rather than "immediately". The LABEL is a convenience — the
/// exact offset is always printed too, so a careful reader can judge for
/// themselves rather than trust the bucket.
///
/// LIMIT, stated so it is never mistaken for proof: this can only see
/// transitions the OS REPORTS. A Wi-Fi reassociation between two access points
/// may leave `NWPathMonitor` silent, and that churn would read as
/// `churnUnlikely`. A run of `churnUnlikely` verdicts is therefore strong
/// evidence against *reported* churn, not proof that the link never wobbled.
public enum CutAttribution: String, Sendable {
    /// A network path transition landed inside the window before the cut.
    case churnSuspected
    /// No transition inside the window: local churn does not explain this cut.
    case churnUnlikely
    /// The failure was not a transport cut at all (an app-side gate verdict).
    case notTransport
}

public enum TransferCutCorrelation {
    /// Seconds before a cut within which a reported path transition is treated
    /// as the likely cause. See the header for why this is generous.
    public static let defaultWindowSeconds: Double = 5.0

    /// The attribution for one cut. `lastNetworkChangeAt` / `cutAt` are on the
    /// SAME monotonic clock (seconds); `nil` means no transition has been
    /// observed this session.
    public static func attribute(
        failure: TransferFailureInfo,
        lastNetworkChangeAt: Double?,
        cutAt: Double,
        windowSeconds: Double = defaultWindowSeconds
    ) -> CutAttribution {
        guard failure.isTransportFailure else { return .notTransport }
        guard let last = lastNetworkChangeAt else { return .churnUnlikely }
        let delta = cutAt - last
        // A transition stamped AFTER the cut is not evidence (clock skew or a
        // transition racing the failure): treat it as no-window evidence rather
        // than crediting churn for something that had not happened yet.
        guard delta >= 0 else { return .churnUnlikely }
        return delta <= windowSeconds ? .churnSuspected : .churnUnlikely
    }

    /// The attribution plus the numbers it was derived from — the line every
    /// failure log appends beside `TransferFailureInfo.evidenceLine`.
    public static func evidenceLine(
        failure: TransferFailureInfo,
        lastNetworkChangeAt: Double?,
        cutAt: Double,
        windowSeconds: Double = defaultWindowSeconds
    ) -> String {
        let verdict = attribute(
            failure: failure,
            lastNetworkChangeAt: lastNetworkChangeAt,
            cutAt: cutAt,
            windowSeconds: windowSeconds)
        switch verdict {
        case .notTransport:
            return "cut=notTransport (app-side verdict — bytes, not transport)"
        case .churnSuspected:
            let delta = cutAt - (lastNetworkChangeAt ?? cutAt)
            return "cut=churnSuspected (network transition \(Self.seconds(delta)) before the cut)"
        case .churnUnlikely:
            guard let last = lastNetworkChangeAt else {
                return "cut=churnUnlikely (no network transition reported this session)"
            }
            let delta = cutAt - last
            return "cut=churnUnlikely (no transition within \(Self.seconds(windowSeconds)); last was \(Self.seconds(delta)) earlier)"
        }
    }

    private static func seconds(_ value: Double) -> String {
        String(format: "%.1fs", max(0, value))
    }
}
