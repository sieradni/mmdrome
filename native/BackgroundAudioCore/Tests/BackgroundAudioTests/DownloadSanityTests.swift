import Foundation
import XCTest
@testable import BackgroundAudioCore

final class DownloadSanityTests: XCTestCase {

    // MARK: - Server-length truncation gate

    func testTruncationAgainstServerLength() {
        // 10 MB announced, 3 MB stored — the LDM signature.
        XCTAssertTrue(DownloadSanity.isTruncatedAgainstServer(storedBytes: 3_000_000, serverLength: 10_000_000))
        // Exactly at the 10 % margin passes (>= 90 % of announced).
        XCTAssertFalse(DownloadSanity.isTruncatedAgainstServer(storedBytes: 9_000_000, serverLength: 10_000_000))
        // Marginally below the margin fails.
        XCTAssertTrue(DownloadSanity.isTruncatedAgainstServer(storedBytes: 8_900_000, serverLength: 10_000_000))
        // Complete transfer.
        XCTAssertFalse(DownloadSanity.isTruncatedAgainstServer(storedBytes: 10_000_000, serverLength: 10_000_000))
        // Oversized (chunked servers, gzip surprises) is NOT truncation.
        XCTAssertFalse(DownloadSanity.isTruncatedAgainstServer(storedBytes: 10_100_000, serverLength: 10_000_000))
    }

    // MARK: - Byte-exact announced-length gate (Connectivity Assist workaround)

    func testShortOfAnnouncedBytesDetection() {
        // Clean early close: server promised 4 MB, delivered 3.6 MB (90 %).
        // The error path never saw this (error == nil) and the 10 % metadata
        // margin PASSES it — this gate is the only defense.
        XCTAssertTrue(DownloadSanity.isShortOfAnnouncedBytes(actualBytes: 3_600_000, announcedBytes: 4_000_000))
        // One byte short is still short: the promise is exact.
        XCTAssertTrue(DownloadSanity.isShortOfAnnouncedBytes(actualBytes: 3_999_999, announcedBytes: 4_000_000))
        // Exact match passes.
        XCTAssertFalse(DownloadSanity.isShortOfAnnouncedBytes(actualBytes: 4_000_000, announcedBytes: 4_000_000))
        // Oversize is NOT a short delivery (transparent compression
        // decompresses to MORE than the announced compressed length).
        XCTAssertFalse(DownloadSanity.isShortOfAnnouncedBytes(actualBytes: 4_100_000, announcedBytes: 4_000_000))
    }

    func testMissingAnnouncedLengthNeverRejected() {
        // No Content-Length (chunked) — nothing to enforce.
        XCTAssertFalse(DownloadSanity.isShortOfAnnouncedBytes(actualBytes: 0, announcedBytes: 0))
        XCTAssertFalse(DownloadSanity.isShortOfAnnouncedBytes(actualBytes: 5_000, announcedBytes: 0))
        XCTAssertFalse(DownloadSanity.isShortOfAnnouncedBytes(actualBytes: 5_000, announcedBytes: -1))
    }

    func testMissingServerLengthNeverTruncates() {
        XCTAssertFalse(DownloadSanity.isTruncatedAgainstServer(storedBytes: 0, serverLength: 0))
        XCTAssertFalse(DownloadSanity.isTruncatedAgainstServer(storedBytes: 5_000, serverLength: 0))
        XCTAssertFalse(DownloadSanity.isTruncatedAgainstServer(storedBytes: 5_000, serverLength: -1))
    }

    // MARK: - Elapsed-time completion gate

    func testPrematureCompletionDetection() {
        // Playing 3 s of a 180 s segment with 100 s remaining, clock
        // measurable: premature (the LDM cascade signature).
        XCTAssertTrue(DownloadSanity.isPrematureCompletion(elapsedSeconds: 3, totalSeconds: 180, timeMeasured: true, remainingSeconds: 100))
        // Near the real end: legitimate.
        XCTAssertFalse(DownloadSanity.isPrematureCompletion(elapsedSeconds: 179.5, totalSeconds: 180, timeMeasured: true, remainingSeconds: 0.1))
        // Exactly 1 s remaining IS premature (the contract is >= 1 s — the
        // margin-side pin sits just below it, which a real completion can
        // never land on).
        XCTAssertTrue(DownloadSanity.isPrematureCompletion(elapsedSeconds: 179.0, totalSeconds: 180, timeMeasured: true, remainingSeconds: 1.0))
        // Just inside the margin passes (never test AT the boundary).
        XCTAssertFalse(DownloadSanity.isPrematureCompletion(elapsedSeconds: 179.2, totalSeconds: 180, timeMeasured: true, remainingSeconds: 0.8))
        // Unmeasurable clock (lastRenderTime/playerTime nil): the elapsed
        // read fell back to the stale cachedPosition — not evidence, never
        // judged.
        XCTAssertFalse(DownloadSanity.isPrematureCompletion(elapsedSeconds: 0.4, totalSeconds: 180, timeMeasured: false, remainingSeconds: 179))
        // Unknown segment length: not judgeable.
        XCTAssertFalse(DownloadSanity.isPrematureCompletion(elapsedSeconds: 3, totalSeconds: 0, timeMeasured: true, remainingSeconds: 0))
    }

    // MARK: - Transcode duration corroboration (2026-09-23, LDM post-mortem)

    func testTranscodeCorroborationCatchesMidStreamCut() {
        // The exact field shape: a 148 s track's opus@128 transcode cut at
        // ~92 s by a dead socket — the container's re-serialized page headers
        // report the audio the bytes ACTUALLY carry (Ogg granule positions
        // are accurate per page), the metadata still claims 148 s.
        XCTAssertTrue(DownloadSanity.transcodeDurationCorroborated(
            probeFrames: 92 * 44_100, sampleRate: 44_100,
            metadataDuration: 148.0, transcode: true))
    }

    func testTranscodeCorroborationPassesCompleteBody() {
        // Full body: the container claim matches the metadata within slop.
        XCTAssertFalse(DownloadSanity.transcodeDurationCorroborated(
            probeFrames: 148 * 44_100, sampleRate: 44_100,
            metadataDuration: 148.0, transcode: true))
        // Trivially under the floors: 1.5 s gap on a long track (metadata
        // slop / encoder padding territory).
        XCTAssertFalse(DownloadSanity.transcodeDurationCorroborated(
            probeFrames: Int64(146.5 * 44_100), sampleRate: 44_100,
            metadataDuration: 148.0, transcode: true))
        // Just over the absolute floor but inside the 8 % relative floor
        // (long track, small proportional gap: 10 s of a 180 s track).
        XCTAssertFalse(DownloadSanity.transcodeDurationCorroborated(
            probeFrames: Int64(170 * 44_100), sampleRate: 44_100,
            metadataDuration: 180.0, transcode: true))
    }

    func testTranscodeCorroborationHonestShortFileNeverRejected() {
        // KNOWN LIMIT (accepted, see core doc): a badly tagged short file
        // (metadata catastrophically wrong-LONG) is indistinguishable from
        // truncation by content — bytes track the audio carried in both
        // cases. Pinned as the CONTRACT, not a bug: the gate is claim-vs-
        // metadata only.
        XCTAssertTrue(DownloadSanity.transcodeDurationCorroborated(
            probeFrames: 30 * 44_100, sampleRate: 44_100,
            metadataDuration: 148.0, transcode: true))
    }

    func testTranscodeCorroborationRawNeverJudged() {
        // Raw streams keep the byte gates: their container claim is FULL
        // (the header downloaded complete), and a mis-tagged duration must
        // not false-reject them at the trust boundary.
        XCTAssertFalse(DownloadSanity.transcodeDurationCorroborated(
            probeFrames: 92 * 44_100, sampleRate: 44_100,
            metadataDuration: 148.0, transcode: false))
    }

    func testTranscodeCorroborationDegenerateInputs() {
        // Undecodable (already caught by the 0-frame gate) — the corroboration
        // has no claim to read.
        XCTAssertFalse(DownloadSanity.transcodeDurationCorroborated(
            probeFrames: 0, sampleRate: 44_100,
            metadataDuration: 148.0, transcode: true))
        // No usable sample rate: frames cannot become seconds.
        XCTAssertFalse(DownloadSanity.transcodeDurationCorroborated(
            probeFrames: 92 * 44_100, sampleRate: 0,
            metadataDuration: 148.0, transcode: true))
        // No metadata duration (or sub-second): nothing to corroborate against.
        XCTAssertFalse(DownloadSanity.transcodeDurationCorroborated(
            probeFrames: 92 * 44_100, sampleRate: 44_100,
            metadataDuration: 0, transcode: true))
        XCTAssertFalse(DownloadSanity.transcodeDurationCorroborated(
            probeFrames: 92 * 44_100, sampleRate: 44_100,
            metadataDuration: 0.5, transcode: true))
    }

    // MARK: - Mid-fade active-EOF adjudication (2026-09-25 dumps)

    func testMidFadeActiveEofNearEndFinalizes() {
        // THE FIELD SHAPES (both 2026-09-25 dumps: byte-complete streams,
        // clean promotes, no early closes): the measured position sits
        // 1.0-1.1 s short of the scheduled segment end when the active
        // node's one-shot dataConsumed completion fires mid-fade. The old
        // path called these premature and aborted the fade — stranding the
        // exhausted node into the D1 dead-air advance (~3 s late). The
        // near-end verdict is .finalizeNearEnd.
        XCTAssertEqual(DownloadSanity.midFadeActiveEofAction(
            elapsedSeconds: 201.4, totalSeconds: 202.5, remainingSeconds: 1.1,
            timeMeasured: true), .finalizeNearEnd)
        XCTAssertEqual(DownloadSanity.midFadeActiveEofAction(
            elapsedSeconds: 201.0, totalSeconds: 202.0, remainingSeconds: 1.0,
            timeMeasured: true), .finalizeNearEnd)
        // Just inside the epsilon from the other side (never test AT the
        // 2.0 boundary): 1.9 s of slop is still the finalize family.
        XCTAssertEqual(DownloadSanity.midFadeActiveEofAction(
            elapsedSeconds: 200.1, totalSeconds: 202.0, remainingSeconds: 1.9,
            timeMeasured: true), .finalizeNearEnd)
    }

    func testMidFadeActiveEofInsideMarginFinalizes() {
        // Inside the 1 s premature margin the completion is a plain real
        // end (the verdict isPrematureCompletion already passes): finalize.
        XCTAssertEqual(DownloadSanity.midFadeActiveEofAction(
            elapsedSeconds: 201.9, totalSeconds: 202.0, remainingSeconds: 0.1,
            timeMeasured: true), .finalize)
    }

    func testMidFadeActiveEofFarShortAborts() {
        // Genuine truncation evidence: the LDM signature EOFs MINUTES early.
        // The 2026-09-21e abort-keep-active stands for SHORT bytes (no
        // pause, no evict, no retry); the D1 watchdog owns the lost end.
        XCTAssertEqual(DownloadSanity.midFadeActiveEofAction(
            elapsedSeconds: 3, totalSeconds: 202.0, remainingSeconds: 199,
            timeMeasured: true), .abortKeepActive)
        // Far enough past the epsilon to stay the abort family.
        XCTAssertEqual(DownloadSanity.midFadeActiveEofAction(
            elapsedSeconds: 198.0, totalSeconds: 202.0, remainingSeconds: 4.0,
            timeMeasured: true), .abortKeepActive)
    }

    func testMidFadeActiveEofDegenerateInputs() {
        // Unmeasurable clock: the stale cachedPosition is not evidence (the
        // §3.4 rule) — and the ramp is mid-flight, so the switch point
        // guard defaults to finalize (the pre-2026-09-25 behavior for this
        // completion).
        XCTAssertEqual(DownloadSanity.midFadeActiveEofAction(
            elapsedSeconds: 0.4, totalSeconds: 180, remainingSeconds: 179,
            timeMeasured: false), .finalize)
        // Unknown segment length (0): not judgeable — same default.
        XCTAssertEqual(DownloadSanity.midFadeActiveEofAction(
            elapsedSeconds: 3, totalSeconds: 0, remainingSeconds: 0,
            timeMeasured: true), .finalize)
    }

    // MARK: - LoaderState byte bookkeeping

    func testStoredBytesRoundTripAndEvict() {
        var s = LoaderState<Int>()
        let url = URL(fileURLWithPath: "/tmp/x")
        s.store(url, for: "a", bytes: 4096)
        XCTAssertEqual(s.storedBytes(forFileAt: url), 4096)
        // A second store with no count clears the record (unknown != stale).
        s.store(url, for: "a", bytes: nil)
        XCTAssertNil(s.storedBytes(forFileAt: url))
        // Eviction clears the record too.
        s.store(url, for: "a", bytes: 4096)
        _ = s.evict("a")
        XCTAssertNil(s.storedBytes(forFileAt: url))
    }

    func testStoredBytesLookupByURL() {
        var s = LoaderState<Int>()
        let a = URL(fileURLWithPath: "/tmp/a")
        let b = URL(fileURLWithPath: "/tmp/b")
        s.store(a, for: "k1", bytes: 100)
        s.store(b, for: "k2", bytes: 200)
        XCTAssertEqual(s.storedBytes(forFileAt: a), 100)
        XCTAssertEqual(s.storedBytes(forFileAt: b), 200)
        XCTAssertNil(s.storedBytes(forFileAt: URL(fileURLWithPath: "/tmp/missing")))
    }
}
