import Foundation
import XCTest
@testable import BackgroundAudioCore

final class MaturationTests: XCTestCase {

    // MARK: - stage decisions

    func testCompleteWhenAnnouncedBodyDelivered() {
        XCTAssertEqual(
            Maturation.stage(received: 5_000_000, announced: 5_000_000, leadRequiredBytes: nil, headerProbeSaysAudio: false),
            .complete,
            "COMPLETE is byte-truth, no probe required")
        // Over-delivery (transparent compression) is still complete.
        XCTAssertEqual(
            Maturation.stage(received: 5_100_000, announced: 5_000_000, leadRequiredBytes: nil, headerProbeSaysAudio: false),
            .complete)
    }

    func testNoLeadRequirementNeverReachesPlayable() {
        // Unknown lead (nil) → conservative: headered at best, never playable.
        XCTAssertEqual(
            Maturation.stage(received: 1_000_000, announced: 5_000_000, leadRequiredBytes: nil, headerProbeSaysAudio: true),
            .headered)
    }

    func testHeaderedRequiresProbeEvidence() {
        // Lead covered but no probe yet → headered (the stage machine never
        // assumes the header landed — evidence rule, same as the codec probe).
        XCTAssertEqual(
            Maturation.stage(received: 1_000_000, announced: 5_000_000, leadRequiredBytes: 500_000, headerProbeSaysAudio: false),
            .headered)
        // Probe says the prefix opens as audio + lead covered → playable.
        XCTAssertEqual(
            Maturation.stage(received: 1_000_000, announced: 5_000_000, leadRequiredBytes: 500_000, headerProbeSaysAudio: true),
            .playable)
    }

    func testBelowLeadIsHeaderedOrEmpty() {
        XCTAssertEqual(
            Maturation.stage(received: 4_096, announced: 5_000_000, leadRequiredBytes: 500_000, headerProbeSaysAudio: true),
            .headered)
        XCTAssertEqual(
            Maturation.stage(received: 100, announced: 5_000_000, leadRequiredBytes: 500_000, headerProbeSaysAudio: false),
            .empty)
    }

    func testZeroAnnouncedIsNeverComplete() {
        // Unknown announced length (transcode estimate suppressed it): bytes
        // alone never declare COMPLETE — the byte gates judge complete files.
        XCTAssertEqual(
            Maturation.stage(received: 9_999_999, announced: 0, leadRequiredBytes: nil, headerProbeSaysAudio: true),
            .headered)
    }

    // MARK: - probe cadence

    func testProbeCadenceIsLogNotLinear() {
        // 4 KB, 8 KB, 16 KB, 32 KB, 64 KB … then the lead crossing itself.
        var probed: [Int64] = []
        var lastProbed: Int64 = 0
        for received in stride(from: Int64(1), through: 500_000, by: 1_000) {
            if Maturation.shouldProbeHeader(received: received, lastProbedAt: lastProbed, leadRequiredBytes: 500_000) {
                probed.append(received)
                lastProbed = received
            }
        }
        // Log cadence: well under 10 probes for a 500 KB download.
        XCTAssertLessThan(probed.count, 10, "probe cadence must be O(log), not O(bytes): \(probed)")
        // The lead crossing is always probed (playable-vs-headered decision).
        XCTAssertEqual(probed.last, 500_000)
    }

    func testNoProbeBelowMinimum() {
        XCTAssertFalse(Maturation.shouldProbeHeader(received: 100, lastProbedAt: 0, leadRequiredBytes: nil))
    }

    // MARK: - loader-side stall

    func testLoaderStallWhenRemainderUnder10Percent() {
        XCTAssertTrue(Maturation.isLoaderSideStall(received: 4_950_000, announced: 5_000_000),
                      "1 % remainder — the stream is at its tail")
        XCTAssertFalse(Maturation.isLoaderSideStall(received: 4_000_000, announced: 5_000_000),
                       "20 % remainder — plenty of headroom")
    }

    func testLoaderStallSafeWithUnknownAnnounced() {
        XCTAssertFalse(Maturation.isLoaderSideStall(received: 100, announced: 0))
    }
}
