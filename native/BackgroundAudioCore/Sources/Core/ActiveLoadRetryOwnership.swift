import Foundation

/// Which retry machine owns a YIELDED active-load failure (2026-10-03, the
/// double-reload fix).
///
/// WHY this needs a decision at all. The engine owns a bounded native
/// re-attempt (`scheduleActiveLoadRetry`) because the JS retry machine is
/// SUSPENDED while the app is backgrounded — without it, a backgrounded row
/// sat in dead air for 33 wall-clock minutes (dump-2). But the JS machine is
/// the fast, bounded path in the FOREGROUND. Arming BOTH for one failure left
/// two owners racing for the same row: whichever fired first reloaded the
/// track, and the other fired afterwards and reloaded it AGAIN — and each
/// reload re-engages from 0:00. The 1.2.50 restart-from-0:00 report is the
/// visible shape.
///
/// Ownership is therefore environmental, and this type makes it ONE decision
/// instead of a foreground check duplicated at every yield site (which is how
/// the sites drifted). Pure, no `UIApplication`, `swift test`-hostable (E5).
public enum ActiveLoadRetryOwner: String, Sendable, Equatable {
    /// The JS retry ladder — foreground, where the webview is running.
    case jsLadder
    /// The native bounded re-attempt — background, where the JS machine is
    /// suspended and cannot run a queued retry.
    case nativeRetry
}

public enum ActiveLoadRetryOwnership {
    /// The single owner for one yielded failure.
    ///
    /// `isBackground` is the ONLY input. There is no third state: `.inactive`
    /// still runs the webview, so it owns via the JS ladder — callers pass
    /// `applicationState == .background`.
    public static func owner(isBackground: Bool) -> ActiveLoadRetryOwner {
        isBackground ? .nativeRetry : .jsLadder
    }
}
