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
}
