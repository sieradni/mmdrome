import Foundation
import XCTest
@testable import BackgroundAudioCore

/// Pins the engine-availability state machine (2026-11-17). The field dump that
/// motivated it: a paused player at 0:00 with a fully loaded bar and a native
/// log repeating `rebuild start failed — recovery remains pending`. The ladder
/// was bounded, but the surfaced flag was not durable — an interruption `.ended`
/// announced a recovery with no successful start and reset the run, so every
/// Play re-walked retry → rebuild → failed start. The same flag gated starts, so
/// the user's Play was swallowed.
final class EngineAvailabilityTests: XCTestCase {

    // MARK: - The ladder, through the state machine

    func testAFullRunSurfacesAndClosesTheGate() {
        var a = EngineAvailability()
        XCTAssertEqual(a.recordStartFailure(.sessionNotActive, interruptionActive: false),
                       .retryLater(delaySeconds: EngineRecoveryPolicy.firstRetryDelaySeconds))
        XCTAssertEqual(a.recordStartFailure(.sessionNotActive, interruptionActive: false),
                       .retryLater(delaySeconds: EngineRecoveryPolicy.secondRetryDelaySeconds))
        XCTAssertEqual(a.recordStartFailure(.sessionNotActive, interruptionActive: false), .rebuild)
        XCTAssertEqual(a.rebuildsSinceHealthy, 1)

        XCTAssertEqual(a.recordStartFailure(.sessionNotActive, interruptionActive: false), .surfaceUnavailable)
        XCTAssertTrue(a.surface())
        XCTAssertTrue(a.blocksAutomaticStart)
        XCTAssertTrue(a.surfaced)
    }

    func testSurfaceIsAnnouncedOnce() {
        var a = EngineAvailability()
        XCTAssertTrue(a.surface())   // first surface notifies JS
        XCTAssertFalse(a.surface())  // repeats stay quiet
    }

    func testASuccessfulStartClearsEverythingAndAnnouncesOnlyWhenSurfaced() {
        var a = EngineAvailability()
        // Healthy start: nothing to announce.
        XCTAssertFalse(a.recordStartSuccess())

        _ = a.recordStartFailure(.startFailed, interruptionActive: false)
        a.surface()
        XCTAssertTrue(a.surfaced)

        XCTAssertTrue(a.recordStartSuccess(), "recovery must be announced after a real start")
        XCTAssertFalse(a.surfaced)
        XCTAssertFalse(a.blocksAutomaticStart)
        XCTAssertEqual(a.consecutiveFailures, 0)
        XCTAssertEqual(a.rebuildsSinceHealthy, 0)
    }

    // MARK: - Interruption edges never fake a recovery

    func testInterruptionEndReopensTheGateButKeepsTheEngineSurfaced() {
        var a = EngineAvailability()
        for _ in 0..<EngineRecoveryPolicy.maximumConsecutiveFailures {
            _ = a.recordStartFailure(.startFailed, interruptionActive: false)
        }
        a.surface()
        XCTAssertTrue(a.surfaced)

        a.interruptionEnded()

        // A fresh run is allowed (a genuine interruption may have been the
        // cause), but the banner must NOT clear: no start succeeded.
        XCTAssertFalse(a.blocksAutomaticStart)
        XCTAssertTrue(a.surfaced, "an interruption ending is not recovery evidence")
        XCTAssertEqual(a.consecutiveFailures, 0)
    }

    // MARK: - Explicit user intent

    func testAUserPlayWhileSurfacedOpensTheGateAndKeepsTheBannerUntilSuccess() {
        var a = EngineAvailability()
        for _ in 0..<EngineRecoveryPolicy.maximumConsecutiveFailures {
            _ = a.recordStartFailure(.sessionNotActive, interruptionActive: false)
        }
        a.surface()
        XCTAssertTrue(a.blocksAutomaticStart)

        a.userRequestedStart()
        XCTAssertFalse(a.blocksAutomaticStart, "an explicit Play must be able to retry")
        XCTAssertTrue(a.surfaced, "the banner stays until a start succeeds")
        XCTAssertEqual(a.consecutiveFailures, 0)

        // The retry itself succeeds → recovery is announced exactly once.
        XCTAssertTrue(a.recordStartSuccess())
        XCTAssertFalse(a.surfaced)
    }

    // MARK: - The durable rebuild budget

    func testTheRebuildBudgetSurvivesInterruptionEnds() {
        var a = EngineAvailability()
        var rebuilds = 0
        // Each cycle: enough failures to earn a rebuild, then an interruption
        // end resets the run (the old engine zeroed the whole ladder there).
        for _ in 0..<EngineAvailability.maximumRebuildsSinceHealthy {
            for _ in 1..<EngineRecoveryPolicy.rebuildAtFailureNumber {
                _ = a.recordStartFailure(.startFailed, interruptionActive: false)
            }
            XCTAssertEqual(a.recordStartFailure(.startFailed, interruptionActive: false), .rebuild)
            rebuilds += 1
            a.interruptionEnded()
        }
        XCTAssertEqual(rebuilds, EngineAvailability.maximumRebuildsSinceHealthy)

        for _ in 1..<EngineRecoveryPolicy.rebuildAtFailureNumber {
            _ = a.recordStartFailure(.startFailed, interruptionActive: false)
        }
        XCTAssertEqual(
            a.recordStartFailure(.startFailed, interruptionActive: false),
            .surfaceUnavailable,
            "past the budget a failure must surface, never rebuild again")
        XCTAssertEqual(a.rebuildsSinceHealthy, EngineAvailability.maximumRebuildsSinceHealthy)
    }

    func testTheRebuildBudgetSurvivesUserAttemptsAndServiceInvalidations() {
        var a = EngineAvailability()
        for _ in 0..<EngineAvailability.maximumRebuildsSinceHealthy {
            a.userRequestedStart()
            _ = a.recordStartFailure(.startFailed, interruptionActive: false)
            _ = a.recordStartFailure(.startFailed, interruptionActive: false)
            XCTAssertEqual(a.recordStartFailure(.startFailed, interruptionActive: false), .rebuild)
        }

        // A media-services notification burst is exactly the storm the budget
        // exists for: it may ask for a rebuild, but not past the bound.
        a.userRequestedStart()
        a.servicesInvalidated()
        XCTAssertEqual(
            a.recordStartFailure(.mediaServicesReset, interruptionActive: false),
            .surfaceUnavailable,
            "a notification storm cannot authorize unlimited rebuilds")
    }

    func testASuccessfulStartRestoresTheRebuildBudget() {
        var a = EngineAvailability()
        for _ in 0..<EngineAvailability.maximumRebuildsSinceHealthy {
            a.userRequestedStart()
            for _ in 1..<EngineRecoveryPolicy.rebuildAtFailureNumber {
                _ = a.recordStartFailure(.startFailed, interruptionActive: false)
            }
            XCTAssertEqual(a.recordStartFailure(.startFailed, interruptionActive: false), .rebuild)
        }
        // Exhausting the budget does not surface by itself; surface it (the
        // ladder does that on the failure that follows), then prove a real
        // start both resets the budget AND announces exactly once.
        XCTAssertTrue(a.surface())
        a.userRequestedStart()
        XCTAssertTrue(a.recordStartSuccess())
        XCTAssertEqual(a.rebuildsSinceHealthy, 0)
        XCTAssertFalse(a.surfaced)

        a.userRequestedStart()
        for _ in 1..<EngineRecoveryPolicy.rebuildAtFailureNumber {
            _ = a.recordStartFailure(.startFailed, interruptionActive: false)
        }
        XCTAssertEqual(a.recordStartFailure(.startFailed, interruptionActive: false), .rebuild)
    }

    // MARK: - Interruption-active waiting keeps its shape

    func testInterruptionActiveSessionFailureStillOnlyWaits() {
        var a = EngineAvailability()
        for count in 1...10 {
            XCTAssertEqual(
                a.recordStartFailure(.sessionNotActive, interruptionActive: true),
                .retryLater(delaySeconds: EngineRecoveryPolicy.interruptionRetryDelaySeconds),
                "count=\(count)")
        }
        XCTAssertEqual(a.rebuildsSinceHealthy, 0)
        XCTAssertFalse(a.surfaced)
    }
}
