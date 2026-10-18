import XCTest
import AVFoundation
import StreamFileSupport
import BackgroundAudioCore

final class StreamFileObservationTests: XCTestCase {
    func testOpusGrowthUsesFreshReaderAndDrivesProductionDecisions() throws {
        let fixture = try XCTUnwrap(Bundle.module.url(forResource: "growth", withExtension: "opus", subdirectory: "Fixtures"))
        let bytes = try Data(contentsOf: fixture)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".opus")
        defer { try? FileManager.default.removeItem(at: url) }
        var observations: [Double] = []
        var scheduled: Int64 = 0
        var started = false
        // Append incomplete-page boundaries too: the next observation opens a
        // new reader; an old reader cannot supply the next growth decision.
        try Data().write(to: url)
        let writer = try FileHandle(forWritingTo: url)
        defer { try? writer.close() }
        var previous = 0
        for fraction in [0.05, 0.20, 0.50] {
            let count = Int(Double(bytes.count) * fraction)
            try writer.write(contentsOf: bytes.subdata(in: previous..<count))
            previous = count
            let file = try XCTUnwrap(StreamFileObservation.open(url), "Opus prefix must be readable on this host")
            let sr = file.processingFormat.sampleRate
            let seconds = Double(file.length) / sr
            observations.append(seconds)
            let end = StreamSchedule.stagedEndFramesEstimate(containerFrames: file.length,
                metadataFrames: Int64(120 * sr), deliveredBytes: Int64(count), announcedBytes: Int64(bytes.count))
            let action = StreamGrowth.decide(firstSchedule: !started, stalled: false,
                userPaused: false, interrupted: false, positionSeconds: 0, trackEndSeconds: 120,
                scheduledEndFrames: scheduled, schedulableEndFrames: end, sampleRate: sr, speed: 1)
            if fraction == 0.05 { XCTAssertEqual(action, .wait) }
            if fraction == 0.20 { XCTAssertEqual(action, .start); started = true; scheduled = end }
            if fraction == 0.50 { XCTAssertEqual(action, .extend(to: end)) }
        }
        XCTAssertGreaterThan(observations[1], observations[0])
        XCTAssertGreaterThan(observations[2], observations[1])
    }

    func testHeaderHighFormatRemainsBoundedByDeliveredRatio() throws {
        let fixture = try XCTUnwrap(Bundle.module.url(forResource: "header", withExtension: "flac", subdirectory: "Fixtures"))
        let bytes = try Data(contentsOf: fixture)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".flac")
        defer { try? FileManager.default.removeItem(at: url) }
        try bytes.prefix(bytes.count / 3).write(to: url)
        let file = try XCTUnwrap(StreamFileObservation.open(url))
        let sr = file.processingFormat.sampleRate
        let end = StreamSchedule.stagedEndFramesEstimate(containerFrames: file.length,
            metadataFrames: Int64(40 * sr), deliveredBytes: Int64(bytes.count / 3), announcedBytes: Int64(bytes.count))
        XCTAssertLessThanOrEqual(Double(end) / sr, 40.0 / 3.0)
    }

    func testEmptyOrMissingPrefixDefersWithoutThrowing() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        XCTAssertNil(StreamFileObservation.open(url))
        try Data().write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        XCTAssertNil(StreamFileObservation.open(url))
    }
}
