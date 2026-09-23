import Foundation
import XCTest
@testable import BackgroundAudioCore

final class StreamScheduleTests: XCTestCase {

    // MARK: - The promote tail (F3, design review 2026-09-21)

    /// At completion the tail reaches the file's REAL end — no 5 s bar. The
    /// estimate's 2 % slack on a 4 min track is ~6 s; dropping it on the
    /// churn bar was silence at the end of every streamed track.
    func testCompletionTailReachesTheRealEndRegardlessOfChunkSize() {
        let sr: Double = 44_100
        let plan = StreamSchedule.completionTailPlan(
            currentEndFrames: 170_000_000,
            schedulableEndFrames: 170_352_800,
            sampleRate: sr,
            headerClaimedFrames: 170_352_800)
        XCTAssertEqual(plan, 170_352_800)
        // The sub-second tail shape (small file, 2 % slack under 5 s).
        let small = StreamSchedule.completionTailPlan(
            currentEndFrames: 10_000_000,
            schedulableEndFrames: 10_192_000,
            sampleRate: 48_000,
            headerClaimedFrames: 10_192_000)
        XCTAssertEqual(small, 10_192_000)
    }

    func testCompletionTailNilWhenNothingRemains() {
        let sr: Double = 44_100
        // Already at the end.
        XCTAssertNil(StreamSchedule.completionTailPlan(
            currentEndFrames: 170_352_800, schedulableEndFrames: 170_352_800,
            sampleRate: sr, headerClaimedFrames: 170_352_800))
        // Schedulable beyond the header claim: never rewind/overshoot — nil.
        XCTAssertNil(StreamSchedule.completionTailPlan(
            currentEndFrames: 200, schedulableEndFrames: 300,
            sampleRate: sr, headerClaimedFrames: 100))
        // No sample rate: no evidence, no plan.
        XCTAssertNil(StreamSchedule.completionTailPlan(
            currentEndFrames: 0, schedulableEndFrames: 100,
            sampleRate: 0, headerClaimedFrames: 100))
    }

    // MARK: - schedulableEndFrames (the lying-header clamp)

    func testSchedulableEndIsMinOfDeliveredAndHeaderClaim() {
        // Header claims 10M frames, only 2M delivered → 2M.
        XCTAssertEqual(StreamSchedule.schedulableEndFrames(deliveredEndFrames: 2_000_000, headerClaimedFrames: 10_000_000), 2_000_000)
        // Delivered everything (COMPLETE) → header claim is the cap.
        XCTAssertEqual(StreamSchedule.schedulableEndFrames(deliveredEndFrames: 12_000_000, headerClaimedFrames: 10_000_000), 10_000_000)
    }

    func testSchedulableEndNeverNegative() {
        XCTAssertEqual(StreamSchedule.schedulableEndFrames(deliveredEndFrames: -5, headerClaimedFrames: 100), 0)
        XCTAssertEqual(StreamSchedule.schedulableEndFrames(deliveredEndFrames: 100, headerClaimedFrames: -5), 0)
    }

    // MARK: - schedule contract

    func testCanScheduleRequiresNonEmptyInsideDelivery() {
        XCTAssertTrue(StreamSchedule.canSchedule(startFrame: 0, endFrames: 1000))
        XCTAssertTrue(StreamSchedule.canSchedule(startFrame: 500, endFrames: 1000), "mid-file seek inside delivered bytes")
        XCTAssertFalse(StreamSchedule.canSchedule(startFrame: 1000, endFrames: 1000), "empty segment")
        XCTAssertFalse(StreamSchedule.canSchedule(startFrame: 1500, endFrames: 1000), "seek past delivery must never schedule")
        XCTAssertFalse(StreamSchedule.canSchedule(startFrame: -1, endFrames: 1000))
    }

    // MARK: - extension decisions

    func testExtensionRequiresMeaningfulNewChunk() {
        let sr = 48000.0
        // 1000 frames newly schedulable (< 5 s) → churn, no extension.
        XCTAssertEqual(
            StreamSchedule.extensionPlan(currentEndFrames: 1_000_000, schedulableEndFrames: 1_001_000, sampleRate: sr, headerClaimedFrames: 2_000_000),
            .none)
        // A full 5 s chunk (240_000 frames) → extend.
        XCTAssertEqual(
            StreamSchedule.extensionPlan(currentEndFrames: 1_000_000, schedulableEndFrames: 1_240_000, sampleRate: sr, headerClaimedFrames: 2_000_000),
            .extend(to: 1_240_000))
    }

    func testExtensionStopsAtHeaderEnd() {
        // The delivered end passed the header claim (impossible upstream, but
        // the guard must hold): nothing to extend to.
        XCTAssertEqual(
            StreamSchedule.extensionPlan(currentEndFrames: 2_000_000, schedulableEndFrames: 2_500_000, sampleRate: 48000, headerClaimedFrames: 2_000_000),
            .none)
        // Already at the header end: no extension — the chained segments now
        // end the track (trackEnd verdict takes over).
        XCTAssertEqual(
            StreamSchedule.extensionPlan(currentEndFrames: 2_000_000, schedulableEndFrames: 2_000_000, sampleRate: 48000, headerClaimedFrames: 2_000_000),
            .none)
    }

    func testExtensionGuardAgainstZeroSampleRate() {
        XCTAssertEqual(
            StreamSchedule.extensionPlan(currentEndFrames: 0, schedulableEndFrames: 9_999_999, sampleRate: 0, headerClaimedFrames: 10_000_000),
            .none)
    }

    // MARK: - completion discrimination (the ONE new invariant)

    func testSegmentEndWhenChainedSuccessorExists() {
        XCTAssertEqual(StreamSchedule.completionVerdict(hasChainedSuccessor: true), .segmentEnd)
    }

    func testTrackEndOnFinalSegment() {
        XCTAssertEqual(StreamSchedule.completionVerdict(hasChainedSuccessor: false), .trackEnd)
    }

    // MARK: - stall handling

    func testStallImminentWithinOneSecondMargin() {
        let sr = 48000.0
        // 20_000 frames of lead left ≈ 0.42 s < 1 s margin → imminent.
        XCTAssertTrue(StreamSchedule.isStallImminent(playheadFrames: 1_000_000, schedulableEndFrames: 1_020_000, sampleRate: sr))
        // 100_000 frames ≈ 2.08 s > margin → not imminent.
        XCTAssertFalse(StreamSchedule.isStallImminent(playheadFrames: 1_000_000, schedulableEndFrames: 1_100_000, sampleRate: sr))
    }

    func testStallCheckSafeWithUnknownSampleRate() {
        XCTAssertFalse(StreamSchedule.isStallImminent(playheadFrames: 0, schedulableEndFrames: 0, sampleRate: 0))
    }

    // MARK: - premature completion verdicts

    func testStagedPrematureCompletionIsStallNotTruncation() {
        // The schedule contract makes this provable: a staged schedule ends
        // inside delivered bytes, so an early completion is a stall.
        for stage in [StreamSchedule.Stage.playable, .headered, .empty] {
            XCTAssertEqual(StreamSchedule.prematureCompletionVerdict(stage: stage), .streamStall)
        }
    }

    func testCompleteFilePrematureCompletionIsTruncation() {
        // COMPLETE files keep the existing poison path untouched.
        XCTAssertEqual(StreamSchedule.prematureCompletionVerdict(stage: .complete), .truncation)
    }

    // MARK: - the delivered-end estimate (Phase 2)

    func testEstimateIsProportionalAndBiasedLow() {
        // Header claims 10M frames for an announced 10 MB; 5 MB delivered →
        // 50 % × 0.98 slack ≈ 4.9M frames.
        let e = StreamSchedule.estimatedFramesEndable(
            headerClaimedFrames: 10_000_000, deliveredBytes: 5_000_000, announcedBytes: 10_000_000)
        XCTAssertEqual(e, 4_900_000)
        // Delivered everything → header claim × slack (never over-claims).
        let f = StreamSchedule.estimatedFramesEndable(
            headerClaimedFrames: 10_000_000, deliveredBytes: 10_000_000, announcedBytes: 10_000_000)
        XCTAssertEqual(f, 9_800_000)
    }

    func testEstimateConservativeOnUnknownInputs() {
        // No announced length, no delivered bytes, no header → 0: the caller
        // must not stage without evidence.
        XCTAssertEqual(StreamSchedule.estimatedFramesEndable(headerClaimedFrames: 0, deliveredBytes: 5_000_000, announcedBytes: 10_000_000), 0)
        XCTAssertEqual(StreamSchedule.estimatedFramesEndable(headerClaimedFrames: 10_000_000, deliveredBytes: 0, announcedBytes: 10_000_000), 0)
        XCTAssertEqual(StreamSchedule.estimatedFramesEndable(headerClaimedFrames: 10_000_000, deliveredBytes: 5_000_000, announcedBytes: 0), 0)
    }

    // MARK: - the buffering-pause resume decision

    func testResumeRequiresTwoSecondMargin() {
        let sr = 48000.0
        // 1 s of new audio beyond the stall → hold.
        XCTAssertFalse(StreamSchedule.shouldResumeAfterStall(stalledFrames: 1_000_000, schedulableEndFrames: 1_048_000, sampleRate: sr))
        // 2 s → resume.
        XCTAssertTrue(StreamSchedule.shouldResumeAfterStall(stalledFrames: 1_000_000, schedulableEndFrames: 1_096_000, sampleRate: sr))
    }

    func testResumeMarginIsBelowExtensionChurnBar() {
        // Resuming from a stall must be easier than timer-driven extension
        // (a stall re-schedules everything schedulable; extension avoids churn).
        XCTAssertLessThan(StreamSchedule.resumeMarginSeconds, StreamSchedule.minExtensionSeconds)
    }

    func testStallGiveUpIsBounded() {
        XCTAssertEqual(StreamSchedule.stallGiveUpSeconds, 10.0)
    }

    // MARK: - Phase 3: staged tracks and the crossfade

    func testFadeEligibilityTracksScheduleCompleteness() {
        XCTAssertFalse(StreamSchedule.fadeEligibility(isScheduleComplete: false),
                       "a streaming estimate under-promises — the fade window cannot cover the ramp")
        XCTAssertTrue(StreamSchedule.fadeEligibility(isScheduleComplete: true),
                      "a COMPLETE staged schedule is file truth — fades like any full-download track")
    }

    func testStagedEndVerdictMatrix() {
        XCTAssertEqual(
            StreamSchedule.stagedEndVerdict(isScheduleComplete: true, fadeInFlight: true),
            .finalizeSwitch,
            "complete + fade = the switch point; a direct advance would race the mid-ramp standby")
        XCTAssertEqual(
            StreamSchedule.stagedEndVerdict(isScheduleComplete: true, fadeInFlight: false),
            .advance)
        XCTAssertEqual(
            StreamSchedule.stagedEndVerdict(isScheduleComplete: false, fadeInFlight: false),
            .bufferingPause,
            "a staged promise expiring without a fade is the buffering pause — never an advance")
        XCTAssertEqual(
            StreamSchedule.stagedEndVerdict(isScheduleComplete: false, fadeInFlight: true),
            .abortFadeThenPause,
            "contractually impossible — defense in depth: no finalize against an expired promise")
    }

    // MARK: - F3: the stall-ledger rescue (2026-09-22 field dump)

    func testStallRescueFiresWhenDeliveredReachesAnnounced() {
        // Row 4's exact shape: the playhead stalled at the delivered end
        // while the transfer had in fact finished (its completion was lost —
        // the F1 class). Remaining stalled is a defect, not bandwidth.
        XCTAssertTrue(StreamSchedule.stallRescueEligible(deliveredBytes: 3_027_467, announcedBytes: 3_027_467))
        XCTAssertTrue(StreamSchedule.stallRescueEligible(deliveredBytes: 3_027_467, announcedBytes: 3_000_000))
    }

    func testStallRescueHoldsWhenTransferStillShort() {
        // A genuine slow link still owes bytes — the buffering pause and the
        // give-up timer stay in charge.
        XCTAssertFalse(StreamSchedule.stallRescueEligible(deliveredBytes: 1_500_000, announcedBytes: 3_027_467))
    }

    func testStallRescueNeverFiresWithoutAnnouncedEvidence() {
        // No Content-Length: equality with zero means nothing — the give-up
        // path (Range-continue + decodability gate) stays the sole recovery.
        XCTAssertFalse(StreamSchedule.stallRescueEligible(deliveredBytes: 0, announcedBytes: 0))
        XCTAssertFalse(StreamSchedule.stallRescueEligible(deliveredBytes: 500, announcedBytes: 0))
    }

    // MARK: - D1: the dead-air watchdog (2026-09-23 field dumps)

    func testDeadAirAdvanceFiresPastTheScheduledEnd() {
        // The dump signature: clock climbing seconds past the scheduled end
        // while playing (170.2 of 161.05; 166.7 of 148.3) — the node is
        // silent, its completion is gone, nothing will ever advance.
        XCTAssertTrue(StreamSchedule.deadAirAdvanceEligible(
            isPlaying: true, timeMeasured: true,
            elapsedSeconds: 170.2, scheduledEndSeconds: 161.05, loopOne: false))
        XCTAssertTrue(StreamSchedule.deadAirAdvanceEligible(
            isPlaying: true, timeMeasured: true,
            elapsedSeconds: 166.7, scheduledEndSeconds: 148.33, loopOne: false))
    }

    func testDeadAirHoldsInsideTheGraceWindow() {
        // A healthy tail approaching its real end must never be raced: the
        // data-consumed completion fires AT the data end, which can sit
        // slightly past the scheduled seconds float rounding — the grace
        // absorbs it.
        XCTAssertFalse(StreamSchedule.deadAirAdvanceEligible(
            isPlaying: true, timeMeasured: true,
            elapsedSeconds: 161.9, scheduledEndSeconds: 161.05, loopOne: false))
    }

    func testDeadAirHoldsWhenNotPlayingOrUnmeasurable() {
        // A paused wedge belongs to the buffering-stall / sleep-park
        // machines; an unmeasurable clock means the position fell back to
        // the stale cachedPosition — not evidence (the §3.4 rule).
        XCTAssertFalse(StreamSchedule.deadAirAdvanceEligible(
            isPlaying: false, timeMeasured: true,
            elapsedSeconds: 200, scheduledEndSeconds: 161.05, loopOne: false))
        XCTAssertFalse(StreamSchedule.deadAirAdvanceEligible(
            isPlaying: true, timeMeasured: false,
            elapsedSeconds: 200, scheduledEndSeconds: 161.05, loopOne: false))
    }

    func testDeadAirNeverAdvancesLoopOne() {
        // Loop-one restarts via its own path; a watchdog advance there would
        // double-advance.
        XCTAssertFalse(StreamSchedule.deadAirAdvanceEligible(
            isPlaying: true, timeMeasured: true,
            elapsedSeconds: 200, scheduledEndSeconds: 161.05, loopOne: true))
    }
}
