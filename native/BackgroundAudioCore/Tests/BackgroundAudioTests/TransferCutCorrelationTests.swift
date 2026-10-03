import Foundation
import XCTest
@testable import BackgroundAudioCore

/// Pins the churn-vs-keep-alive discriminator (2026-10-02e). The attribution
/// is a convenience LABEL over the raw numbers; the boundary and the
/// direction guard are what the field dumps depend on, so they are pinned
/// here rather than trusted to the header prose.
final class TransferCutCorrelationTests: XCTestCase {

    private func transportFailure() -> TransferFailureInfo {
        TransferFailureInfo.classify(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotParseResponse))
    }

    private func appVerdict() -> TransferFailureInfo {
        TransferFailureInfo.classify(NSError(domain: TransferFailureInfo.appDomain, code: -7001))
    }

    // MARK: - The three verdicts

    func testNoTransitionReportedIsChurnUnlikely() {
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: transportFailure(), lastNetworkChangeAt: nil, cutAt: 100),
            .churnUnlikely)
    }

    func testTransitionInsideTheWindowIsChurnSuspected() {
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: transportFailure(), lastNetworkChangeAt: 98, cutAt: 100),
            .churnSuspected)
    }

    func testTransitionOutsideTheWindowIsChurnUnlikely() {
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: transportFailure(), lastNetworkChangeAt: 90, cutAt: 100),
            .churnUnlikely)
    }

    func testAppVerdictIsNotTransport() {
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: appVerdict(), lastNetworkChangeAt: 99.9, cutAt: 100),
            .notTransport)
    }

    // MARK: - Window boundary

    func testWindowBoundaryIsInclusive() {
        // defaultWindowSeconds = 5.0; exactly at the boundary counts.
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: transportFailure(), lastNetworkChangeAt: 95, cutAt: 100),
            .churnSuspected, "exactly at the window boundary is inside")
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: transportFailure(), lastNetworkChangeAt: 94.9, cutAt: 100),
            .churnUnlikely, "just outside the window")
    }

    func testCustomWindowIsHonored() {
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: transportFailure(), lastNetworkChangeAt: 96, cutAt: 100, windowSeconds: 2),
            .churnUnlikely)
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: transportFailure(), lastNetworkChangeAt: 98, cutAt: 100, windowSeconds: 2),
            .churnSuspected)
    }

    // MARK: - Direction guard

    func testTransitionAfterTheCutIsNeverCredited() {
        // A transition stamped AFTER the cut (clock skew, or a path change
        // racing the failure) must not explain the cut.
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: transportFailure(), lastNetworkChangeAt: 100.5, cutAt: 100),
            .churnUnlikely)
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: transportFailure(), lastNetworkChangeAt: 101, cutAt: 100),
            .churnUnlikely)
    }

    func testTransitionAtTheExactCutTimeCounts() {
        XCTAssertEqual(
            TransferCutCorrelation.attribute(failure: transportFailure(), lastNetworkChangeAt: 100, cutAt: 100),
            .churnSuspected)
    }

    // MARK: - Evidence lines

    func testChurnSuspectedLineCarriesTheOffset() {
        let line = TransferCutCorrelation.evidenceLine(
            failure: transportFailure(), lastNetworkChangeAt: 97.5, cutAt: 100)
        XCTAssertEqual(line, "cut=churnSuspected (network transition 2.5s before the cut)")
    }

    func testChurnUnlikelyLineNamesTheWindowAndTheLastTransition() {
        let line = TransferCutCorrelation.evidenceLine(
            failure: transportFailure(), lastNetworkChangeAt: 50, cutAt: 100)
        XCTAssertEqual(line, "cut=churnUnlikely (no transition within 5.0s; last was 50.0s earlier)")
    }

    func testChurnUnlikelyWithoutEverSeeingATransition() {
        let line = TransferCutCorrelation.evidenceLine(
            failure: transportFailure(), lastNetworkChangeAt: nil, cutAt: 100)
        XCTAssertEqual(line, "cut=churnUnlikely (no network transition reported this session)")
    }

    func testNotTransportLine() {
        let line = TransferCutCorrelation.evidenceLine(
            failure: appVerdict(), lastNetworkChangeAt: 99, cutAt: 100)
        XCTAssertEqual(line, "cut=notTransport (app-side verdict — bytes, not transport)")
    }

    func testNegativeDeltasAreClampedInTheLine() {
        // The direction guard already refuses the verdict; the line must not
        // print a negative duration either.
        let line = TransferCutCorrelation.evidenceLine(
            failure: transportFailure(), lastNetworkChangeAt: 101, cutAt: 100)
        XCTAssertFalse(line.contains("-"), "no negative duration leaks into the line: \(line)")
    }

    func testDefaultWindowIsFiveSeconds() {
        XCTAssertEqual(TransferCutCorrelation.defaultWindowSeconds, 5.0)
    }
}
