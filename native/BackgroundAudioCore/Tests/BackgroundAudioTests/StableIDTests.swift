import Foundation
import XCTest
@testable import BackgroundAudioCore

final class StableIDTests: XCTestCase {

    func testKnownTestVectors() {
        // FNV-1a 64-bit reference vectors — pin against drift.
        XCTAssertEqual(StableID.fnv1a64(""), 0xcbf29ce484222325)
        XCTAssertEqual(StableID.fnv1a64("a"), 0xaf63dc4c8601ec8c)
    }

    func testDeterministicAcrossCalls() {
        let id = "1234-5678-9abc-def0"
        XCTAssertEqual(StableID.fnv1a64(id), StableID.fnv1a64(id))
    }

    func testDifferentIdsDiffer() {
        XCTAssertNotEqual(StableID.fnv1a64("track-a"), StableID.fnv1a64("track-b"))
        // Case-sensitive — "Track-a" and "track-a" are distinct server ids.
        XCTAssertNotEqual(StableID.fnv1a64("Track-a"), StableID.fnv1a64("track-a"))
        // Collision-adjacent ids must not collapse (prefix/suffix differences).
        XCTAssertNotEqual(StableID.fnv1a64("abc"), StableID.fnv1a64("abcd"))
    }

    func testNeverTrapsOnExtremeInputs() {
        // Old code did abs(trackId.hashValue) — abs(Int.min) traps. UInt64 FNV
        // has no such edge; exercise long and empty inputs for completeness.
        _ = StableID.fnv1a64("")
        _ = StableID.fnv1a64(String(repeating: "x", count: 10_000))
        XCTAssertEqual(StableID.fnv1a64(String(repeating: "x", count: 10_000)),
                       StableID.fnv1a64(String(repeating: "x", count: 10_000)))
    }

    func testUnicodeIdsAreStable() {
        // CJK ids (byte-level hashing over UTF-8) must be deterministic too.
        let id = "曲名-01"
        XCTAssertEqual(StableID.fnv1a64(id), StableID.fnv1a64(id))
    }
}
