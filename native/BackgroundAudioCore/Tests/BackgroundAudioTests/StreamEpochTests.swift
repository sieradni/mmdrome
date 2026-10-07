import Foundation
import XCTest
@testable import BackgroundAudioCore

/// Pins for the pure epoch math and its runtime verdict (2026-10-07, Phase 2 of
/// `docs/plans/2026-10-07-seek-intent-and-stream-epochs.md`).
///
/// The load-bearing invariants: an epoch is never opened for a trivial scrub,
/// the offset parameter can never be duplicated, the byte expectation is
/// epoch-relative (fact 21: the server announces the FULL duration's bytes), an
/// unknown verdict is never treated as honored, and the tolerance band stays
/// bounded.
final class StreamEpochTests: XCTestCase {

    // MARK: - Offset request shaping

    func testOffsetURLSetsTheIntegerOffsetParameter() {
        let url = URL(string: "https://n.example/rest/stream.view?id=t1&format=opus&maxBitRate=128")!
        let epoch = StreamEpoch.offsetURL(url, seconds: 187.9)
        XCTAssertEqual(epoch?.queryValue(StreamEpoch.offsetParamName), "187")
        // The row's params survive untouched — the epoch is the same stream
        // with one more parameter.
        XCTAssertEqual(epoch?.queryValue("format"), "opus")
        XCTAssertEqual(epoch?.queryValue("id"), "t1")
    }

    func testOffsetURLReplacesRatherThanDuplicatesTheParameter() {
        let url = URL(string: "https://n.example/rest/stream.view?id=t1&timeOffset=5")!
        let epoch = StreamEpoch.offsetURL(url, seconds: 42)
        let occurrences = epoch!.queryItemsNamed(StreamEpoch.offsetParamName)
        XCTAssertEqual(occurrences, ["42"])
    }

    func testATrivialScrubOpensNoEpoch() {
        let url = URL(string: "https://n.example/rest/stream.view?id=t1&format=opus")!
        XCTAssertNil(StreamEpoch.offsetSeconds(0))
        XCTAssertNil(StreamEpoch.offsetSeconds(1.5))
        XCTAssertNil(StreamEpoch.offsetSeconds(-3))
        XCTAssertNil(StreamEpoch.offsetURL(url, seconds: 2.99))
        XCTAssertEqual(StreamEpoch.offsetSeconds(StreamEpoch.minimumOffsetSeconds), 3)
        XCTAssertEqual(StreamEpoch.offsetSeconds(600.4), 600)
    }

    func testNonFiniteOffsetsNeverOpenAnEpoch() {
        XCTAssertNil(StreamEpoch.offsetSeconds(.nan))
        XCTAssertNil(StreamEpoch.offsetSeconds(.infinity))
    }

    // MARK: - URL-shape capability

    func testURLShapeRecognizesTheTranscodeLaneOnly() {
        let transcode = URL(string: "https://n.example/rest/stream.view?id=t1&format=opus&maxBitRate=128")!
        let raw = URL(string: "https://n.example/rest/stream.view?id=t1&format=raw")!
        let plain = URL(string: "https://n.example/rest/stream.view?id=t1")!
        XCTAssertTrue(StreamEpoch.supportsServerOffset(transcode))
        XCTAssertFalse(StreamEpoch.supportsServerOffset(raw))
        XCTAssertFalse(StreamEpoch.supportsServerOffset(plain))
    }

    func testURLShapeIsNotFooledByPaddingOrCase() {
        XCTAssertTrue(StreamEpoch.supportsServerOffset(
            URL(string: "https://n.example/rest/stream.view?format=%20OPUS%20")!))
        XCTAssertFalse(StreamEpoch.supportsServerOffset(
            URL(string: "https://n.example/rest/stream.view?format=%20")!))
    }

    // MARK: - Cache quarantine (plan §2.7, acceptance 6)

    /// The load-bearing cache property: an epoch artifact can never be
    /// resolved as the row's own file. The key is DERIVED from the row key, so
    /// the two can never collide — and `servingURL` only ever reads
    /// `state.cache`, which holds row keys alone.
    func testEpochKeysCanNeverEqualARowKey() {
        let rowKey = "navidrome-t1|raw"
        let epochKey = StreamEpoch.epochKey(rowKey, offsetSeconds: 300)
        XCTAssertNotEqual(epochKey, rowKey)
        XCTAssertEqual(epochKey, "navidrome-t1|raw|epoch-300")
        XCTAssertTrue(StreamEpoch.isEpochKey(epochKey))
        XCTAssertFalse(StreamEpoch.isEpochKey(rowKey))
        // Distinct offsets are distinct artifacts (a new epoch can never
        // append onto the previous one).
        XCTAssertNotEqual(epochKey, StreamEpoch.epochKey(rowKey, offsetSeconds: 301))
    }

    func testPlainKeysAreNotMistakenForEpochKeys() {
        // A variant key that merely CONTAINS the word must not be treated as
        // an epoch (the marker is the pipe-delimited suffix).
        XCTAssertFalse(StreamEpoch.isEpochKey("navidrome-t1|epochs@128"))
        XCTAssertFalse(StreamEpoch.isEpochKey("navidrome-t1|opus@128"))
    }

    // MARK: - Capability decode

    func testCapabilityDecodesFromTheSnapshotDict() throws {
        let cap = try XCTUnwrap(SeekCapability(dict: [
            "canServerOffset": true,
            "clientSplice": "flac",
            "paramName": "timeOffset",
            "sourceBitrate": 900,
            "sourceFileType": "flac",
        ]))
        XCTAssertTrue(cap.canServerOffset)
        XCTAssertEqual(cap.clientSplice, "flac")
        XCTAssertEqual(cap.sourceBitrate, 900)
        XCTAssertEqual(cap.sourceFileType, "flac")
    }

    func testCapabilityWithoutTheDecisionBoolIsAbsent() {
        // A malformed/absent declaration degrades to the Phase-1 path.
        XCTAssertNil(SeekCapability(dict: ["clientSplice": "flac"]))
        XCTAssertEqual(SeekCapability(dict: ["canServerOffset": false])?.canServerOffset, false)
    }

    func testKillSwitchDecodesWithAutoAsTheOnlyOtherValue() {
        XCTAssertEqual(SeekEpochMode(rawValue: "auto"), .auto)
        XCTAssertEqual(SeekEpochMode(rawValue: "off"), .off)
        // An unknown value must never be read as `off` by accident at a call
        // site — the engine's default is `.auto` and its decoder is explicit.
        XCTAssertNil(SeekEpochMode(rawValue: "OFF"))
    }

    // MARK: - Epoch-relative expectations (fact 21)

    func testByteExpectationIsEpochRelative() {
        // 10 MB announced for a 600 s track; a 300 s offset epoch carries half.
        let bytes = StreamEpoch.expectedEpochBytes(announcedBytes: 10_000_000, trackSeconds: 600, offsetSeconds: 300)
        XCTAssertEqual(bytes, 5_000_000, accuracy: 1)
    }

    func testByteExpectationDegradesToZeroWithoutEvidence() {
        XCTAssertEqual(StreamEpoch.expectedEpochBytes(announcedBytes: 0, trackSeconds: 600, offsetSeconds: 30), 0)
        XCTAssertEqual(StreamEpoch.expectedEpochBytes(announcedBytes: 10_000, trackSeconds: 0, offsetSeconds: 30), 0)
    }

    func testExpectedEpochSecondsNeverGoesNegative() {
        XCTAssertEqual(StreamEpoch.expectedEpochSeconds(trackSeconds: 600, offsetSeconds: 300), 300)
        XCTAssertEqual(StreamEpoch.expectedEpochSeconds(trackSeconds: 600, offsetSeconds: 900), 0)
    }

    // MARK: - The runtime verdict (plan §2.6)

    func testAnEpochSizedContainerIsHonored() {
        // 44.1 kHz, 600 s track, 300 s offset ⇒ ~13.2 M expected epoch frames.
        let sr: Double = 44_100
        let trackFrames = 600 * sr
        let expected = 300 * sr
        let tol = StreamEpoch.toleranceSeconds(trackSeconds: 600) * sr
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: expected, expectedEpochFrames: expected,
            trackFrames: trackFrames, toleranceFrames: tol), .honored)
        // A piped FLAC patches its duration by `Duration - Offset`; a claim a
        // shade short of the expectation is still the offset lane.
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: expected - 1_500_000, expectedEpochFrames: expected,
            trackFrames: trackFrames, toleranceFrames: tol), .honored)
        // The honored band EDGE: at `expected + tol` still counts, one frame
        // past it does not — the two bands must never overlap.
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: expected + tol, expectedEpochFrames: expected,
            trackFrames: trackFrames, toleranceFrames: tol), .honored)
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: expected + tol + 1, expectedEpochFrames: expected,
            trackFrames: trackFrames, toleranceFrames: tol), .unknown)
    }

    func testAFullLengthContainerIsTheIgnoredOffset() {
        let sr: Double = 44_100
        let trackFrames = 600 * sr
        let expected = 300 * sr
        let tol = StreamEpoch.toleranceSeconds(trackSeconds: 600) * sr
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: trackFrames, expectedEpochFrames: expected,
            trackFrames: trackFrames, toleranceFrames: tol), .ignored)
        // The band EDGES, so "≈" cannot drift into "roughly anywhere near":
        // exactly at `track − tol` is still the full-track shape, one frame
        // further in is NOT.
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: trackFrames - tol, expectedEpochFrames: expected,
            trackFrames: trackFrames, toleranceFrames: tol), .ignored)
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: trackFrames - tol - 1, expectedEpochFrames: expected,
            trackFrames: trackFrames, toleranceFrames: tol), .unknown)
        // A container 10 % short of the track is neither shape: it must DISCARD
        // (500 s between a 300 s expectation and a 600 s track). The 540 s case
        // this test used to call `ignored` was the same between-bands shape the
        // next test pins as `unknown`, and calling it `ignored` would have
        // adopted a transfer with no bandwidth evidence that it is the full one
        // (CI, 2026-10-07).
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: 540 * sr, expectedEpochFrames: expected,
            trackFrames: trackFrames, toleranceFrames: tol), .unknown)
    }

    func testABetweenBandsContainerIsUnknownAndNeverHonored() {
        // The dangerous middle: a container claiming neither the epoch nor the
        // track. Guessing "honored" here would schedule the wrong audio.
        let sr: Double = 44_100
        let trackFrames = 600 * sr
        let expected = 300 * sr
        let tol = StreamEpoch.toleranceSeconds(trackSeconds: 600) * sr
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: 450 * sr, expectedEpochFrames: expected,
            trackFrames: trackFrames, toleranceFrames: tol), .unknown)
    }

    func testNoEvidenceIsUnknown() {
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: 0, expectedEpochFrames: 100, trackFrames: 1000, toleranceFrames: 10), .unknown)
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: 100, expectedEpochFrames: 100, trackFrames: 0, toleranceFrames: 10), .unknown)
        XCTAssertEqual(StreamEpoch.offsetHonored(
            containerFrames: .nan, expectedEpochFrames: 100, trackFrames: 1000, toleranceFrames: 10), .unknown)
    }

    func testVerdictToleranceStaysBounded() {
        XCTAssertEqual(StreamEpoch.toleranceSeconds(trackSeconds: 0), StreamEpoch.minToleranceSeconds)
        XCTAssertEqual(StreamEpoch.toleranceSeconds(trackSeconds: 60), StreamEpoch.minToleranceSeconds)
        XCTAssertEqual(StreamEpoch.toleranceSeconds(trackSeconds: 3600), StreamEpoch.maxToleranceSeconds)
        XCTAssertEqual(StreamEpoch.toleranceSeconds(trackSeconds: 600), 6, accuracy: 0.001)
    }

    // MARK: - Endable frames and the tail gap

    func testEndableFramesNeverExceedTheContainersOwnClaim() {
        XCTAssertEqual(StreamEpoch.epochEndableFrames(containerFrames: 100, expectedEpochFrames: 500), 100)
        XCTAssertEqual(StreamEpoch.epochEndableFrames(containerFrames: 900, expectedEpochFrames: 500), 500)
        XCTAssertEqual(StreamEpoch.epochEndableFrames(containerFrames: -5, expectedEpochFrames: 500), 0)
    }

    func testEpochEndIsTrackEnd() {
        XCTAssertTrue(StreamEpoch.epochEndIsTrackEnd(
            offsetSeconds: 300, epochSeconds: 300, declaredTrackSeconds: 600, toleranceSeconds: 6))
        // A short epoch leaves a TAIL GAP: the row's remaining seconds still
        // need the row's own transfer.
        XCTAssertFalse(StreamEpoch.epochEndIsTrackEnd(
            offsetSeconds: 300, epochSeconds: 200, declaredTrackSeconds: 600, toleranceSeconds: 6))
        // No declared duration = no evidence of a gap.
        XCTAssertTrue(StreamEpoch.epochEndIsTrackEnd(
            offsetSeconds: 300, epochSeconds: 10, declaredTrackSeconds: 0, toleranceSeconds: 6))
    }
}

// MARK: - Test helpers

private extension URL {
    func queryValue(_ name: String) -> String? {
        URLComponents(url: self, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == name })?.value
    }

    func queryItemsNamed(_ name: String) -> [String] {
        (URLComponents(url: self, resolvingAgainstBaseURL: false)?
            .queryItems ?? []).filter { $0.name == name }.map { $0.value ?? "" }
    }
}
