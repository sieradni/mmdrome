import Foundation
import XCTest
@testable import BackgroundAudioCore

/// Pins the audio-engine recovery ladder (2026-10-04). The ladder is the fix
/// for a field dump where `AVAudioSession.setActive` failed with
/// `AVAudioSessionErrorCodeSessionNotActive` (OSStatus 561210739) and every
/// subsequent `engine.start()` failed with `-50` forever, because the code
/// swallowed the session error and never rebuilt the graph.
///
/// The contract that matters: retries are bounded, a rebuild happens exactly
/// once per run before surfacing, media-services resets skip straight to a
/// rebuild, and a GENUINELY active interruption (`sessionNotActive`) suppresses
/// both rebuild and surface. A stale flag must never suppress them — see
/// `interruptionBlocksRecovery` (rule changed 2026-10-08).
final class EngineRecoveryPolicyTests: XCTestCase {

    // MARK: - Classification

    func testSessionNotActiveIsClassifiedFromItsOSStatus() {
        let error = NSError(domain: NSOSStatusErrorDomain, code: EngineRecoveryPolicy.sessionNotActiveOSStatus)
        XCTAssertEqual(EngineRecoveryPolicy.classifySessionError(error), .sessionNotActive)
    }

    func testExpiredSessionIsTheResetKind() {
        let error = NSError(domain: NSOSStatusErrorDomain, code: EngineRecoveryPolicy.expiredSessionOSStatus)
        XCTAssertEqual(EngineRecoveryPolicy.classifySessionError(error), .mediaServicesReset)
    }

    func testMediaServicesFailedIsTheResetKind() {
        let error = NSError(domain: NSOSStatusErrorDomain, code: EngineRecoveryPolicy.mediaServicesFailedOSStatus)
        XCTAssertEqual(EngineRecoveryPolicy.classifySessionError(error), .mediaServicesReset)
    }

    func testNonOSStatusErrorDefaultsToSessionNotActive() {
        // The caller only classifies the activation site, so an unrecognized
        // error is a transient session problem, not a reason to skip recovery.
        let error = NSError(domain: "com.apple.coreaudio.avfaudio", code: -50)
        XCTAssertEqual(EngineRecoveryPolicy.classifySessionError(error), .sessionNotActive)
    }

    func testUnknownOSStatusDefaultsToSessionNotActive() {
        let error = NSError(domain: NSOSStatusErrorDomain, code: -12345)
        XCTAssertEqual(EngineRecoveryPolicy.classifySessionError(error), .sessionNotActive)
    }

    // MARK: - The ladder (sessionNotActive / startFailed)

    func testFirstFailuresRetryLaterBeforeRebuilding() {
        XCTAssertEqual(
            EngineRecoveryPolicy.decide(failure: .sessionNotActive, interruptionActive: false, consecutiveFailures: 1),
            .retryLater(delaySeconds: EngineRecoveryPolicy.firstRetryDelaySeconds))
        XCTAssertEqual(
            EngineRecoveryPolicy.decide(failure: .startFailed, interruptionActive: false, consecutiveFailures: 2),
            .retryLater(delaySeconds: EngineRecoveryPolicy.secondRetryDelaySeconds))
    }

    func testTheLadderEscalatesToExactlyOneRebuildThenSurfaces() {
        let rebuild = EngineRecoveryPolicy.decide(
            failure: .startFailed, interruptionActive: false,
            consecutiveFailures: EngineRecoveryPolicy.rebuildAtFailureNumber)
        XCTAssertEqual(rebuild, .rebuild)

        let surfaced = EngineRecoveryPolicy.decide(
            failure: .startFailed, interruptionActive: false,
            consecutiveFailures: EngineRecoveryPolicy.maximumConsecutiveFailures)
        XCTAssertEqual(surfaced, .surfaceUnavailable)
    }

    func testAFullRunIsRetryRetryRebuildSurface() {
        // The whole ladder in one place — the shape a maintainer reads first.
        let actions = (1...EngineRecoveryPolicy.maximumConsecutiveFailures).map {
            EngineRecoveryPolicy.decide(failure: .sessionNotActive, interruptionActive: false, consecutiveFailures: $0)
        }
        XCTAssertEqual(actions, [
            .retryLater(delaySeconds: EngineRecoveryPolicy.firstRetryDelaySeconds),
            .retryLater(delaySeconds: EngineRecoveryPolicy.secondRetryDelaySeconds),
            .rebuild,
            .surfaceUnavailable,
        ])
    }

    func testBeyondTheThresholdStaysSurfaced() {
        // Once surfaced, further attempts must NOT restart the ladder (that
        // would re-thrash); only an explicit reset/new run changes it.
        XCTAssertEqual(
            EngineRecoveryPolicy.decide(failure: .sessionNotActive, interruptionActive: false, consecutiveFailures: 9),
            .surfaceUnavailable)
    }

    // MARK: - mediaServicesReset

    func testMediaServicesResetRebuildsOnTheFirstFailure() {
        XCTAssertEqual(
            EngineRecoveryPolicy.decide(failure: .mediaServicesReset, interruptionActive: false, consecutiveFailures: 1),
            .rebuild)
    }

    func testMediaServicesResetStillSurfacesEventually() {
        // The reset kind is not an infinite-rebuild loop — it shares the bound.
        XCTAssertEqual(
            EngineRecoveryPolicy.decide(
                failure: .mediaServicesReset, interruptionActive: false,
                consecutiveFailures: EngineRecoveryPolicy.maximumConsecutiveFailures),
            .surfaceUnavailable)
    }

    // MARK: - interruption-active

    func testInterruptionWaitsOnlyForSessionNotActive() {
        // The legitimate interruption shape: ACTIVATION is what fails, so
        // waiting is right — never rebuild (wasted graph churn) and never
        // surface (the fix is the interruption ending, not a user action).
        for count in [1, 2, 3, 4, 10] {
            XCTAssertEqual(
                EngineRecoveryPolicy.decide(failure: .sessionNotActive, interruptionActive: true, consecutiveFailures: count),
                .retryLater(delaySeconds: EngineRecoveryPolicy.interruptionRetryDelaySeconds),
                "count=\(count)")
        }
        XCTAssertTrue(EngineRecoveryPolicy.interruptionBlocksRecovery(
            failure: .sessionNotActive, interruptionActive: true))
    }

    func testStartFailedEscalatesWhileTheInterruptionFlagIsStale() {
        // Rule change 2026-10-08 (field dump: 9 `.began`, 0 `.ended`, while
        // playback continued ~1 h): a `startFailed` failure means `setActive`
        // SUCCEEDED, so the interruption is provably over even while the flag
        // still reads true. The old unconditional-wait branch turned this into
        // `retryLater` forever and disarmed the ladder.
        XCTAssertFalse(EngineRecoveryPolicy.interruptionBlocksRecovery(
            failure: .startFailed, interruptionActive: true))

        let actions = (1...EngineRecoveryPolicy.maximumConsecutiveFailures).map {
            EngineRecoveryPolicy.decide(failure: .startFailed, interruptionActive: true, consecutiveFailures: $0)
        }
        XCTAssertEqual(actions, [
            .retryLater(delaySeconds: EngineRecoveryPolicy.firstRetryDelaySeconds),
            .retryLater(delaySeconds: EngineRecoveryPolicy.secondRetryDelaySeconds),
            .rebuild,
            .surfaceUnavailable,
        ])
    }

    func testMediaServicesResetRebuildsEvenWhileTheInterruptionFlagIsStale() {
        // Deliberate rule change (2026-10-08): an interruption cannot survive a
        // media-services reset — the stack was torn down. The old "interruption
        // outranks a reset" rule is exactly the wait-forever shape the stale
        // flag produced (the 2026-10-04 failure class).
        XCTAssertFalse(EngineRecoveryPolicy.interruptionBlocksRecovery(
            failure: .mediaServicesReset, interruptionActive: true))
        XCTAssertEqual(
            EngineRecoveryPolicy.decide(failure: .mediaServicesReset, interruptionActive: true, consecutiveFailures: 1),
            .rebuild)
    }

    // MARK: - Delays

    func testRetryDelaysAreNonDecreasing() {
        XCTAssertLessThanOrEqual(
            EngineRecoveryPolicy.retryDelay(forFailureNumber: 1),
            EngineRecoveryPolicy.retryDelay(forFailureNumber: 2))
    }

    func testDecideIsStableAcrossCalls() {
        // Pure decision: the engine may ask twice for the same failure (once
        // to schedule, once to enact) and must get the same answer.
        let a = EngineRecoveryPolicy.decide(failure: .startFailed, interruptionActive: false, consecutiveFailures: 2)
        let b = EngineRecoveryPolicy.decide(failure: .startFailed, interruptionActive: false, consecutiveFailures: 2)
        XCTAssertEqual(a, b)
    }

    // MARK: - Constants pinned against drift

    func testOSStatusConstantsMatchAppleFourCCs() {
        // If someone "fixes" a constant, the classification silently changes.
        XCTAssertEqual(EngineRecoveryPolicy.sessionNotActiveOSStatus, 561210739) // '!ses'
        XCTAssertEqual(EngineRecoveryPolicy.expiredSessionOSStatus, 560298096)   // '!exp'
        XCTAssertEqual(EngineRecoveryPolicy.mediaServicesFailedOSStatus, 560821106) // '!msr'
    }
}
