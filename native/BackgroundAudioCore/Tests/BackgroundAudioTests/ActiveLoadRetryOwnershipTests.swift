import XCTest
@testable import BackgroundAudioCore

/// Pins the single-owner retry decision (2026-10-03). The defect this core
/// prevents is TWO owners racing for one yielded failure, so the load-bearing
/// property is exclusivity: every environment maps to exactly one owner.
final class ActiveLoadRetryOwnershipTests: XCTestCase {

    func testForegroundOwnsViaJsLadder() {
        // Foreground: the webview runs, so the JS ladder is the owner and the
        // native retry must NOT also be armed (the double-reload).
        XCTAssertEqual(ActiveLoadRetryOwnership.owner(isBackground: false), .jsLadder)
    }

    func testBackgroundOwnsViaNativeRetry() {
        // Background: the JS machine is suspended — its queued retry cannot
        // run, so the native bounded re-attempt owns the row.
        XCTAssertEqual(ActiveLoadRetryOwnership.owner(isBackground: true), .nativeRetry)
    }

    func testOwnerIsExclusive() {
        // One owner per environment — the two must never be the same, or one
        // environment would be left with no retry (the silent-stop defect).
        XCTAssertNotEqual(
            ActiveLoadRetryOwnership.owner(isBackground: false),
            ActiveLoadRetryOwnership.owner(isBackground: true))
    }

    func testOwnerRawValuesAreStable() {
        // The raw value rides diagnostic lines; a silent rename would make an
        // old dump unreadable.
        XCTAssertEqual(ActiveLoadRetryOwner.jsLadder.rawValue, "jsLadder")
        XCTAssertEqual(ActiveLoadRetryOwner.nativeRetry.rawValue, "nativeRetry")
    }
}
