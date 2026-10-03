import Foundation
import XCTest
@testable import BackgroundAudioCore

/// Pins the rolling branch counter (2026-10-02g). The counter's whole job is
/// to be trustworthy in a field dump, so the window bound, the decision /
/// enactment split and the payload shape are all pinned.
final class TransferRetryBranchStatsTests: XCTestCase {

    func testCountsEachStrategySeparately() {
        var s = TransferRetryBranchStats()
        s.record(strategy: .freshConnectionSoon)
        s.record(strategy: .resumeAfterBackoff)
        s.record(strategy: .freshConnectionSoon)
        s.record(strategy: .standard)
        XCTAssertEqual(s.scheduled, 4)
        XCTAssertEqual(s.freshConnectionSoon, 2)
        XCTAssertEqual(s.resumeAfterBackoff, 1)
        XCTAssertEqual(s.standard, 1)
        XCTAssertEqual(s.recent, ["freshConnectionSoon", "resumeAfterBackoff", "freshConnectionSoon", "standard"])
    }

    func testEmptyStatsReadHonestly() {
        let s = TransferRetryBranchStats()
        XCTAssertEqual(s.scheduled, 0)
        XCTAssertEqual(s.recent, [])
        // An empty window must not print a bogus token.
        XCTAssertTrue(s.summaryLine(enactedFreshConnection: 0).contains("recent —"))
    }

    func testRecentWindowIsBoundedNewestLast() {
        var s = TransferRetryBranchStats()
        for i in 0..<(TransferRetryBranchStats.recentWindow + 5) {
            s.record(strategy: i.isMultiple(of: 2) ? .freshConnectionSoon : .resumeAfterBackoff)
        }
        XCTAssertEqual(s.recent.count, TransferRetryBranchStats.recentWindow)
        XCTAssertEqual(s.scheduled, TransferRetryBranchStats.recentWindow + 5, "totals are session-wide")
        // The window keeps the NEWEST entries: the 25th decision (index 24,
        // even → fresh) is the last element, and the first five were dropped
        // — so the oldest RETAINED decision is index 5 (odd → resume).
        XCTAssertEqual(s.recent.last, "freshConnectionSoon")
        XCTAssertEqual(s.recent.first, "resumeAfterBackoff")
    }

    func testTheWindowDropsTheOldest() {
        var s = TransferRetryBranchStats()
        s.record(strategy: .standard)
        for _ in 0..<TransferRetryBranchStats.recentWindow {
            s.record(strategy: .resumeAfterBackoff)
        }
        XCTAssertFalse(s.recent.contains("standard"), "the oldest decision rolled out")
        XCTAssertEqual(s.standard, 1, "the total keeps it")
        XCTAssertEqual(s.recent.count, TransferRetryBranchStats.recentWindow)
    }

    func testDecisionAndEnactmentAreSeparateNumbers() {
        // The gap is real and by design: an opaque-resumeData retry keeps the
        // shared session, so a fresh decision may not become an enactment.
        let s = TransferRetryBranchStats()
        XCTAssertEqual(s.snapshot(enactedFreshConnection: 3)["freshConnectionEnacted"] as? Int, 3)
        XCTAssertEqual(s.snapshot(enactedFreshConnection: 3)["freshConnectionSoon"] as? Int, 0)
    }

    func testSnapshotCarriesEveryFieldAndTheSummary() {
        var s = TransferRetryBranchStats()
        s.record(strategy: .freshConnectionSoon)
        let snap = s.snapshot(enactedFreshConnection: 1)
        XCTAssertEqual(snap["scheduled"] as? Int, 1)
        XCTAssertEqual(snap["freshConnectionSoon"] as? Int, 1)
        XCTAssertEqual(snap["resumeAfterBackoff"] as? Int, 0)
        XCTAssertEqual(snap["standard"] as? Int, 0)
        XCTAssertEqual(snap["freshConnectionEnacted"] as? Int, 1)
        XCTAssertEqual(snap["recent"] as? [String], ["freshConnectionSoon"])
        XCTAssertEqual(snap["summary"] as? String, s.summaryLine(enactedFreshConnection: 1))
    }

    func testSummaryLineSpellsTheRollingWindowCompactly() {
        var s = TransferRetryBranchStats()
        s.record(strategy: .freshConnectionSoon)
        s.record(strategy: .resumeAfterBackoff)
        s.record(strategy: .standard)
        XCTAssertEqual(
            s.summaryLine(enactedFreshConnection: 1),
            "retry: 3 decided (fresh 1, resume 1, standard 1) · fresh enacted 1 · recent fresh,resume,std")
    }

    func testShortLabelsCoverTheVocabulary() {
        XCTAssertEqual(TransferRetryBranchStats.shortLabel("freshConnectionSoon"), "fresh")
        XCTAssertEqual(TransferRetryBranchStats.shortLabel("resumeAfterBackoff"), "resume")
        XCTAssertEqual(TransferRetryBranchStats.shortLabel("standard"), "std")
        // An unknown raw value (a future strategy) degrades to `std` in the
        // compact view but is kept VERBATIM in `recent` for grepping.
        XCTAssertEqual(TransferRetryBranchStats.shortLabel("somethingNew"), "std")
    }

    func testResetStartsAFreshObservationWindow() {
        var s = TransferRetryBranchStats()
        s.record(strategy: .freshConnectionSoon)
        s.record(strategy: .resumeAfterBackoff)
        s.record(strategy: .standard)
        s.reset()
        XCTAssertEqual(s.scheduled, 0, "totals are discarded, not decayed")
        XCTAssertEqual(s.freshConnectionSoon, 0)
        XCTAssertEqual(s.resumeAfterBackoff, 0)
        XCTAssertEqual(s.standard, 0)
        XCTAssertEqual(s.recent, [], "the rolling window is cleared too")
        // An emptied counter must read exactly like a fresh one — the HUD's
        // empty state and the dump both key on this.
        XCTAssertEqual(s, TransferRetryBranchStats())
        XCTAssertTrue(s.summaryLine(enactedFreshConnection: 0).contains("recent —"))
    }

    func testResetDoesNotAffectAFutureWindow() {
        var s = TransferRetryBranchStats()
        s.record(strategy: .standard)
        s.reset()
        s.record(strategy: .freshConnectionSoon)
        XCTAssertEqual(s.scheduled, 1)
        XCTAssertEqual(s.freshConnectionSoon, 1)
        XCTAssertEqual(s.standard, 0, "the pre-reset decision stays gone")
        XCTAssertEqual(s.recent, ["freshConnectionSoon"])
    }

    func testRecordingIsPureAndAccumulates() {
        var s = TransferRetryBranchStats()
        let before = s
        s.record(strategy: .standard)
        XCTAssertNotEqual(s, before)
        XCTAssertEqual(before.scheduled, 0, "the previous value is untouched")
    }
}
