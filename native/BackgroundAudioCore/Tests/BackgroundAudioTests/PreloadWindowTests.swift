import XCTest
@testable import BackgroundAudioCore

/// Pins the pure preload-window derivation (2026-09-14): the engine's visible
/// window is walked in queue order from the playing row — the SAME chain
/// `prefetchUpcoming` fills — replacing the JS-pushed set that raced every
/// snapshot (push BEFORE the bridge call; reset to nil AFTER) and left the
/// instant completion hook dropping almost every `done`.
final class PreloadWindowTests: XCTestCase {
    func testWalksForwardFromActive() {
        // Playing row 0, 5 rows, count 3 → rows 1, 2, 3.
        XCTAssertEqual(preloadWindowIndexes(activeIndex: 0, trackCount: 5, count: 3, loopAll: false), [1, 2, 3])
    }

    func testNeverIncludesThePlayingRow() {
        // A short queue wraps back onto the player with loop-all: the playing
        // row must be skipped, not reported.
        XCTAssertEqual(preloadWindowIndexes(activeIndex: 0, trackCount: 3, count: 4, loopAll: true), [1, 2])
    }

    func testNoLoopAllStopsAtQueueEnd() {
        // Near the end without loop-all: only the rows that exist are walked.
        XCTAssertEqual(preloadWindowIndexes(activeIndex: 2, trackCount: 5, count: 4, loopAll: false), [3, 4])
    }

    func testLoopAllWrapsToTheHead() {
        XCTAssertEqual(preloadWindowIndexes(activeIndex: 3, trackCount: 5, count: 4, loopAll: true), [4, 0, 1, 2])
    }

    func testZeroCountIsEmpty() {
        XCTAssertEqual(preloadWindowIndexes(activeIndex: 0, trackCount: 5, count: 0, loopAll: false), [])
    }

    func testEmptyQueueIsEmpty() {
        XCTAssertEqual(preloadWindowIndexes(activeIndex: 0, trackCount: 0, count: 3, loopAll: true), [])
    }

    func testSingleTrackQueueNeverWrapsOntoItself() {
        XCTAssertEqual(preloadWindowIndexes(activeIndex: 0, trackCount: 1, count: 5, loopAll: true), [])
    }

    func testCountExceedingQueueYieldsAtMostTrackCountMinusOne() {
        // 5 rows, playing row 0, count 10 → 1..4 then stop (no loop).
        XCTAssertEqual(preloadWindowIndexes(activeIndex: 0, trackCount: 5, count: 10, loopAll: false), [1, 2, 3, 4])
    }
}
