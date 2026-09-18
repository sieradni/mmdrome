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

    func testMissingServerLengthNeverTruncates() {
        XCTAssertFalse(DownloadSanity.isTruncatedAgainstServer(storedBytes: 0, serverLength: 0))
        XCTAssertFalse(DownloadSanity.isTruncatedAgainstServer(storedBytes: 5_000, serverLength: 0))
        XCTAssertFalse(DownloadSanity.isTruncatedAgainstServer(storedBytes: 5_000, serverLength: -1))
    }

    // MARK: - Bytes-per-second floor

    func testMinimumBytesPerSecondFloors() {
        // 44.1 kHz compressed: 44100*1/16 ≈ 2756 B/s (16 kbit mono floor).
        XCTAssertEqual(DownloadSanity.minimumBytesPerSecond(sampleRateHz: 44_100, fileExtension: "flac"), 44100.0 / 16, accuracy: 0.001)
        // .wav byte-fails AVAudioFile for compressed bytes, so its floor is
        // the lossless one (rate/2): a truncation MUST stay detected.
        XCTAssertEqual(DownloadSanity.minimumBytesPerSecond(sampleRateHz: 44_100, fileExtension: "wav"), 22050.0, accuracy: 0.001)
        // Zero/unknown rate falls back to 44.1 kHz.
        XCTAssertEqual(DownloadSanity.minimumBytesPerSecond(sampleRateHz: 0, fileExtension: nil), 44100.0 / 16, accuracy: 0.001)
        // Never zero.
        XCTAssertGreaterThan(DownloadSanity.minimumBytesPerSecond(sampleRateHz: 8000, fileExtension: "mp3"), 0)
    }

    // MARK: - Header clamp

    func testClampCapsHeaderFramesToBytePlausible() {
        // A 3 MB store at a 16 kbit mono floor and 44.1 kHz can hold at most
        // ~1143 s — a 200 s claim is inside the bound (no clamp).
        let minBps = DownloadSanity.minimumBytesPerSecond(sampleRateHz: 44_100, fileExtension: "flac")
        let unclamped = DownloadSanity.clampedScheduledFrames(
            headerFrames: 200 * 44_100,
            storedBytes: 3_000_000,
            minimumBytesPerSecond: minBps,
            sampleRateHz: 44_100
        )
        XCTAssertEqual(unclamped, Int64(200 * 44_100))

        // Same bytes, but the source was 96 kHz FLAC: 96000/16 = 6000
        // frames/byte → 3 MB could only hold ~500 s. A 200 s claim still
        // fits; a 3000 s header claim does not.
        let clampBps = DownloadSanity.minimumBytesPerSecond(sampleRateHz: 96_000, fileExtension: "flac")
        let clamped = DownloadSanity.clampedScheduledFrames(
            headerFrames: 3000 * 44_100,
            storedBytes: 3_000_000,
            minimumBytesPerSecond: clampBps,
            sampleRateHz: 44_100
        )
        XCTAssertLessThan(clamped, Int64(3000 * 44_100))
        XCTAssertGreaterThan(clamped, 0)
    }

    func testClampIsIdentityWithoutByteEvidence() {
        let minBps = DownloadSanity.minimumBytesPerSecond(sampleRateHz: 44_100, fileExtension: "flac")
        XCTAssertEqual(
            DownloadSanity.clampedScheduledFrames(headerFrames: 480_000, storedBytes: nil, minimumBytesPerSecond: minBps, sampleRateHz: 44_100),
            Int64(480_000)
        )
        XCTAssertEqual(
            DownloadSanity.clampedScheduledFrames(headerFrames: 480_000, storedBytes: 0, minimumBytesPerSecond: minBps, sampleRateHz: 44_100),
            Int64(480_000)
        )
        XCTAssertEqual(
            DownloadSanity.clampedScheduledFrames(headerFrames: 480_000, storedBytes: 4096, minimumBytesPerSecond: minBps, sampleRateHz: 0),
            Int64(480_000)
        )
    }

    func testClampNeverZeroesASchedule() {
        let minBps = DownloadSanity.minimumBytesPerSecond(sampleRateHz: 44_100, fileExtension: "flac")
        // A 1-byte store against a huge header still yields >= 1 frame: the
        // byte-plausible bound is 16 frames/byte (44.1 kHz / 2756 B/s), the
        // 4% overhead divides it to 15 — never 0.
        let clamped = DownloadSanity.clampedScheduledFrames(
            headerFrames: 48_000_000,
            storedBytes: 1,
            minimumBytesPerSecond: minBps,
            sampleRateHz: 44_100
        )
        XCTAssertEqual(clamped, 15)
        XCTAssertGreaterThan(clamped, 0)
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
