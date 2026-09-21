import Foundation
import XCTest
@testable import BackgroundAudioCore

final class StreamScheduleTests: XCTestCase {

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
}
