import XCTest
@testable import BackgroundAudioCore

final class StreamGrowthTests: XCTestCase {
    private func decision(end: Double, scheduled: Double = 0, position: Double = 0,
                          first: Bool = false, stalled: Bool = false,
                          paused: Bool = false, interrupted: Bool = false, speed: Double = 1) -> StreamGrowth.Action {
        StreamGrowth.decide(firstSchedule: first, stalled: stalled, userPaused: paused,
                            interrupted: interrupted, positionSeconds: position, trackEndSeconds: 218,
                            scheduledEndFrames: Int64(scheduled * 48_000), schedulableEndFrames: Int64(end * 48_000),
                            sampleRate: 48_000, speed: speed)
    }

    func testGrowingOpusPrefixStartsExtendsAndResumesBeforeCompletion() {
        XCTAssertEqual(decision(end: 6, first: true), .wait)
        XCTAssertEqual(decision(end: 25, first: true), .start)
        XCTAssertEqual(decision(end: 60, scheduled: 25, position: 10), .extend(to: 2_880_000))
        XCTAssertEqual(decision(end: 63, scheduled: 60, position: 60, stalled: true), .resume)
    }

    func testReadableHeadroomTracksSpeedAndParkedSeek() {
        XCTAssertEqual(decision(end: 20, first: true, speed: 2), .wait)
        XCTAssertEqual(decision(end: 30, first: true, speed: 2), .start)
        XCTAssertEqual(decision(end: 8, first: true, speed: 0.5), .start)
        XCTAssertEqual(decision(end: 110, position: 100, first: true), .wait)
        XCTAssertEqual(decision(end: 116, position: 100, first: true), .start)
        XCTAssertEqual(decision(end: 103, position: 100, stalled: true, speed: 2), .wait)
    }

    func testLowHeadroomUsesSmallGrowthWhileOrdinaryGrowthIsBatched() {
        XCTAssertEqual(decision(end: 32, scheduled: 30, position: 10), .wait)
        XCTAssertEqual(decision(end: 32, scheduled: 30, position: 26), .extend(to: 1_536_000))
        XCTAssertEqual(decision(end: 30, scheduled: 30, position: 26), .wait)
    }

    func testAutomaticResumeHonorsPauseAndInterruption() {
        XCTAssertEqual(decision(end: 40, position: 10, stalled: true, paused: true), .wait)
        XCTAssertEqual(decision(end: 40, position: 10, stalled: true, interrupted: true), .wait)
        XCTAssertEqual(decision(end: 11, position: 10, stalled: true), .wait)
        XCTAssertEqual(decision(end: 12, position: 10, stalled: true), .resume)
    }

    func testTranscodeEstimateNeverAuthorizesCompletionRescue() {
        XCTAssertFalse(StreamSchedule.stallRescueEligible(deliveredBytes: 1200, announcedBytes: 1000, transcode: true))
        XCTAssertTrue(StreamSchedule.stallRescueEligible(deliveredBytes: 1000, announcedBytes: 1000))
    }

    func testFinalConsumedSegmentWaitsForAudibleTailAndPreservesPause() {
        XCTAssertEqual(StreamGrowth.endAction(playing: true, measured: true, position: 14,
            scheduledEnd: 15, speed: 1), .awaitRender(delay: 0.2))
        XCTAssertEqual(StreamGrowth.endAction(playing: false, measured: true, position: 14,
            scheduledEnd: 15, speed: 1), .park)
        XCTAssertEqual(StreamGrowth.endAction(playing: true, measured: true, position: 15,
            scheduledEnd: 15, speed: 1), .finish)
        XCTAssertEqual(StreamGrowth.endAction(playing: true, measured: false, position: 0,
            scheduledEnd: 15, speed: 1), .finish, "an unavailable clock cannot spin forever")
    }

    func testPumpCoalescesAndRunsTrailingArrivalAndInvalidatesOldSource() {
        var now = 0.0
        var tasks: [(Double, () -> Void)] = []
        var probes = 0
        let pump = StreamGrowthPump(now: { now }, schedule: { delay, action in
            tasks.append((now + delay, action))
            return {} // Deliberately simulate a cancellation whose callback still races.
        }, evaluate: { probes += 1 })
        pump.request()
        pump.request()
        XCTAssertEqual(tasks.count, 1)
        tasks.removeFirst().1()
        XCTAssertEqual(probes, 1)
        now = 0.01
        pump.request()
        pump.request()
        XCTAssertEqual(tasks[0].0, 0.2, accuracy: 0.00001)
        now = 0.2
        tasks.removeFirst().1()
        XCTAssertEqual(probes, 2)
        pump.request()
        pump.cancel()
        tasks.removeFirst().1()
        XCTAssertEqual(probes, 2, "a queued old-source evaluation must not run")
        pump.request()
        tasks.removeFirst().1()
        XCTAssertEqual(probes, 3)
    }
}
