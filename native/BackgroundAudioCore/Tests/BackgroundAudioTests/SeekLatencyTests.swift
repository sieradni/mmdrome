import Foundation
import XCTest
@testable import BackgroundAudioCore

/// Pins the pure seek-latency accounting (plan Phase 4 item 3): the numbers a
/// field dump is asked to trust must not be re-derivable.
final class SeekLatencyTests: XCTestCase {

    func testLegsAreDeltasFromTheRequestInPipelineOrder() {
        var probe = SeekLatency.Probe(trackId: "tr_1", targetSeconds: 42.5, requestedAt: 100)
        probe.note(strategy: "epoch")
        probe.mark(.decision, at: 100.0004)
        probe.mark(.firstByte, at: 100.812)
        probe.mark(.firstSchedule, at: 100.834)
        probe.mark(.firstPlayback, at: 100.861)
        let report = probe.report()
        XCTAssertEqual(report.decisionMs!, 0.4, accuracy: 0.05)
        XCTAssertEqual(report.firstByteMs!, 812.0, accuracy: 0.5)
        XCTAssertEqual(report.firstScheduleMs!, 834.0, accuracy: 0.5)
        XCTAssertEqual(report.firstPlaybackMs!, 861.0, accuracy: 0.5)
        XCTAssertEqual(report.totalMs!, 861.0, accuracy: 0.5)
        XCTAssertTrue(report.complete)
        XCTAssertFalse(report.firstByteInferred)
        XCTAssertEqual(report.strategy, "epoch")
        // Pipeline order is the declaration order (the line reads in this order).
        XCTAssertEqual(
            SeekLatencyLeg.allCases.map(\.order),
            [0, 1, 2, 3])
    }

    func testTheFirstMarkWins() {
        var probe = SeekLatency.Probe(trackId: "tr_1", targetSeconds: 10, requestedAt: 0)
        XCTAssertTrue(probe.mark(.firstByte, at: 5))
        // A retry / a second transfer for the same seek must not inflate the leg.
        XCTAssertFalse(probe.mark(.firstByte, at: 90))
        XCTAssertEqual(probe.report().firstByteMs!, 5000, accuracy: 0.001)
    }

    func testAnUnobservedByteLegIsInferredFromTheScheduleAndMarkedInTheLine() {
        // The downloadTask lane has no progress callback: a seek into an
        // unloaded non-transcoded row can produce a schedule without ever
        // seeing a byte callback. The report says so rather than inventing one.
        var probe = SeekLatency.Probe(trackId: "tr_9", targetSeconds: 30, requestedAt: 0)
        probe.mark(.decision, at: 0.001)
        probe.mark(.firstSchedule, at: 1.2)
        let report = probe.report()
        XCTAssertTrue(report.firstByteInferred)
        XCTAssertEqual(report.firstByteMs!, 1200, accuracy: 0.5)
        XCTAssertFalse(report.complete) // no playback yet
        let line = SeekLatency.line(report)
        XCTAssertTrue(line.contains("firstByte=1200.0ms*"), line)
        XCTAssertTrue(line.contains("firstPlayback=-ms"), line)
        XCTAssertTrue(line.contains("total=-ms"), line)
    }

    func testAnIncompleteProbeReportsMissingLegsAsPlaceholders() {
        var probe = SeekLatency.Probe(trackId: "tr_2", targetSeconds: 5, requestedAt: 0)
        probe.mark(.decision, at: 0.002)
        let line = SeekLatency.line(probe.report())
        XCTAssertTrue(line.contains("decision=2.0ms"), line)
        XCTAssertTrue(line.contains("firstByte=-ms"), line)
        XCTAssertTrue(line.contains("firstSchedule=-ms"), line)
        XCTAssertTrue(line.contains("firstPlayback=-ms"), line)
        XCTAssertTrue(line.hasPrefix("seek latency id=tr_2 target=5.0s strategy=unknown"), line)
    }

    func testAProbeOnlyAcceptsItsOwnRowInsideItsLifetime() {
        let probe = SeekLatency.Probe(trackId: "tr_1", targetSeconds: 5, requestedAt: 100)
        XCTAssertTrue(probe.accepts(trackId: "tr_1", at: 100))
        XCTAssertTrue(probe.accepts(trackId: "tr_1", at: 100 + SeekLatency.maximumProbeAgeSeconds))
        // Another row can never complete this seek.
        XCTAssertFalse(probe.accepts(trackId: "tr_2", at: 100))
        // A play pressed a minute later is the user's own pause, not latency.
        XCTAssertFalse(probe.accepts(trackId: "tr_1", at: 100 + SeekLatency.maximumProbeAgeSeconds + 0.001))
        // Clock skew must not author a negative leg.
        XCTAssertFalse(probe.accepts(trackId: "tr_1", at: 99))
    }

    func testTheLineCarriesEveryLabelExactlyOnceSoTheFoldCannotDrift() {
        var probe = SeekLatency.Probe(trackId: "tr_3", targetSeconds: 12.25, requestedAt: 0)
        probe.note(strategy: "staged-stall")
        for (index, leg) in SeekLatencyLeg.allCases.enumerated() {
            probe.mark(leg, at: Double(index + 1) / 10)
        }
        let line = SeekLatency.line(probe.report())
        XCTAssertFalse(line.contains("\n"))
        for label in ["id=", "target=", "strategy=", "decision=", "firstByte=", "firstSchedule=", "firstPlayback=", "total="] {
            XCTAssertEqual(line.components(separatedBy: label).count - 1, 1, "\(label) in \(line)")
        }
        XCTAssertTrue(line.contains("target=12.2s") || line.contains("target=12.3s"), line)
        XCTAssertTrue(line.contains("total=400.0ms"), line)
    }
}
