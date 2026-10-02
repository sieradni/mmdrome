import XCTest
@testable import BackgroundAudioCore

/// Pins the Phase 4 trailing debounce (2026-10-02): a burst of NWPathMonitor
/// updates collapses into ONE prefetch re-arm, fired only after the path has
/// been quiet for the window since the LAST change.
final class NetworkRearmDebounceTests: XCTestCase {

    func testIdleNeverFires() {
        var debounce = NetworkRearmDebounce()
        XCTAssertFalse(debounce.isPending)
        XCTAssertNil(debounce.millisUntilEligible(at: 1_000))
        XCTAssertFalse(debounce.shouldFire(at: 1_000))
    }

    func testFiresOnceAfterTheWindow() {
        var debounce = NetworkRearmDebounce(windowMs: 500)
        debounce.noteChange(at: 1_000)
        XCTAssertTrue(debounce.isPending)
        XCTAssertEqual(debounce.millisUntilEligible(at: 1_200), 300)
        XCTAssertFalse(debounce.shouldFire(at: 1_499), "inside the window")
        XCTAssertTrue(debounce.shouldFire(at: 1_500), "at the window boundary")
        XCTAssertFalse(debounce.shouldFire(at: 1_500), "fires exactly once")
        XCTAssertFalse(debounce.isPending)
        XCTAssertNil(debounce.millisUntilEligible(at: 1_500))
    }

    func testABurstRestartsTheWindow() {
        var debounce = NetworkRearmDebounce(windowMs: 500)
        debounce.noteChange(at: 1_000)
        debounce.noteChange(at: 1_300)
        debounce.noteChange(at: 1_600)
        XCTAssertFalse(debounce.shouldFire(at: 1_900), "window still open from the last change")
        XCTAssertEqual(debounce.millisUntilEligible(at: 1_900), 200)
        XCTAssertTrue(debounce.shouldFire(at: 2_100))
    }

    func testAChangeExactlyAtTheDeadlineStillRestarts() {
        var debounce = NetworkRearmDebounce(windowMs: 500)
        debounce.noteChange(at: 1_000)
        // The timer fires at the boundary, but a newer change landed exactly then.
        debounce.noteChange(at: 1_500)
        XCTAssertFalse(debounce.shouldFire(at: 1_500), "the 1_500 change restarted the window")
        XCTAssertTrue(debounce.shouldFire(at: 2_000))
    }

    func testMillisUntilEligibleIsZeroWhenDue() {
        var debounce = NetworkRearmDebounce(windowMs: 500)
        debounce.noteChange(at: 1_000)
        XCTAssertEqual(debounce.millisUntilEligible(at: 5_000), 0)
        XCTAssertTrue(debounce.shouldFire(at: 5_000))
    }
}
