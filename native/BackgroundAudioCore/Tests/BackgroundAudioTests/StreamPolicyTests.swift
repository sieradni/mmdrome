import Foundation
import XCTest
@testable import BackgroundAudioCore

final class StreamPolicyTests: XCTestCase {

    // Streaming is fully integrated (2026-09-21 user decision): the mode
    // enum and its decision functions were REMOVED — eligibility is the
    // engine-side per-tap gate (`TrackFileLoader.streamDecision`), and the
    // policy core owns the staged contract's quantities only. The lead,
    // delivery, and verdict pins below ARE the policy now.

    // MARK: - lead sizing

    func testMinimumLeadMatchesCrossfadeCeiling() {
        XCTAssertEqual(StreamPolicy.minimumLeadSeconds, 15.0)
    }

    func testEffectiveLeadNeverExceedsTrackDuration() {
        XCTAssertEqual(StreamPolicy.effectiveLeadSeconds(trackDuration: 300), 15.0)
        XCTAssertEqual(StreamPolicy.effectiveLeadSeconds(trackDuration: 12), 12.0, "a 12 s jingle is playable whole")
        XCTAssertEqual(StreamPolicy.effectiveLeadSeconds(trackDuration: 0), 15.0, "unknown duration → conservative minimum")
    }

    // MARK: - bytes-for-lead estimate

    func testBytesForLeadIsProportionalWithHeadroom() {
        // 5 MB / 300 s = 16_667 B/s × 15 s × 1.10 ≈ 275_000.
        let b = StreamPolicy.bytesForLead(fileBytes: 5_000_000, trackDuration: 300, leadSeconds: 15)
        XCTAssertNotNil(b)
        XCTAssertEqual(b!, Int64(16_666.67 * 15 * 1.10), accuracy: 10)
    }

    func testBytesForLeadConservativeOnUnknownInputs() {
        // No evidence (size or duration unknown) → nil → the caller waits
        // for COMPLETE. No evidence, no streaming.
        XCTAssertNil(StreamPolicy.bytesForLead(fileBytes: 0, trackDuration: 300, leadSeconds: 15))
        XCTAssertNil(StreamPolicy.bytesForLead(fileBytes: 5_000_000, trackDuration: 0, leadSeconds: 15))
        XCTAssertNil(StreamPolicy.bytesForLead(fileBytes: 5_000_000, trackDuration: 300, leadSeconds: 0))
    }

    // MARK: - the writer's delivery policy (Phase 2)

    func testWriterDeliversAtLeadCrossing() {
        let lead: Int64 = 275_000
        XCTAssertTrue(StreamPolicy.writerShouldDeliver(accumulatedBytes: lead, leadRequiredBytes: lead, lastDeliveredAt: 0))
        // Below the lead: never.
        XCTAssertFalse(StreamPolicy.writerShouldDeliver(accumulatedBytes: lead - 1, leadRequiredBytes: lead, lastDeliveredAt: 0))
    }

    func testWriterFlushesInRungsAfterTheLead() {
        let lead: Int64 = 275_000
        // 512 KB past the last delivery → rung fires.
        XCTAssertTrue(StreamPolicy.writerShouldDeliver(
            accumulatedBytes: lead + StreamPolicy.writerFlushRungBytes,
            leadRequiredBytes: lead,
            lastDeliveredAt: lead))
        // Half a rung past → hold (no churn).
        XCTAssertFalse(StreamPolicy.writerShouldDeliver(
            accumulatedBytes: lead + StreamPolicy.writerFlushRungBytes / 2,
            leadRequiredBytes: lead,
            lastDeliveredAt: lead))
    }

    func testWriterNeverDeliversWithoutLeadEvidence() {
        // Unknown lead requirement → nil → the caller waits for COMPLETE.
        XCTAssertFalse(StreamPolicy.writerShouldDeliver(accumulatedBytes: 10_000_000, leadRequiredBytes: nil, lastDeliveredAt: 0))
    }

    // MARK: - the writer's completion verdict

    func testWriterPromotesOnExactAnnouncedBody() {
        XCTAssertEqual(StreamPolicy.writerCompleteVerdict(accumulatedBytes: 10_000_000, announcedBytes: 10_000_000), .promote)
        XCTAssertEqual(StreamPolicy.writerCompleteVerdict(accumulatedBytes: 10_000_001, announcedBytes: 10_000_000), .promote, "over-delivery (decompressed ≥ announced) promotes")
    }

    func testWriterEarlyCloseRetainsForRangeResume() {
        XCTAssertEqual(StreamPolicy.writerCompleteVerdict(accumulatedBytes: 4_000_000, announcedBytes: 10_000_000), .earlyClose)
    }

    func testWriterVerdictNilWithoutAnnouncedLength() {
        // No announced length → the byte verdict cannot run; the writer ends
        // with a completion-event judgment instead.
        XCTAssertNil(StreamPolicy.writerCompleteVerdict(accumulatedBytes: 10_000_000, announcedBytes: 0))
    }

    // MARK: - transcode streaming (2026-10-02)

    func testTranscodeVerdictIsAlwaysNil() {
        // A transcode's announced Content-Length is a server-side ESTIMATE of
        // the yet-to-be-encoded output: byte-exact promotion would false-close
        // on ordinary encode-size drift. The completion must end through the
        // decodability + duration-corroboration path instead — regardless of
        // how the accumulated bytes compare to the estimate.
        XCTAssertNil(StreamPolicy.writerCompleteVerdict(
            accumulatedBytes: 9_900_000, announcedBytes: 10_000_000, transcode: true))
        XCTAssertNil(StreamPolicy.writerCompleteVerdict(
            accumulatedBytes: 10_000_000, announcedBytes: 10_000_000, transcode: true))
        XCTAssertNil(StreamPolicy.writerCompleteVerdict(
            accumulatedBytes: 10_500_000, announcedBytes: 10_000_000, transcode: true))
        // The raw contract is unchanged by the new parameter.
        XCTAssertEqual(StreamPolicy.writerCompleteVerdict(
            accumulatedBytes: 10_000_000, announcedBytes: 10_000_000, transcode: false), .promote)
    }

    func testEffectiveTotalPrefersTheAnnouncedBody() {
        // Raw: the snapshot size IS the transfer total.
        XCTAssertEqual(StreamPolicy.effectiveTotalBytes(snapshotBytes: 5_000_000, announcedBytes: 0), 5_000_000)
        // Transcode: the snapshot size is the SOURCE file — the response's own
        // Content-Length is the output's total and must win.
        XCTAssertEqual(StreamPolicy.effectiveTotalBytes(snapshotBytes: 40_000_000, announcedBytes: 3_000_000), 3_000_000)
    }

    func testMayDeliverProgressWithholdsAnUnestimatedTranscode() {
        // A transcode with no announced total has no honest schedule end —
        // delivering a source would cycle the stall/give-up machine.
        XCTAssertFalse(StreamPolicy.mayDeliverProgress(announcedBytes: 0, transcode: true))
        XCTAssertTrue(StreamPolicy.mayDeliverProgress(announcedBytes: 3_000_000, transcode: true))
        // Raw is unchanged (its total comes from the snapshot).
        XCTAssertTrue(StreamPolicy.mayDeliverProgress(announcedBytes: 0, transcode: false))
    }
}
