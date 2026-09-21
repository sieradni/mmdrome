import Foundation
import XCTest
@testable import BackgroundAudioCore

final class StreamPolicyTests: XCTestCase {

    // MARK: - direct-tap decision

    func testOffModeNeverStreams() {
        XCTAssertFalse(StreamPolicy.shouldStreamDirectTap(
            mode: .off, rangeSupported: true, estimatedFullDownloadSeconds: 1000, estimatedSecondsToPlayable: 1))
    }

    func testOnModeStreamsWhenRangeSupported() {
        XCTAssertTrue(StreamPolicy.shouldStreamDirectTap(
            mode: .on, rangeSupported: true, estimatedFullDownloadSeconds: 3, estimatedSecondsToPlayable: 5))
        XCTAssertFalse(StreamPolicy.shouldStreamDirectTap(
            mode: .on, rangeSupported: false, estimatedFullDownloadSeconds: 1000, estimatedSecondsToPlayable: 1),
            "no Range support → no forward-progress guarantee → fallback")
    }

    func testSlowLinkOnlyStreamsWhenMeaningfullyFaster() {
        // Playable in 30 s vs full download in 20 s: full download WINS —
        // streaming would be slower to audible audio.
        XCTAssertFalse(StreamPolicy.shouldStreamDirectTap(
            mode: .slowLink, rangeSupported: true, estimatedFullDownloadSeconds: 20, estimatedSecondsToPlayable: 30))
        // Playable in 10 s vs full download in 60 s: stream.
        XCTAssertTrue(StreamPolicy.shouldStreamDirectTap(
            mode: .slowLink, rangeSupported: true, estimatedFullDownloadSeconds: 60, estimatedSecondsToPlayable: 10))
        // Borderline (within the 1.25× slack): the simpler full-download path.
        XCTAssertFalse(StreamPolicy.shouldStreamDirectTap(
            mode: .slowLink, rangeSupported: true, estimatedFullDownloadSeconds: 30, estimatedSecondsToPlayable: 28))
    }

    func testSlowLinkFallsBackWithoutRangeSupport() {
        XCTAssertFalse(StreamPolicy.shouldStreamDirectTap(
            mode: .slowLink, rangeSupported: false, estimatedFullDownloadSeconds: 600, estimatedSecondsToPlayable: 10))
    }

    // MARK: - the preload hard rule

    func testPreloadRowsNeverStream() {
        // The offline buffer (A14) is contractually immune to streaming.
        for mode in [StreamPolicy.Mode.off, .slowLink, .on] {
            XCTAssertFalse(StreamPolicy.shouldStreamPreloadRow(mode: mode))
        }
    }

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
}
