import Foundation
import XCTest
@testable import BackgroundAudioCore

/// Pins for the transfer-ladder hold (2026-10-07, Phase 2 follow-up).
///
/// The load-bearing invariants: every user-initiated transfer holds the
/// speculative walk (exhaustively, so a new flag cannot be forgotten), a SEEK
/// EPOCH holds it through its own state — never through `hasActiveWriter`
/// happening to include epoch writers (the incidental coupling this test
/// exists to prevent from regressing), and `ownsBandwidth` is the single
/// derivation the network re-arm reads.
final class TransferLadderTests: XCTestCase {

    /// The exhaustive truth table: hold ⟺ at least one user-transfer flag.
    func testEveryUserTransferHoldsTheWalk() {
        var held = 0
        for bits in 0..<16 {
            let t = TransferLadder.UserTransfer(
                stagedActive: bits & 1 != 0,
                writerLive: bits & 2 != 0,
                epochOpen: bits & 4 != 0,
                activeLoadInFlight: bits & 8 != 0)
            let any = bits != 0
            XCTAssertEqual(TransferLadder.ownsBandwidth(t), any, "bits=\(bits)")
            XCTAssertEqual(TransferLadder.mayIssueNextPrefetch(t), !any, "bits=\(bits)")
            XCTAssertEqual(TransferLadder.hold(t) == .none, !any, "bits=\(bits)")
            if any { held += 1 }
        }
        XCTAssertEqual(held, 15)
    }

    func testIdleAllowsTheWalk() {
        let idle = TransferLadder.UserTransfer()
        XCTAssertFalse(TransferLadder.ownsBandwidth(idle))
        XCTAssertTrue(TransferLadder.mayIssueNextPrefetch(idle))
        XCTAssertEqual(TransferLadder.hold(idle), .none)
    }

    /// THE hardening pin (2026-10-07 review): an epoch BEFORE its writer is
    /// visible must still hold. The old network re-arm asked
    /// `stagedSchedule == nil, !hasActiveWriter`, which covered the epoch only
    /// because ephemeral epoch writers happen to count as active writers — a
    /// refactor excluding them would have started a prefetch mid-epoch, or,
    /// worse, into the pre-first-delivery window the user is waiting on.
    func testAnEpochAloneHoldsTheWalkWithoutTheWriterFlag() {
        let epochOnly = TransferLadder.UserTransfer(epochOpen: true)
        XCTAssertTrue(TransferLadder.ownsBandwidth(epochOnly))
        XCTAssertFalse(TransferLadder.mayIssueNextPrefetch(epochOnly))
        XCTAssertEqual(TransferLadder.hold(epochOnly), .seekEpoch)
    }

    func testTheActiveRowsOwnDownloadHoldsTheWalk() {
        let load = TransferLadder.UserTransfer(activeLoadInFlight: true)
        XCTAssertTrue(TransferLadder.ownsBandwidth(load))
        XCTAssertEqual(TransferLadder.hold(load), .activeLoad)
        // A row writer and a staged schedule are the same lane for the label:
        // the stream owns the bandwidth either way.
        XCTAssertEqual(TransferLadder.hold(TransferLadder.UserTransfer(writerLive: true)), .stagedStream)
        XCTAssertEqual(TransferLadder.hold(TransferLadder.UserTransfer(stagedActive: true)), .stagedStream)
    }

    /// The label is precedence, not permission: an epoch outranks a staged
    /// stream's label because it is the narrower, more user-visible transfer,
    /// and both hold identically.
    func testHoldLabelsFollowPrecedenceWhileAllHold() {
        let all = TransferLadder.UserTransfer(
            stagedActive: true, writerLive: true, epochOpen: true, activeLoadInFlight: true)
        XCTAssertEqual(TransferLadder.hold(all), .seekEpoch)
        XCTAssertEqual(
            TransferLadder.hold(TransferLadder.UserTransfer(
                stagedActive: true, writerLive: false, epochOpen: false, activeLoadInFlight: true)),
            .stagedStream)
    }
}
