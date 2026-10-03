import Foundation
import XCTest
@testable import BackgroundAudioCore

/// Pins the failure-IDENTITY core (2026-10-02e). The whole point is that the
/// vocabulary is derived from NSError domain+code, not from a localized
/// sentence: the 2026-09-23 post-mortem named `cannot parse response` as -1010,
/// but -1010 is `NSURLErrorRedirectToNonExistentLocation` (`badServerResponse`
/// is -1011) and `cannot parse response` is -1017. A test that reads the
/// CONSTANTS is the only defense against that memory error recurring.
final class TransferFailureTaxonomyTests: XCTestCase {

    // MARK: - The code → kind map

    /// Every code the taxonomy enumerates, pinned THREE ways in ONE table: the
    /// Foundation constant, its numeric value, and the Kind it maps to.
    ///
    /// The numeric pin is the 1.2.51 lesson: a wrong literal shipped in a test
    /// (`-1010` read as `badServerResponse`, when `badServerResponse` is -1011
    /// and -1010 is `redirectToNonExistentLocation`) and only CI caught it.
    /// Asserting the constants' VALUES here — against this single table's
    /// source of truth — means a comment, a doc, or another test can no longer
    /// carry a wrong number unnoticed. Keep this table the one place the
    /// vocabulary is spelled with literals; the sibling tests reference the
    /// CONSTANTS so the two can never drift.
    func testEnumeratedNSURLErrorCodes() {
        let table: [(name: String, constant: Int, value: Int, kind: TransferFailureInfo.Kind)] = [
            ("NSURLErrorCancelled", NSURLErrorCancelled, -999, .cancelled),
            ("NSURLErrorTimedOut", NSURLErrorTimedOut, -1001, .timedOut),
            ("NSURLErrorCannotFindHost", NSURLErrorCannotFindHost, -1003, .cannotFindHost),
            ("NSURLErrorCannotConnectToHost", NSURLErrorCannotConnectToHost, -1004, .cannotConnect),
            ("NSURLErrorNetworkConnectionLost", NSURLErrorNetworkConnectionLost, -1005, .connectionLost),
            ("NSURLErrorDNSLookupFailed", NSURLErrorDNSLookupFailed, -1006, .dnsLookupFailed),
            ("NSURLErrorNotConnectedToInternet", NSURLErrorNotConnectedToInternet, -1009, .notConnected),
            ("NSURLErrorBadServerResponse", NSURLErrorBadServerResponse, -1011, .badServerResponse),
            ("NSURLErrorCannotParseResponse", NSURLErrorCannotParseResponse, -1017, .cannotParseResponse),
            ("NSURLErrorSecureConnectionFailed", NSURLErrorSecureConnectionFailed, -1200, .secureConnectionFailed),
        ]
        for row in table {
            XCTAssertEqual(row.constant, row.value, "\(row.name) should be \(row.value)")
            let actual = TransferFailureInfo.classifyKind(domain: NSURLErrorDomain, code: row.constant)
            XCTAssertEqual(actual, row.kind, "\(row.name) (\(row.value)) maps to \(actual), expected \(row.kind)")
        }
        // No two enumerated codes may share a value — a duplicate would make one
        // case unreachable and silently widen another Kind.
        let values = table.map(\.value)
        XCTAssertEqual(Set(values).count, values.count, "enumerated NSURLError values must be distinct")
    }

    /// The identity correction this core exists for: `cannot parse response`
    /// is -1017 (`NSURLErrorCannotParseResponse`), NOT -1010.
    func testCannotParseResponseIsMinus1017() {
        XCTAssertEqual(NSURLErrorCannotParseResponse, -1017)
        XCTAssertNotEqual(NSURLErrorCannotParseResponse, NSURLErrorBadServerResponse)
        XCTAssertEqual(
            TransferFailureInfo.classifyKind(domain: NSURLErrorDomain, code: NSURLErrorCannotParseResponse),
            .cannotParseResponse)
        XCTAssertEqual(
            TransferFailureInfo.classifyKind(domain: NSURLErrorDomain, code: NSURLErrorBadServerResponse),
            .badServerResponse)
        // The literal -1010 is NOT badServerResponse (that is -1011): it names
        // `NSURLErrorRedirectToNonExistentLocation`, so it falls through the
        // vocabulary honestly rather than masquerading as a server rejection.
        XCTAssertNotEqual(NSURLErrorBadServerResponse, -1010)
        XCTAssertEqual(
            TransferFailureInfo.classifyKind(domain: NSURLErrorDomain, code: -1010),
            .otherTransport)
    }

    func testUnknownNSURLErrorCodeIsOtherTransport() {
        XCTAssertEqual(
            TransferFailureInfo.classifyKind(domain: NSURLErrorDomain, code: -99999),
            .otherTransport)
    }

    func testAppDomainVerdictIsNeverTransport() {
        XCTAssertEqual(
            TransferFailureInfo.classifyKind(domain: TransferFailureInfo.appDomain, code: -7001),
            .appVerdict)
    }

    func testUnknownDomainIsOther() {
        XCTAssertEqual(
            TransferFailureInfo.classifyKind(domain: "NSCocoaErrorDomain", code: 260),
            .other)
        XCTAssertEqual(
            TransferFailureInfo.classifyKind(domain: "mmdrome.something.else", code: -1),
            .other)
    }

    func testCFNetworkDomainIsTransportButOtherKind() {
        XCTAssertEqual(
            TransferFailureInfo.classifyKind(domain: TransferFailureInfo.cfNetworkDomain, code: 1),
            .otherTransport)
    }

    // MARK: - Transport classification

    func testIsTransportFailure() {
        let urlError = NSError(domain: NSURLErrorDomain, code: -1017)
        XCTAssertTrue(TransferFailureInfo.classify(urlError).isTransportFailure)
        let cf = NSError(domain: TransferFailureInfo.cfNetworkDomain, code: 12)
        XCTAssertTrue(TransferFailureInfo.classify(cf).isTransportFailure)
        let app = NSError(domain: TransferFailureInfo.appDomain, code: -7002)
        XCTAssertFalse(TransferFailureInfo.classify(app).isTransportFailure)
        let cocoa = NSError(domain: NSCocoaErrorDomain, code: 260)
        XCTAssertFalse(TransferFailureInfo.classify(cocoa).isTransportFailure)
    }

    // MARK: - Underlying cause extraction

    func testWrappedUnderlyingCodeIsSurfaced() {
        // Churn frequently arrives wrapped: a high-level URLSession error whose
        // userInfo carries the POSIX/CFNetwork cause. The INNER code is the one
        // that names the cause.
        let inner = NSError(domain: TransferFailureInfo.cfNetworkDomain, code: 57)
        let outer = NSError(
            domain: NSURLErrorDomain,
            code: NSURLErrorNetworkConnectionLost,
            userInfo: [NSUnderlyingErrorKey: inner])
        let info = TransferFailureInfo.classify(outer)
        XCTAssertEqual(info.domain, NSURLErrorDomain)
        XCTAssertEqual(info.code, NSURLErrorNetworkConnectionLost)
        XCTAssertEqual(info.kind, .connectionLost)
        XCTAssertEqual(info.underlyingDomain, TransferFailureInfo.cfNetworkDomain)
        XCTAssertEqual(info.underlyingCode, 57)
        XCTAssertTrue(info.evidenceLine.contains("under=\(TransferFailureInfo.cfNetworkDomain)(57)"))
    }

    func testUnwrappedErrorHasNoUnderlying() {
        let info = TransferFailureInfo.classify(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
        XCTAssertNil(info.underlyingDomain)
        XCTAssertNil(info.underlyingCode)
        XCTAssertFalse(info.evidenceLine.contains("under="))
    }

    // MARK: - The greppable evidence line

    func testEvidenceLineIsStableAndLocalizedTextFree() {
        let info = TransferFailureInfo.classify(NSError(domain: NSURLErrorDomain, code: -1017))
        XCTAssertEqual(info.evidenceLine, "err=NSURLErrorDomain(-1017) kind=cannotParseResponse")
    }

    func testEvidenceLineCarriesTheUnderlying() {
        let inner = NSError(domain: TransferFailureInfo.cfNetworkDomain, code: 57)
        let outer = NSError(
            domain: NSURLErrorDomain,
            code: NSURLErrorNetworkConnectionLost,
            userInfo: [NSUnderlyingErrorKey: inner])
        XCTAssertEqual(
            TransferFailureInfo.classify(outer).evidenceLine,
            "err=NSURLErrorDomain(-1005) kind=connectionLost under=\(TransferFailureInfo.cfNetworkDomain)(57)")
    }

    func testClassifyNeverInspectsLocalizedText() {
        // A deliberately misleading localizedDescription must not change the
        // verdict — the identity is domain+code alone.
        let liar = NSError(
            domain: NSURLErrorDomain,
            code: NSURLErrorTimedOut,
            userInfo: [NSLocalizedDescriptionKey: "cannot parse response"])
        XCTAssertEqual(TransferFailureInfo.classify(liar).kind, .timedOut)
    }
}
