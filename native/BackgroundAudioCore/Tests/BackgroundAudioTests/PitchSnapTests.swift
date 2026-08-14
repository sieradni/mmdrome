import Foundation
import XCTest
@testable import BackgroundAudioCore

final class PitchSnapTests: XCTestCase {

    func testZeroToleranceNeverSnaps() {
        XCTAssertEqual(snapPitchToSemitone(octaves: 0.05, toleranceSemitones: 0), 0.05)
    }

    func testHalfSemitoneToleranceSnapsEverything() {
        XCTAssertEqual(snapPitchToSemitone(octaves: 0.001, toleranceSemitones: 0.5), 0)
        XCTAssertEqual(snapPitchToSemitone(octaves: 0.06, toleranceSemitones: 0.5), 1.0 / 12.0)
        XCTAssertEqual(snapPitchToSemitone(octaves: 1.001, toleranceSemitones: 0.5), 1)
    }

    func testSnapsWithinToleranceLeavesOutsideAlone() {
        // 0.2 oct = 2.4 semitones → 0.4 semitone from the nearest semitone (2).
        XCTAssertEqual(snapPitchToSemitone(octaves: 0.2, toleranceSemitones: 0.5), 2.0 / 12.0)
        XCTAssertEqual(snapPitchToSemitone(octaves: 0.2, toleranceSemitones: 0.1), 0.2)
    }

    func testExactSemitonesAreUnchanged() {
        XCTAssertEqual(snapPitchToSemitone(octaves: 0, toleranceSemitones: 0.15), 0)
        XCTAssertEqual(snapPitchToSemitone(octaves: 1.0 / 12.0, toleranceSemitones: 0.15), 1.0 / 12.0)
        XCTAssertEqual(snapPitchToSemitone(octaves: 1, toleranceSemitones: 0.15), 1)
        XCTAssertEqual(snapPitchToSemitone(octaves: -2, toleranceSemitones: 0.15), -2)
    }

    func testToleranceIsClamped() {
        XCTAssertEqual(snapPitchToSemitone(octaves: 0.05, toleranceSemitones: -1), 0.05)
        XCTAssertEqual(snapPitchToSemitone(octaves: 0.06, toleranceSemitones: 99), 1.0 / 12.0)
    }

    func testHalfSemitoneRoundsAwayFromZero() {
        // Exact half-semitone tie must resolve away from zero, matching the
        // TypeScript twin (0.5/12 is exactly half a semitone in Double).
        XCTAssertEqual(snapPitchToSemitone(octaves: 0.5 / 12.0, toleranceSemitones: 0.5), 1.0 / 12.0)
        XCTAssertEqual(snapPitchToSemitone(octaves: -0.5 / 12.0, toleranceSemitones: 0.5), -1.0 / 12.0)
    }
}
