import XCTest
@testable import BackgroundAudioCore

final class StreamSegmentLedgerTests: XCTestCase {
    func testQueuedSuccessorsConsumeBeforeFinalCompletion() {
        var ledger = StreamSegmentLedger()
        ledger.chain()
        ledger.chain()
        XCTAssertEqual(ledger.consume(), .segmentEnd)
        XCTAssertEqual(ledger.consume(), .segmentEnd)
        XCTAssertEqual(ledger.consume(), .trackEnd)
    }

    func testLateExtensionDoesNotSwallowItsOwnFinalCallback() {
        var ledger = StreamSegmentLedger()
        XCTAssertEqual(ledger.consume(), .trackEnd)
        XCTAssertTrue(ledger.chain(), "the already consumed predecessor needs no second callback")
        XCTAssertEqual(ledger.successors, 0)
        XCTAssertEqual(ledger.consume(), .trackEnd,
                       "even if this fires before the old deferred-end timer, it is the real end")
    }

    func testMultipleExtensionsAfterFinalConsumedKeepExactlyOneRealEnd() {
        var ledger = StreamSegmentLedger()
        XCTAssertEqual(ledger.consume(), .trackEnd)
        XCTAssertTrue(ledger.chain())
        XCTAssertFalse(ledger.chain())
        XCTAssertEqual(ledger.consume(), .segmentEnd)
        XCTAssertEqual(ledger.consume(), .trackEnd)
        ledger = StreamSegmentLedger() // a new schedule generation
        XCTAssertEqual(ledger.successors, 0)
        XCTAssertFalse(ledger.finalConsumed)
    }
}
