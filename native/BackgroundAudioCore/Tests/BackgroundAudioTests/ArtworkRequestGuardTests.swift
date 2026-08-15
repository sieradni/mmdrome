import Foundation
import XCTest
@testable import BackgroundAudioCore

final class ArtworkRequestGuardTests: XCTestCase {

    func testCompletionForLatestRequestApplies() {
        var guard_ = ArtworkRequestGuard()
        guard_.request("A")
        XCTAssertTrue(guard_.shouldApply(completedTrackId: "A", currentTrackId: "A"))
    }

    func testSupersededCompletionIsDropped() {
        // Out-of-order: request A, then B; A's fetch lands last.
        var guard_ = ArtworkRequestGuard()
        guard_.request("A")
        guard_.request("B")
        XCTAssertFalse(guard_.shouldApply(completedTrackId: "A", currentTrackId: "B"))
        XCTAssertTrue(guard_.shouldApply(completedTrackId: "B", currentTrackId: "B"))
    }

    func testCurrentTrackChangeWithoutNewRequestIsDropped() {
        // Track moved to one with no cover — no new request supersedes A, but
        // A's completion must not stamp art over the new track.
        var guard_ = ArtworkRequestGuard()
        guard_.request("A")
        XCTAssertFalse(guard_.shouldApply(completedTrackId: "A", currentTrackId: "B"))
    }

    func testReRequestOfSameTrackStillApplies() {
        var guard_ = ArtworkRequestGuard()
        guard_.request("A")
        guard_.request("A")
        XCTAssertTrue(guard_.shouldApply(completedTrackId: "A", currentTrackId: "A"))
    }

    func testNothingAppliesBeforeAnyRequest() {
        let guard_ = ArtworkRequestGuard()
        XCTAssertFalse(guard_.shouldApply(completedTrackId: "A", currentTrackId: "A"))
    }

    func testRequestAndCompletionOrderingMatrix() {
        // request/completion ordering × current-trackId, as specified in TODO 4.4.
        var guard_ = ArtworkRequestGuard()

        // request A → complete A (current A): apply
        guard_.request("A")
        XCTAssertTrue(guard_.shouldApply(completedTrackId: "A", currentTrackId: "A"))

        // request B → complete A (current B): stale completion, dropped
        guard_.request("B")
        XCTAssertFalse(guard_.shouldApply(completedTrackId: "A", currentTrackId: "B"))

        // complete B (current B): apply
        XCTAssertTrue(guard_.shouldApply(completedTrackId: "B", currentTrackId: "B"))

        // track change to C without a request → complete B (current C): dropped
        XCTAssertFalse(guard_.shouldApply(completedTrackId: "B", currentTrackId: "C"))
    }
}
