import XCTest
@testable import BackgroundAudioCore

/// Pins the sequential-prefetch dedupe-set contract (2026-10-02). The engine's
/// retry re-enters the walk from the parent row and re-derives the failed row,
/// so it MUST pass the pre-insert set; the post-insert set trips the
/// already-seen guard and silently kills the retry — the "preload stops on the
/// 3rd upcoming" field report. `PrefetchChain.step` hands back both snapshots
/// from one decision so the walk-on/retry split cannot be confused.
final class PrefetchChainTests: XCTestCase {

    func testStepReturnsPreInsertSetForRetry() {
        let step = PrefetchChain.step(seen: Set([1, 2]), next: 3)
        XCTAssertEqual(step?.retrySet, Set([1, 2]))       // does NOT contain the row
        XCTAssertEqual(step?.advancedSet, Set([1, 2, 3])) // contains the row
    }

    func testStepRejectsAlreadySeenRow() {
        XCTAssertNil(PrefetchChain.step(seen: Set([1, 2, 3]), next: 3))
    }

    /// The regression itself: re-entering with the RETRY set must re-attempt
    /// the row, and re-entering with the ADVANCED set must stop.
    func testRetrySetReAttemptsTheRowWhileAdvancedSetStops() {
        let step = PrefetchChain.step(seen: Set([1, 2]), next: 3)
        XCTAssertNotNil(PrefetchChain.step(seen: step!.retrySet, next: 3))
        XCTAssertNil(PrefetchChain.step(seen: step!.advancedSet, next: 3))
    }

    /// A failed row that exhausted its retries is marked seen so a loop-all
    /// wrap never revisits it.
    func testAdvancedSetExcludesTheFailedRowFromLaterRevisits() {
        let step = PrefetchChain.step(seen: Set<Int>(), next: 0)
        XCTAssertFalse(step!.advancedSet.isEmpty)
        XCTAssertNil(PrefetchChain.step(seen: step!.advancedSet, next: 0))
    }

    // MARK: - Park-and-drain planner (Phase 3, 2026-10-02)

    func testNextActionDownloadsAnUnseenWalkCandidate() {
        let state = PrefetchChain.State(seen: Set([0]), parked: [])
        XCTAssertEqual(
            PrefetchChain.nextAction(state: state, totalCount: 3, maxAttempts: 3, walkCandidate: 1),
            .download(index: 1))
    }

    func testNextActionFinishesWhenWalkFullAndNothingParked() {
        let state = PrefetchChain.State(seen: Set([0, 1, 2]), parked: [])
        XCTAssertEqual(
            PrefetchChain.nextAction(state: state, totalCount: 3, maxAttempts: 3, walkCandidate: 3),
            .finished)
    }

    func testNextActionRetriesParkedRowWhenWalkExhausted() {
        let state = PrefetchChain.State(seen: Set([0, 1]), parked: [.init(index: 1, attempts: 1)])
        XCTAssertEqual(
            PrefetchChain.nextAction(state: state, totalCount: 2, maxAttempts: 3, walkCandidate: 2),
            .retry(index: 1, attempt: 2))
    }

    func testNextActionStopsRetryingAParkedRowAtTheAttemptCap() {
        let state = PrefetchChain.State(seen: Set([0]), parked: [.init(index: 0, attempts: 3)])
        XCTAssertEqual(
            PrefetchChain.nextAction(state: state, totalCount: 1, maxAttempts: 3, walkCandidate: nil),
            .finished)
    }

    func testApplyDownloadSuccessMarksSeenWithoutParking() {
        let next = PrefetchChain.applyDownload(
            state: PrefetchChain.State(seen: [], parked: []), index: 4, success: true, maxAttempts: 3)
        XCTAssertEqual(next.seen, Set([4]))
        XCTAssertTrue(next.parked.isEmpty)
    }

    func testApplyDownloadFailureParksTheRow() {
        let next = PrefetchChain.applyDownload(
            state: PrefetchChain.State(seen: [4], parked: []), index: 5, success: false, maxAttempts: 3)
        XCTAssertEqual(next.seen, Set([4, 5]))
        XCTAssertEqual(next.parked, [.init(index: 5, attempts: 1)])
    }

    func testApplyDownloadFailureWithRetriesDisabledDoesNotPark() {
        let next = PrefetchChain.applyDownload(
            state: PrefetchChain.State(seen: [], parked: []), index: 0, success: false, maxAttempts: 1)
        XCTAssertEqual(next.seen, Set([0]))
        XCTAssertTrue(next.parked.isEmpty)
    }

    func testApplyRetrySuccessDropsTheRow() {
        let next = PrefetchChain.applyRetry(
            state: PrefetchChain.State(seen: Set([0]), parked: [.init(index: 0, attempts: 1)]),
            index: 0, attempt: 2, success: true, maxAttempts: 3)
        XCTAssertTrue(next.parked.isEmpty)
    }

    func testApplyRetryFailureRotatesTheRowToTheBackWithTheSpentAttempt() {
        let start = PrefetchChain.State(
            seen: Set([0, 1, 2]),
            parked: [.init(index: 0, attempts: 1), .init(index: 1, attempts: 1)])
        let next = PrefetchChain.applyRetry(state: start, index: 0, attempt: 2, success: false, maxAttempts: 4)
        XCTAssertEqual(next.parked, [.init(index: 1, attempts: 1), .init(index: 0, attempts: 2)])
    }

    func testApplyRetryFailureAtTheAttemptCapDropsTheRow() {
        let next = PrefetchChain.applyRetry(
            state: PrefetchChain.State(seen: Set([0]), parked: [.init(index: 0, attempts: 2)]),
            index: 0, attempt: 3, success: false, maxAttempts: 3)
        XCTAssertTrue(next.parked.isEmpty)
    }

    /// The Phase 3 headline: a poisoning row no longer blocks the rows behind
    /// it — the walk reaches the window end BEFORE the first retry, then drains.
    func testPoisoningRowIsParkedAndTheWalkCompletesFirst() {
        // totalCount 3 over rows 0..3; row 1 always fails. maxAttempts 2.
        var state = PrefetchChain.State()
        var cursor = -1
        var log: [PrefetchChain.Action] = []
        for _ in 0..<20 {
            let candidate = cursor + 1 < 4 ? cursor + 1 : nil
            let action = PrefetchChain.nextAction(
                state: state, totalCount: 3, maxAttempts: 2, walkCandidate: candidate)
            log.append(action)
            switch action {
            case .finished:
                break // loop breaks just below; the switch needs the case
            case .download(let row):
                cursor = row
                state = PrefetchChain.applyDownload(
                    state: state, index: row, success: row != 1, maxAttempts: 2)
            case .retry(let row, let attempt):
                state = PrefetchChain.applyRetry(
                    state: state, index: row, attempt: attempt, success: false, maxAttempts: 2)
            }
            if case .finished = action { break }
        }
        XCTAssertEqual(log, [
            .download(index: 0),
            .download(index: 1), // fails → parked, walk advances immediately
            .download(index: 2),
            .retry(index: 1, attempt: 2),
            .finished,
        ])
    }

    /// Two parked rows rotate: after the first fails again it goes to the back,
    /// so the second is retried before it.
    func testDrainRotatesParkedRows() {
        var state = PrefetchChain.State(
            seen: Set([0, 1, 2, 3]),
            parked: [.init(index: 9, attempts: 1), .init(index: 8, attempts: 1)])
        XCTAssertEqual(
            PrefetchChain.nextAction(state: state, totalCount: 4, maxAttempts: 3, walkCandidate: nil),
            .retry(index: 9, attempt: 2))
        state = PrefetchChain.applyRetry(state: state, index: 9, attempt: 2, success: false, maxAttempts: 3)
        XCTAssertEqual(
            PrefetchChain.nextAction(state: state, totalCount: 4, maxAttempts: 3, walkCandidate: nil),
            .retry(index: 8, attempt: 2), "the failed row rotated behind row 8")
        state = PrefetchChain.applyRetry(state: state, index: 8, attempt: 2, success: true, maxAttempts: 3)
        XCTAssertEqual(
            PrefetchChain.nextAction(state: state, totalCount: 4, maxAttempts: 3, walkCandidate: nil),
            .retry(index: 9, attempt: 3))
        state = PrefetchChain.applyRetry(state: state, index: 9, attempt: 3, success: false, maxAttempts: 3)
        XCTAssertEqual(
            PrefetchChain.nextAction(state: state, totalCount: 4, maxAttempts: 3, walkCandidate: nil),
            .finished)
    }
}
