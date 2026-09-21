import Foundation
import XCTest
@testable import BackgroundAudioCore

final class DecodeProbeTests: XCTestCase {

    // MARK: - phase 1: transport classification

    func testHttpOkWithMediaBodyIsTransportOk() {
        let v = DecodeProbe.classifyTransport(statusCode: 200, bodyBytes: Data([0x4f, 0x67, 0x67])) // "Ogg"
        guard case .ok = v else { return XCTFail("expected .ok, got \(v)") }
    }

    func testHttpErrorIsNetworkNotUnsupported() {
        // A server error must never become a codec verdict.
        for status in [403, 404, 500, 502] {
            let v = DecodeProbe.classifyTransport(statusCode: status, bodyBytes: Data([0x7b]))
            XCTAssertEqual(v, .network)
        }
    }

    func testEmptyBodyIsNetwork() {
        XCTAssertEqual(DecodeProbe.classifyTransport(statusCode: 200, bodyBytes: Data()), .network)
    }

    func testSubsonicErrorJsonIsNetwork() {
        // The `{"subsonic-response":...}` payload is a server problem, not a
        // codec gap — the old web probe branded these 'unsupported' for
        // devices that play the format daily (the two-phase redesign's
        // whole reason to exist).
        let body = Data("{\"subsonic-response\":{\"status\":\"failed\"}}".utf8)
        XCTAssertEqual(DecodeProbe.classifyTransport(statusCode: 200, bodyBytes: body), .network)
    }

    func testLeadingWhitespaceBeforeJsonStillScreens() {
        let body = Data("\n  {\"error\"}".utf8)
        XCTAssertEqual(DecodeProbe.classifyTransport(statusCode: 200, bodyBytes: body), .network)
    }

    func testMediaBytesStartingWithOpenBracketAreNotJson() {
        // '[' screens as JSON only heuristically; a media byte at offset 0
        // that happens to be 0x5b with the rest not JSON-shaped is still
        // judged by phase 2 — the screen is a heuristic, decode is truth.
        // This pin documents the boundary: screening happens BEFORE decode,
        // a false screen costs a .network (retried), never a wrong verdict.
        let body = Data([0x5b, 0x00, 0x01, 0x02])
        // classifyTransport's screen only checks the FIRST byte, so this
        // body is screened as JSON → network. Acceptable: a retry, never a
        // false 'unsupported'.
        XCTAssertEqual(DecodeProbe.classifyTransport(statusCode: 200, bodyBytes: body), .network)
    }

    // MARK: - minimum sample size

    func testTooSmallBodyIsNetworkEvenIfTransportOk() {
        let tiny = Data([0x4f, 0x67]) // 2 bytes — no container header fits
        XCTAssertEqual(DecodeProbe.classifyTransportWithMinimum(statusCode: 200, bodyBytes: tiny), .network)
    }

    func testAdequateBodyPassesMinimum() {
        let body = Data(repeating: 0x4f, count: 4096)
        guard case .ok = DecodeProbe.classifyTransportWithMinimum(statusCode: 206, bodyBytes: body) else {
            return XCTFail("expected .ok")
        }
    }

    // MARK: - phase 2: decode classification

    func testFramesReadIsOk() {
        let v = DecodeProbe.classifyDecode(decodeError: nil, decodedFrames: 123_456)
        guard case .ok(let frames) = v else { return XCTFail("expected .ok, got \(v)") }
        XCTAssertEqual(frames, 123_456)
    }

    func testDecodeErrorIsUnsupported() {
        let v = DecodeProbe.classifyDecode(decodeError: "The file couldn't be opened", decodedFrames: 0)
        guard case .unsupported(let reason) = v else { return XCTFail("expected .unsupported, got \(v)") }
        XCTAssertEqual(reason, "The file couldn't be opened")
    }

    func testZeroFramesIsUnsupported() {
        // The loader's own store gate made this rule for downloads; the
        // probe inherits it — an openable container with no audio frames
        // proves nothing.
        let v = DecodeProbe.classifyDecode(decodeError: nil, decodedFrames: 0)
        guard case .unsupported(let reason) = v else { return XCTFail("expected .unsupported") }
        XCTAssertEqual(reason, "decoder produced 0 frames")
    }

    // MARK: - persistence rule

    func testOnlyEvidenceBackedVerdictsPersist() {
        XCTAssertTrue(DecodeProbe.probeVerdictIsPersistent(.ok(frames: 10)))
        XCTAssertTrue(DecodeProbe.probeVerdictIsPersistent(.unsupported(reason: "x")))
        XCTAssertFalse(DecodeProbe.probeVerdictIsPersistent(.network),
                       "transport failures must retry next boot, never pin a fallback")
    }
}
