import Foundation
import XCTest
@testable import BackgroundAudioCore

final class QueueDivergenceTests: XCTestCase {

    func testMatchingActiveRowIsSynced() {
        XCTAssertEqual(queueDivergence(snapshotActiveId: "t1", engineCurrentId: "t1"), .synced)
    }

    func testMismatchedActiveRowIsDivergent() {
        XCTAssertEqual(queueDivergence(snapshotActiveId: "t1", engineCurrentId: "t2"), .divergent)
    }

    func testSnapshotWithoutActiveRowIsDivergent() {
        // Out-of-range snapshot active index is modelled as an empty id.
        XCTAssertEqual(queueDivergence(snapshotActiveId: "", engineCurrentId: "t2"), .divergent)
    }

    func testEngineIdleWithActiveSnapshotIsDivergent() {
        XCTAssertEqual(queueDivergence(snapshotActiveId: "t1", engineCurrentId: ""), .divergent)
    }

    func testBothEmptyIsSynced() {
        XCTAssertEqual(queueDivergence(snapshotActiveId: "", engineCurrentId: ""), .synced)
    }

    func testSynchronizedRefreshReanchorsMovedActiveIndex() {
        XCTAssertEqual(
            synchronizedQueueActiveIndex(
                snapshotActiveId: "t1",
                engineCurrentId: "t1",
                requestedIndex: 1,
                trackCount: 3
            ),
            1
        )
    }

    func testSynchronizedRefreshRejectsOutOfRangeIndex() {
        XCTAssertNil(
            synchronizedQueueActiveIndex(
                snapshotActiveId: "t1",
                engineCurrentId: "t1",
                requestedIndex: 2,
                trackCount: 2
            )
        )
    }

    func testSynchronizedRefreshRejectsMismatchedTrack() {
        XCTAssertNil(
            synchronizedQueueActiveIndex(
                snapshotActiveId: "t1",
                engineCurrentId: "t2",
                requestedIndex: 0,
                trackCount: 2
            )
        )
    }
}
