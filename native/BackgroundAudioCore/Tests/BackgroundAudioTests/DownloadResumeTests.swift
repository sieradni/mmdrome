import Foundation
import XCTest
@testable import BackgroundAudioCore

final class DownloadResumeTests: XCTestCase {

    // MARK: - planNextAttempt

    func testNoPendingNoResumeDataIsFresh() {
        XCTAssertEqual(DownloadResume.planNextAttempt(pending: nil, opaqueResumeData: nil), .fresh)
    }

    func testOpaqueResumeDataWinsOverPendingRange() {
        // URLSession's resumeData carries internal byte accounting a Range
        // request cannot see — it must win over a retained prefix.
        let pending = DownloadResume.Pending(parts: [1000], announcedTotal: 5000)
        XCTAssertEqual(
            DownloadResume.planNextAttempt(pending: pending, opaqueResumeData: Data([1, 2])),
            .opaqueResume)
    }

    func testPendingRangeOffsetEqualsDeliveredBytes() {
        let pending = DownloadResume.Pending(parts: [1000, 2000], announcedTotal: 8000)
        XCTAssertEqual(
            DownloadResume.planNextAttempt(pending: pending, opaqueResumeData: nil),
            .rangeAppend(offset: 3000))
    }

    func testEmptyPendingPartsIsFresh() {
        let pending = DownloadResume.Pending(parts: [], announcedTotal: 5000)
        XCTAssertEqual(
            DownloadResume.planNextAttempt(pending: pending, opaqueResumeData: nil),
            .fresh)
    }

    func testOpaqueResumeDataMarkerIsNeverRangeAppended() {
        // An entry created by the resumeData path holds its bytes INSIDE the
        // opaque data — its empty parts list must not produce offset 0
        // range requests.
        let pending = DownloadResume.Pending(parts: [], announcedTotal: 5000, fromOpaqueResumeData: true)
        XCTAssertEqual(
            DownloadResume.planNextAttempt(pending: pending, opaqueResumeData: nil),
            .fresh)
    }

    func testPartCapFallsBackToFresh() {
        let parts: [Int64] = [1, 2, 3, 4] // == maxParts
        let pending = DownloadResume.Pending(parts: parts, announcedTotal: 10_000)
        XCTAssertEqual(
            DownloadResume.planNextAttempt(pending: pending, opaqueResumeData: nil),
            .fresh)
    }

    // MARK: - range response validation (the double-append guard)

    func test206IsAppendable() {
        XCTAssertTrue(DownloadResume.rangeResponseIsAppendable(statusCode: 206))
    }

    func test200MeansServerIgnoredRange() {
        // A 200 answer carries the FULL body — appending would double the
        // bytes. The prefix must be discarded instead.
        XCTAssertFalse(DownloadResume.rangeResponseIsAppendable(statusCode: 200))
        XCTAssertFalse(DownloadResume.rangeResponseIsAppendable(statusCode: 404))
        XCTAssertFalse(DownloadResume.rangeResponseIsAppendable(statusCode: 416))
    }

    // MARK: - aligned-206 validation (2026-10-03, hard-error continuation
    // parity — the writer path must validate the Content-Range start exactly
    // as the download path always has)

    func testAligned206IsAppendable() {
        XCTAssertTrue(DownloadResume.rangeResponseIsAppendable(
            statusCode: 206, contentRangeStart: 3_349_014, requestedOffset: 3_349_014))
    }

    func testMisaligned206IsNotAppendable() {
        // A proxy re-serving from byte 0 (start 0) must NEVER be appended
        // onto the retained prefix: that splices the whole body behind it.
        XCTAssertFalse(DownloadResume.rangeResponseIsAppendable(
            statusCode: 206, contentRangeStart: 0, requestedOffset: 3_349_014))
    }

    func test206WithoutContentRangeIsNotAppendable() {
        // Parity with the download path: an absent Content-Range cannot be
        // proven aligned (`nil != reqOffset`), so it is discarded, not
        // appended.
        XCTAssertFalse(DownloadResume.rangeResponseIsAppendable(
            statusCode: 206, contentRangeStart: nil, requestedOffset: 3_349_014))
    }

    func testNon206IsNotAppendableRegardlessOfRange() {
        XCTAssertFalse(DownloadResume.rangeResponseIsAppendable(
            statusCode: 200, contentRangeStart: 3_349_014, requestedOffset: 3_349_014))
        XCTAssertFalse(DownloadResume.rangeResponseIsAppendable(
            statusCode: 416, contentRangeStart: nil, requestedOffset: 3_349_014))
    }

    // MARK: - Content-Range start parse (the misalignment guard)

    func testParseContentRangeStart() {
        XCTAssertEqual(DownloadResume.parseContentRangeStart("bytes 3700000-4999999/5000000"), 3_700_000)
        XCTAssertEqual(DownloadResume.parseContentRangeStart("bytes 0-99/100"), 0)
        XCTAssertEqual(DownloadResume.parseContentRangeStart("bytes  12 - 34 / 100"), 12, "whitespace tolerated")
        XCTAssertNil(DownloadResume.parseContentRangeStart("bytes */5000000"), "unsatisfied range carries no start")
        XCTAssertNil(DownloadResume.parseContentRangeStart("bytesy 0-1/2"))
        XCTAssertNil(DownloadResume.parseContentRangeStart(nil))
        XCTAssertNil(DownloadResume.parseContentRangeStart(""))
    }

    // MARK: - range header

    func testRangeHeaderFormat() {
        XCTAssertEqual(DownloadResume.rangeHeader(offset: 3_700_000), "bytes=3700000-")
        XCTAssertNil(DownloadResume.rangeHeader(offset: 0), "offset 0 is a full download, not a range")
        XCTAssertNil(DownloadResume.rangeHeader(offset: -5))
    }

    // MARK: - combined validation

    func testCombinedShortRawStreamIsRejected() {
        XCTAssertTrue(DownloadResume.combinedIsShort(
            combinedBytes: 4_999_999, announcedTotal: 5_000_000, isRawStream: true))
        XCTAssertFalse(DownloadResume.combinedIsShort(
            combinedBytes: 5_000_000, announcedTotal: 5_000_000, isRawStream: true))
        XCTAssertFalse(DownloadResume.combinedIsShort(
            combinedBytes: 5_000_001, announcedTotal: 5_000_000, isRawStream: true),
            "over-delivery (transparent compression) is never short")
    }

    func testCombinedTranscodeIsNeverJudged() {
        // A transcode's announced length is a server-side estimate.
        XCTAssertFalse(DownloadResume.combinedIsShort(
            combinedBytes: 100, announcedTotal: 5_000_000, isRawStream: false))
        XCTAssertFalse(DownloadResume.combinedIsShort(
            combinedBytes: 4_999_000, announcedTotal: 5_000_000, isRawStream: false))
    }

    func testCombinedUnknownAnnouncementIsNeverJudged() {
        XCTAssertFalse(DownloadResume.combinedIsShort(
            combinedBytes: 100, announcedTotal: 0, isRawStream: true))
    }

    // MARK: - deliveredBytes

    func testDeliveredBytesSumsParts() {
        let pending = DownloadResume.Pending(parts: [1_000, 2_000, 3_000], announcedTotal: 10_000)
        XCTAssertEqual(pending.deliveredBytes, 6_000)
    }

    // MARK: - writerContinuationEligible (2026-09-24, the in-loader writer
    // continuation for an ACTIVE stream's clean early close)

    func testWriterContinuationNeedsPositiveOffsetAndPart() {
        XCTAssertFalse(DownloadResume.writerContinuationEligible(offset: 0, hasRetainedPart: true),
                       "a zero offset would re-request the whole body into the append")
        XCTAssertFalse(DownloadResume.writerContinuationEligible(offset: 3_673_790, hasRetainedPart: false),
                       "an offset into a missing scratch splices wrong bytes (the misalignment poison class)")
        XCTAssertTrue(DownloadResume.writerContinuationEligible(offset: 3_673_790, hasRetainedPart: true))
    }

    // MARK: - writerErrorContinuationEligible (2026-10-03, the hard-error
    // continuation — the 1.2.50 restart-from-0:00 field defect). ONE decision
    // shared by the `.earlyClose` and `error != nil` writerDidComplete
    // branches so they cannot drift.

    func testWriterErrorContinuationBaselineIsEligible() {
        XCTAssertTrue(DownloadResume.writerErrorContinuationEligible(
            offset: 3_349_014,
            hasRetainedPart: true,
            continuationAttempt: 0,
            rangeUnsupported: false))
    }

    func testWriterErrorContinuationInheritsTheRetainedBytesGuard() {
        // The offset/scratch guard is the SAME one the early close uses — a
        // hard cut is not a license to splice from a phantom offset.
        XCTAssertFalse(DownloadResume.writerErrorContinuationEligible(
            offset: 0, hasRetainedPart: true, continuationAttempt: 0, rangeUnsupported: false),
            "zero delivered bytes: nothing to continue from")
        XCTAssertFalse(DownloadResume.writerErrorContinuationEligible(
            offset: 3_349_014, hasRetainedPart: false, continuationAttempt: 0, rangeUnsupported: false),
            "a missing scratch would splice wrong bytes")
    }

    func testWriterErrorContinuationRejectsRangeUnsupportedServer() {
        // A 200 answer to a Range request means the append would receive the
        // WHOLE body — double bytes. The one-shot memory must veto the
        // continuation on the hard-error path too.
        XCTAssertFalse(DownloadResume.writerErrorContinuationEligible(
            offset: 3_349_014, hasRetainedPart: true, continuationAttempt: 0, rangeUnsupported: true))
    }

    func testDeliberateCancelFlagWinsWhenTheErrorIsNotACancellation() {
        // THE QUEUED-ERROR RACE (2026-10-03b): the stall watchdog cancels a
        // task that had already completed with a NON-cancel error, so
        // cancel() is a no-op and the completion reports the original error.
        // Classification reads `notCancelled` — only the explicit flag set at
        // the cancel site can veto the continuation.
        XCTAssertTrue(DownloadResume.deliberateWriterCancel(
            explicitFlag: true, classifiedCancelled: false),
            "our own cancel must veto even when the surfaced error is not -999")
        // A system cancel with no flag is still a deliberate cancel.
        XCTAssertTrue(DownloadResume.deliberateWriterCancel(
            explicitFlag: false, classifiedCancelled: true))
        // A genuine transport cut is not.
        XCTAssertFalse(DownloadResume.deliberateWriterCancel(
            explicitFlag: false, classifiedCancelled: false))
    }

    func testWriterErrorContinuationRejectsDeliberateCancel() {
        // A stall give-up cancels the task on purpose; the -999 it produces
        // must NOT resurrect the stream the engine just gave up on. The veto
        // is part of the shared decision (defaulting false for the clean-close
        // caller, which carries no error at all).
        XCTAssertFalse(DownloadResume.writerErrorContinuationEligible(
            offset: 3_349_014, hasRetainedPart: true, continuationAttempt: 0,
            rangeUnsupported: false, deliberateCancel: true))
        // Omitting the parameter keeps the previous (eligible) behavior — the
        // early-close caller must be unaffected by this hard-error-only veto.
        XCTAssertTrue(DownloadResume.writerErrorContinuationEligible(
            offset: 3_349_014, hasRetainedPart: true, continuationAttempt: 0,
            rangeUnsupported: false))
    }

    func testWriterErrorContinuationLoopCap() {
        // Under the cap continues; at the cap yields to the JS retry (a server
        // closing at the same offset forever must not loop silently).
        XCTAssertTrue(DownloadResume.writerErrorContinuationEligible(
            offset: 3_349_014, hasRetainedPart: true,
            continuationAttempt: DownloadResume.maxWriterContinuations - 1,
            rangeUnsupported: false))
        XCTAssertFalse(DownloadResume.writerErrorContinuationEligible(
            offset: 3_349_014, hasRetainedPart: true,
            continuationAttempt: DownloadResume.maxWriterContinuations,
            rangeUnsupported: false))
    }

    func testMaxWriterContinuationsIsThree() {
        // Pinned literal: the `.earlyClose` branch shipped with a hard-coded
        // `< 3` and the regression alarm is a silent loop, so the number is
        // asserted here as the single source of truth.
        XCTAssertEqual(DownloadResume.maxWriterContinuations, 3)
    }

    // MARK: - responseFingerprintLine (2026-09-25, the early-close network
    // evidence — confirms or rules out Wi-Fi data assist / proxies)

    private func fingerprint(
        status: Int = 200,
        connection: String? = "keep-alive",
        contentLength: String? = "5280591",
        contentRange: String? = nil,
        acceptRanges: String? = "bytes",
        contentType: String? = "audio/ogg"
    ) -> DownloadResume.ResponseFingerprint {
        DownloadResume.ResponseFingerprint(
            statusCode: status,
            connectionHeader: connection,
            contentLengthHeader: contentLength,
            contentRangeHeader: contentRange,
            acceptRangesHeader: acceptRanges,
            contentTypeHeader: contentType)
    }

    func testFingerprintLineCarriesEveryHeaderVerbatim() {
        let line = DownloadResume.responseFingerprintLine(fingerprint())
        XCTAssertTrue(line.contains("status=200"), line)
        XCTAssertTrue(line.contains("conn=keep-alive"), line)
        XCTAssertTrue(line.contains("clen=5280591"), line)
        XCTAssertTrue(line.contains("crange=-"), line)
        XCTAssertTrue(line.contains("aranges=bytes"), line)
        XCTAssertTrue(line.contains("ctype=audio/ogg"), line)
    }

    func testFingerprintLineMarksMissingHeadersAndTruncatesLongValues() {
        // `Connection: close` from a proxy/data-assist path is THE verdict
        // signal — it must survive verbatim into the dump.
        let close = DownloadResume.responseFingerprintLine(
            fingerprint(connection: "close", contentType: nil))
        XCTAssertTrue(close.contains("conn=close"), close)
        XCTAssertTrue(close.contains("ctype=-"), close)

        let long = String(repeating: "x", count: 80)
        let line = DownloadResume.responseFingerprintLine(
            fingerprint(contentType: long))
        // Truncation keeps prefix(45) THEN appends the ellipsis.
        XCTAssertTrue(line.contains("ctype=" + String(repeating: "x", count: 45) + "..."), line)
        XCTAssertFalse(line.contains(long), "values over 48 chars must be truncated")
    }
}
