import Foundation

/// Pure decision core for the lock-screen artwork fetch race (TODO 4.4).
///
/// `URLSession` data tasks for artwork complete on a delegate queue, so an
/// older fetch can land AFTER a newer one (or after the track changed without
/// a new artwork request, e.g. the new track has no cover). The controller
/// must never stamp stale art over the current track — the completion applies
/// only when it is for the LATEST requested track AND that track is still the
/// current one.
///
/// Kept pure (no UIKit, no URLSession) so the decision matrix is unit-testable
/// on the macOS host.
public struct ArtworkRequestGuard {
    /// Track id of the most recent artwork request (nil before the first).
    public private(set) var latestRequested: String?

    public init() {}

    /// Records a new artwork request. Any in-flight completion for an older
    /// track becomes ineligible the moment a newer request lands.
    public mutating func request(_ trackId: String) {
        latestRequested = trackId
    }

    /// A completion may apply its artwork only when it answers the most recent
    /// request AND that track is still the one being shown (`currentTrackId`).
    /// The second clause covers the "track changed to one without a cover"
    /// case, where no new request supersedes the stale one.
    public func shouldApply(completedTrackId: String, currentTrackId: String) -> Bool {
        completedTrackId == latestRequested && completedTrackId == currentTrackId
    }
}
