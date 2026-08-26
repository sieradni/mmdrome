import Foundation
import XCTest
@testable import BackgroundAudioCore

final class CrossfadeTests: XCTestCase {

    // MARK: - RampPlan

    func testDualRampProfileLinear() {
        let plan = RampPlan(activeStart: 0.8, standbyEnd: 0.5, duration: 3, curve: .linear)
        XCTAssertEqual(plan.stepTime, 3.0 / Float(RampPlan.stepCount), accuracy: 1e-6)

        // Step 1 → t = 1/40.
        let t1 = RampPlan.fraction(step: 1)
        XCTAssertEqual(plan.activeGain(atStep: 1), 0.8 + (0 - 0.8) * t1, accuracy: 1e-6)
        XCTAssertEqual(plan.standbyGain(atStep: 1), 0.5 * t1, accuracy: 1e-6)

        // Step 20 → t = 0.5: both sides exactly halfway.
        XCTAssertEqual(plan.activeGain(atStep: 20), 0.4, accuracy: 1e-5)
        XCTAssertEqual(plan.standbyGain(atStep: 20), 0.25, accuracy: 1e-5)

        // Step 40 → t = 1: active fully faded, standby at its target.
        XCTAssertEqual(plan.activeGain(atStep: 40), 0, accuracy: 1e-5)
        XCTAssertEqual(plan.standbyGain(atStep: 40), 0.5, accuracy: 1e-5)

        // Both sides move monotonically, in lockstep.
        for step in 1..<RampPlan.stepCount {
            XCTAssertLessThan(plan.activeGain(atStep: step + 1), plan.activeGain(atStep: step))
            XCTAssertGreaterThan(plan.standbyGain(atStep: step + 1), plan.standbyGain(atStep: step))
        }
    }

    func testRampCurveProfiles() {
        XCTAssertEqual(RampCurve.linear.factor(at: 0.25), 0.25, accuracy: 1e-6)
        XCTAssertEqual(RampCurve.exponential.factor(at: 0.5), 0.25, accuracy: 1e-6)

        // Sigmoid is an S-curve: below the midpoint early, above late.
        let sig = RampCurve.sigmoid(steepness: 8)
        XCTAssertEqual(sig.factor(at: 0.5), 0.5, accuracy: 1e-6)
        XCTAssertLessThan(sig.factor(at: 0.25), 0.5)
        XCTAssertGreaterThan(sig.factor(at: 0.75), 0.5)

        // Raw-string mapping mirrors the engine's switch-default (1.1 parity).
        XCTAssertEqual(RampCurve(raw: "linear", steepness: 8), .linear)
        XCTAssertEqual(RampCurve(raw: "exponential", steepness: 8), .exponential)
        XCTAssertEqual(RampCurve(raw: "sigmoid", steepness: 3), .sigmoid(steepness: 3))
        XCTAssertEqual(RampCurve(raw: "bogus", steepness: 3), .sigmoid(steepness: 3))
    }

    func testZeroDurationPlanHasZeroStepTime() {
        let plan = RampPlan(activeStart: 0.8, standbyEnd: 0.5, duration: 0, curve: .linear)
        XCTAssertEqual(plan.stepTime, 0)
    }

    // MARK: - CrossfadeState

    func testCrossfadeStateTransitions() {
        let idle = CrossfadeState.idle
        XCTAssertEqual(idle.phase, .idle)
        XCTAssertEqual(idle.targetIndex, -1)
        XCTAssertFalse(idle.isActive)

        let armed = idle.arming(targetIndex: 3)
        XCTAssertEqual(armed.phase, .armed)
        XCTAssertEqual(armed.targetIndex, 3)
        XCTAssertTrue(armed.isActive)
        XCTAssertFalse(armed.isInFlight)

        let inFlight = armed.starting(targetIndex: 3)
        XCTAssertEqual(inFlight.phase, .inFlight)
        XCTAssertEqual(inFlight.targetIndex, 3)
        XCTAssertTrue(inFlight.isInFlight)

        // Pause mid-fade cancels the switch (1.8) — resume re-arms from idle.
        XCTAssertEqual(inFlight.pausing(), .idle)
        XCTAssertEqual(armed.pausing(), .idle)

        // Completion also lands back at idle.
        XCTAssertEqual(inFlight.completing(), .idle)
    }

    // MARK: - Crossfade readiness

    func testCrossfadeReadinessExplainsEveryGate() {
        XCTAssertEqual(
            crossfadeReadiness(isPlaying: true, loopOne: false, fadeDuration: 0, currentDuration: 60, nextDuration: 60, targetReady: true),
            .disabled
        )
        XCTAssertEqual(
            crossfadeReadiness(isPlaying: false, loopOne: false, fadeDuration: 5, currentDuration: 60, nextDuration: 60, targetReady: true),
            .paused
        )
        XCTAssertEqual(
            crossfadeReadiness(isPlaying: true, loopOne: true, fadeDuration: 5, currentDuration: 60, nextDuration: 60, targetReady: true),
            .loopOne
        )
        XCTAssertEqual(
            crossfadeReadiness(isPlaying: true, loopOne: false, fadeDuration: 5, currentDuration: 0, nextDuration: 60, targetReady: true),
            .missingCurrentDuration
        )
        XCTAssertEqual(
            crossfadeReadiness(isPlaying: true, loopOne: false, fadeDuration: 5, currentDuration: 60, nextDuration: nil, targetReady: true),
            .noSuccessor
        )
        XCTAssertEqual(
            crossfadeReadiness(isPlaying: true, loopOne: false, fadeDuration: 5, currentDuration: 5.5, nextDuration: 60, targetReady: true),
            .currentTooShort
        )
        XCTAssertEqual(
            crossfadeReadiness(isPlaying: true, loopOne: false, fadeDuration: 5, currentDuration: 60, nextDuration: 4.9, targetReady: true),
            .nextTooShort
        )
        XCTAssertEqual(
            crossfadeReadiness(isPlaying: true, loopOne: false, fadeDuration: 5, currentDuration: 60, nextDuration: 60, targetReady: false),
            .targetNotReady
        )
        XCTAssertEqual(
            crossfadeReadiness(isPlaying: true, loopOne: false, fadeDuration: 5, currentDuration: 60, nextDuration: 60, targetReady: true),
            .ready
        )
    }

    // MARK: - Seek suppression

    func testSeekInCrossfadeWindowBoundaries() {
        // 30s track, 10s fade: the transition point at 20 is IN-window.
        XCTAssertTrue(isSeekInCrossfadeWindow(position: 20, duration: 30, fadeDuration: 10))
        XCTAssertTrue(isSeekInCrossfadeWindow(position: 29.9, duration: 30, fadeDuration: 10))
        // Just below the window is not.
        XCTAssertFalse(isSeekInCrossfadeWindow(position: 19.9, duration: 30, fadeDuration: 10))
        // Degenerate inputs never latch.
        XCTAssertFalse(isSeekInCrossfadeWindow(position: 25, duration: 30, fadeDuration: 0))
        XCTAssertFalse(isSeekInCrossfadeWindow(position: 25, duration: 0, fadeDuration: 10))
        // Web-parity sanity: same boundary answers as crossfadePolicy.ts.
        XCTAssertFalse(isSeekInCrossfadeWindow(position: 0, duration: 30, fadeDuration: 10))
    }
}
