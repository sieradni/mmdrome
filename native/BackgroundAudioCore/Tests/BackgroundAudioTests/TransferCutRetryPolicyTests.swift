import Foundation
import XCTest
@testable import BackgroundAudioCore

/// Pins the ladder's branch (2026-10-02f). The mapping matters more than the
/// numbers: `churnUnlikely` must be the ONLY attribution that buys a fresh
/// connection, and a missing / non-transport attribution must be a no-op so an
/// un-adopted caller keeps its previous retry behavior exactly.
final class TransferCutRetryPolicyTests: XCTestCase {

    // MARK: - The mapping

    func testChurnUnlikelyWantsAFreshConnection() {
        XCTAssertEqual(TransferCutRetryPolicy.strategy(for: .churnUnlikely), .freshConnectionSoon)
        XCTAssertTrue(TransferCutRetryPolicy.requiresFreshConnection(for: .churnUnlikely))
    }

    func testChurnSuspectedKeepsResumeTiming() {
        XCTAssertEqual(TransferCutRetryPolicy.strategy(for: .churnSuspected), .resumeAfterBackoff)
        XCTAssertFalse(TransferCutRetryPolicy.requiresFreshConnection(for: .churnSuspected))
    }

    func testAppVerdictIsStandard() {
        XCTAssertEqual(TransferCutRetryPolicy.strategy(for: .notTransport), .standard)
        XCTAssertFalse(TransferCutRetryPolicy.requiresFreshConnection(for: .notTransport))
    }

    func testMissingAttributionIsStandard() {
        // The backward-compatibility contract: a caller that never classified
        // the failure is not silently switched to a new retry shape.
        XCTAssertEqual(TransferCutRetryPolicy.strategy(for: nil), .standard)
        XCTAssertFalse(TransferCutRetryPolicy.requiresFreshConnection(for: nil))
    }

    // MARK: - The delay

    func testFreshConnectionTakesTheShortDelay() {
        XCTAssertEqual(
            TransferCutRetryPolicy.delaySeconds(for: .churnUnlikely, standardDelaySeconds: 3.0),
            TransferCutRetryPolicy.freshConnectionDelaySeconds)
        XCTAssertEqual(TransferCutRetryPolicy.freshConnectionDelaySeconds, 0.5)
    }

    func testOtherAttributionsKeepTheStandardDelay() {
        XCTAssertEqual(
            TransferCutRetryPolicy.delaySeconds(for: .churnSuspected, standardDelaySeconds: 3.0), 3.0)
        XCTAssertEqual(
            TransferCutRetryPolicy.delaySeconds(for: .notTransport, standardDelaySeconds: 3.0), 3.0)
        XCTAssertEqual(
            TransferCutRetryPolicy.delaySeconds(for: nil, standardDelaySeconds: 3.0), 3.0)
    }

    func testTheFreshDelayNeverLengthensAWait() {
        // A caller whose standard spacing is already shorter than the fresh
        // constant must not wait LONGER for the fresh case.
        XCTAssertEqual(
            TransferCutRetryPolicy.delaySeconds(for: .churnUnlikely, standardDelaySeconds: 0.2), 0.2)
    }

    func testStrategyIsStableAcrossCalls() {
        // The decision is pure — the engine calls it twice (once to schedule,
        // once to enact the attempt) and the two must agree.
        XCTAssertEqual(
            TransferCutRetryPolicy.strategy(for: .churnUnlikely),
            TransferCutRetryPolicy.strategy(for: .churnUnlikely))
    }
}
