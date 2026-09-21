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

    func testRefreshDecisionSyncedMatchesLiveRow() {
        XCTAssertEqual(
            queueRefreshDecision(
                snapshotActiveId: "t2",
                engineCurrentId: "t2",
                requestedIndex: 1,
                trackCount: 4,
                snapshotTrackIds: ["t1", "t2", "t3", "t4"]
            ),
            .synced(index: 1)
        )
    }

    func testRefreshDecisionSyncedOutOfRangeIsDivergent() {
        XCTAssertEqual(
            queueRefreshDecision(
                snapshotActiveId: "t2",
                engineCurrentId: "t2",
                requestedIndex: 9,
                trackCount: 4,
                snapshotTrackIds: ["t1", "t2", "t3", "t4"]
            ),
            .divergent
        )
    }

    func testRefreshDecisionLagToleratedWhenLiveRowExistsInSnapshot() {
        // The crossed-flight advance shape: JS's snapshot still names the
        // just-played row as active, but the row the ENGINE is playing (t3)
        // exists in the snapshot at index 2. Reconcile without stopping.
        XCTAssertEqual(
            queueRefreshDecision(
                snapshotActiveId: "t2",
                engineCurrentId: "t3",
                requestedIndex: 1,
                trackCount: 4,
                snapshotTrackIds: ["t1", "t2", "t3", "t4"]
            ),
            .containsCurrent(index: 2)
        )
    }

    func testRefreshDecisionLagToleratedIgnoresSnapshotActiveIndex() {
        // The snapshot's OWN active index is behind and possibly stale; the
        // re-anchor index comes from where the live row LIVES in the snapshot.
        XCTAssertEqual(
            queueRefreshDecision(
                snapshotActiveId: "t1",
                engineCurrentId: "t4",
                requestedIndex: 0,
                trackCount: 4,
                snapshotTrackIds: ["t1", "t2", "t3", "t4"]
            ),
            .containsCurrent(index: 3)
        )
    }

    func testRefreshDecisionDivergentWhenSnapshotLostTheLiveRow() {
        XCTAssertEqual(
            queueRefreshDecision(
                snapshotActiveId: "t9",
                engineCurrentId: "t4",
                requestedIndex: 0,
                trackCount: 4,
                snapshotTrackIds: ["t1", "t2", "t3", "t9"]
            ),
            .divergent
        )
    }

    func testRefreshDecisionDivergentWhenEngineIdle() {
        // A snapshot claiming a current track while the engine plays nothing:
        // no live row exists to find in the snapshot — reset case.
        XCTAssertEqual(
            queueRefreshDecision(
                snapshotActiveId: "t1",
                engineCurrentId: "",
                requestedIndex: 0,
                trackCount: 4,
                snapshotTrackIds: ["t1", "t2", "t3", "t4"]
            ),
            .divergent
        )
    }

    func testRefreshDecisionReanchorsToFirstDuplicateOccurrence() {
        // Duplicate ids re-anchor to the FIRST occurrence — every guard
        // compares id strings, so instance identity is not load-bearing.
        XCTAssertEqual(
            queueRefreshDecision(
                snapshotActiveId: "t1",
                engineCurrentId: "t2",
                requestedIndex: 0,
                trackCount: 4,
                snapshotTrackIds: ["t1", "t2", "t1", "t2"]
            ),
            .containsCurrent(index: 1)
        )
    }
}
