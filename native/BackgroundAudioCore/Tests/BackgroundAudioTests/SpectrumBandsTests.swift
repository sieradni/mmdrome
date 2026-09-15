import XCTest
@testable import BackgroundAudioCore

final class SpectrumBandsTests: XCTestCase {

    func testBandEdgesAreLogSpacedWithExactEndpoints() {
        let edges = SpectrumBands.bandEdges()
        XCTAssertEqual(edges.count, SpectrumBands.bandCount + 1)
        XCTAssertEqual(edges[0], SpectrumBands.minHz, accuracy: 1e-9)
        XCTAssertEqual(edges[edges.count - 1], SpectrumBands.maxHz, accuracy: 1e-6)
        for i in 1..<edges.count {
            XCTAssertGreaterThan(edges[i], edges[i - 1])
            // Constant geometric ratio (FP tolerance).
            let r0 = edges[i] / edges[i - 1]
            let r1 = edges[edges.count - 1] / edges[edges.count - 2]
            XCTAssertEqual(r0, r1, accuracy: 1e-9)
        }
        // 30 bands = 10 per decade → exact power-of-ten edges.
        let dense = SpectrumBands.bandEdges(count: 30)
        XCTAssertTrue(dense.contains { abs($0 - 200) < 1e-6 })
        XCTAssertTrue(dense.contains { abs($0 - 2000) < 1e-5 })
    }

    func testLevelNormalizationWindow() {
        // -92 dBFS (floor) → 0, -22 dBFS (ceiling) → 1, the dB-domain
        // midpoint → 0.5 (NOT the linear magnitude midpoint — dB is
        // logarithmic; the linear average of the endpoints sits at ≈0.91).
        let floorLinear = pow(10, SpectrumBands.floorDb / 20)
        let ceilLinear = pow(10, SpectrumBands.ceilDb / 20)
        XCTAssertEqual(SpectrumBands.level(linear: floorLinear), 0, accuracy: 1e-9)
        XCTAssertEqual(SpectrumBands.level(linear: ceilLinear), 1, accuracy: 1e-9)
        let midDb = (SpectrumBands.floorDb + SpectrumBands.ceilDb) / 2 // -57 dBFS
        XCTAssertEqual(SpectrumBands.level(linear: pow(10, midDb / 20)), 0.5, accuracy: 1e-9)
        XCTAssertEqual(SpectrumBands.level(linear: 0), 0, "silence/DC bin")
        XCTAssertEqual(SpectrumBands.level(linear: 5), 1, "above ceiling clamps")
    }

    func testABinFeedsEveryBandItOverlaps() {
        // Bin 3 at 2000 Hz/bin covers 6000–8000 Hz — several bands wide.
        var fft = [Double](repeating: 0, count: 16)
        fft[3] = pow(10, -50 / 20) // -50 dBFS → mid display range
        let bands = SpectrumBands.bands(from: fft, binHz: 2000)
        let edges = SpectrumBands.bandEdges()
        let expected = SpectrumBands.level(linear: fft[3])
        var fed = 0
        for i in 0..<SpectrumBands.bandCount {
            if edges[i] < 8000 && edges[i + 1] > 6000 {
                XCTAssertEqual(bands[i], expected, accuracy: 1e-12, "band \(i) overlaps the bin")
                fed += 1
            }
        }
        XCTAssertGreaterThanOrEqual(fed, 2)
        XCTAssertEqual(bands[0], 0, "far band stays silent")
    }

    func testSubBinwidthLowsInheritFromNearestCoveredBand() {
        // Coarse bins: bin 0 covers 0–100 Hz — bands under 100 Hz are
        // narrower than the bin; the lowest covered band's value carries
        // down toward 20 Hz.
        var fft = [Double](repeating: 0, count: 4)
        fft[0] = pow(10, -55 / 20)
        let bands = SpectrumBands.bands(from: fft, binHz: 100)
        let edges = SpectrumBands.bandEdges()
        let expected = SpectrumBands.level(linear: fft[0])
        var sawInherit = false
        for i in 1..<SpectrumBands.bandCount where edges[i + 1] <= 100 {
            XCTAssertEqual(bands[i], expected, accuracy: 1e-12)
            sawInherit = true
        }
        XCTAssertTrue(sawInherit)
    }

    func testEmptyAndDegenerateInputsAreSafe() {
        XCTAssertEqual(SpectrumBands.bands(from: [], binHz: 100), [Double](repeating: 0, count: 48))
        XCTAssertEqual(SpectrumBands.bands(from: [0.5, 0.5], binHz: 0), [Double](repeating: 0, count: 48))
        XCTAssertTrue(SpectrumBands.bands(from: [Double](repeating: 0, count: 8), binHz: 100)
            .allSatisfy { $0 == 0 })
    }

    func testAttackOutrunsRelease() {
        // One 16 ms frame: attack climbs well past 0.2, release barely falls.
        let up = SpectrumBands.smooth(held: [0], target: [1], dt: 0.016)[0]
        let down = SpectrumBands.smooth(held: [1], target: [0], dt: 0.016)[0]
        XCTAssertGreaterThan(up, 0.2)
        XCTAssertGreaterThan(down, 0.9)
        XCTAssertGreaterThan(up, 1 - down + 0.15, "attack clearly outruns release")
        // Convergence.
        var v = 0.0
        for _ in 0..<200 { v = SpectrumBands.smooth(held: [v], target: [1], dt: 0.016)[0] }
        XCTAssertGreaterThan(v, 0.99)
        // Degenerate dt is clamped, never divides to infinity.
        let safe = SpectrumBands.smooth(held: [0], target: [1], dt: 0)[0]
        XCTAssertTrue(safe.isFinite)
    }

    func testDisplayConstantsMatchTheWebCore() {
        // The two platforms MUST agree or the overlay reads differently per
        // platform. (mirrors SPECTRUM_* in src/lib/eq/spectrumCore.ts)
        XCTAssertEqual(SpectrumBands.bandCount, 48)
        XCTAssertEqual(SpectrumBands.minHz, 20)
        XCTAssertEqual(SpectrumBands.maxHz, 20_000)
        XCTAssertEqual(SpectrumBands.floorDb, -92)
        XCTAssertEqual(SpectrumBands.ceilDb, -22)
        XCTAssertEqual(SpectrumBands.attackS, 0.05, accuracy: 1e-9)
        XCTAssertEqual(SpectrumBands.releaseS, 0.18, accuracy: 1e-9)
    }
}
