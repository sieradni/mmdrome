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

    // F7 (design review): slowLink never routes through shouldStreamDirectTap
    // — the old ratio form was vacuous (both estimates shared one rate, so the
    // rate cancelled and the decision reduced to lead×1.375 < duration, i.e.
    // "stream any track over ~21 s" regardless of the link). The engine calls
    // shouldStreamSlowLink for that mode; the direct-tap entry returns the
    // safe default so a caller that forgets the split cannot stream.
    func testSlowLinkModeFallsThroughToSafeDefault() {
        XCTAssertFalse(StreamPolicy.shouldStreamDirectTap(
            mode: .slowLink, rangeSupported: true, estimatedFullDownloadSeconds: 60, estimatedSecondsToPlayable: 10))
        XCTAssertFalse(StreamPolicy.shouldStreamDirectTap(
            mode: .slowLink, rangeSupported: false, estimatedFullDownloadSeconds: 600, estimatedSecondsToPlayable: 10))
    }

    func testSlowLinkSustainableLinkStaysOnFullDownload() {
        // 3 MB over 60 s = 50 KB/s delivered; the track needs 3 MB / 200 s =
        // 15 KB/s realtime. The link sustains playback and the wait is ~30 %
        // of the track — full download wins on simplicity (60 × 1.25 = 75 <
        // 200 → false).
        XCTAssertFalse(StreamPolicy.shouldStreamSlowLink(
            estimatedFullDownloadSeconds: 60, trackDuration: 200))
    }

    func testSlowLinkTrulySlowLinkStreams() {
        // 3 MB over 300 s: the download outlasts the song itself (200 s) —
        // the link cannot keep pace with the playhead, streaming is the only
        // timely path (300 × 1.25 = 375 > 200 → true).
        XCTAssertTrue(StreamPolicy.shouldStreamSlowLink(
            estimatedFullDownloadSeconds: 300, trackDuration: 200))
    }

    func testSlowLinkBorderlineMarginHoldsFullDownload() {
        // Exactly realtime (200 s download, 200 s track): ×1.25 margin streams.
        // A link with 25 % headroom (160 s vs 200 s) stays on full download.
        XCTAssertTrue(StreamPolicy.shouldStreamSlowLink(
            estimatedFullDownloadSeconds: 200, trackDuration: 200))
        XCTAssertFalse(StreamPolicy.shouldStreamSlowLink(
            estimatedFullDownloadSeconds: 160, trackDuration: 200))
    }

    func testSlowLinkZeroInputsNeverStream() {
        XCTAssertFalse(StreamPolicy.shouldStreamSlowLink(
            estimatedFullDownloadSeconds: 0, trackDuration: 200))
        XCTAssertFalse(StreamPolicy.shouldStreamSlowLink(
            estimatedFullDownloadSeconds: 100, trackDuration: 0))
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
