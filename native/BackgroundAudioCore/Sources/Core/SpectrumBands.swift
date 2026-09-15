import Foundation

/// Pure spectrum-band model (2026-09-15) — the native twin of
/// `src/lib/eq/spectrumCore.ts`. Same band ladder (48 log-spaced bands over
/// 20 Hz–20 kHz), same normalization window, same smoothing constants, so
/// both platforms render the same picture for the EQ overlay. Owns no audio
/// state: the engine hands in raw linear FFT magnitudes, this maps them to
/// per-band 0..1 display levels with attack/release smoothing.
///
/// Unit-tested in SpectrumBandsTests.swift (pure Core — ios.yml-gated, E5).

public enum SpectrumBands {

    public static let bandCount = 48
    public static let minHz: Double = 20
    public static let maxHz: Double = 20_000
    /// dB normalization window (Web AnalyserNode uses the same via
    /// min/maxDecibels + the shared TS constants).
    public static let floorDb: Double = -92
    public static let ceilDb: Double = -22
    /// Smoothing time constants, seconds — attack fast, release slow
    /// (mirrors SPECTRUM_ATTACK_S / SPECTRUM_RELEASE_S in spectrumCore.ts).
    public static let attackS: Double = 0.05
    public static let releaseS: Double = 0.18

    /// Geometric band edges: `count + 1` frequencies from minHz to maxHz.
    public static func bandEdges(count: Int = bandCount) -> [Double] {
        let lo = log10(minHz)
        let hi = log10(maxHz)
        return (0...count).map { pow(10, lo + (hi - lo) * Double($0) / Double(count)) }
    }

    /// Linear magnitude → 0..1 display level against the dB window.
    /// `linear` is an FFT magnitude (0...); it converts to dBFS first.
    public static func level(linear: Double) -> Double {
        guard linear > 0 else { return 0 }
        let db = 20 * log10(linear)
        let t = (db - floorDb) / (ceilDb - floorDb)
        return min(1, max(0, t))
    }

    /// Aggregate linear FFT magnitudes (`fftData[1...]` are the positive
    /// half-spectrum bins; `binHz` is the width of one bin) into per-band
    /// 0..1 levels. Max over overlapped bins; bands no bin reaches inherit
    /// from the nearest covered band toward the lows (sub-binwidth low
    /// bands — mirrors `mapBinsToBands` in spectrumCore.ts).
    public static func bands(from fftData: [Double], binHz: Double, count: Int = bandCount) -> [Double] {
        var out = [Double](repeating: 0, count: count)
        guard binHz > 0, !fftData.isEmpty else { return out }
        let edges = bandEdges(count: count)
        var touched = [Bool](repeating: false, count: count)

        for b in 0..<fftData.count {
            let fLo = Double(b) * binHz
            let fHi = fLo + binHz
            if fHi <= minHz { continue }
            if fLo >= maxHz { break }
            let v = level(linear: fftData[b])
            var i = 0
            while i < count && edges[i + 1] <= fLo { i += 1 }
            while i < count && edges[i] < fHi {
                if v > out[i] { out[i] = v }
                touched[i] = true
                i += 1
            }
        }

        var carry: Double? = nil
        for i in stride(from: count - 1, through: 0, by: -1) {
            if touched[i] { carry = out[i] } else if let c = carry { out[i] = c }
        }
        return out
    }

    /// One attack/release smoothing step, elementwise (held ← target).
    public static func smooth(held: [Double], target: [Double], dt: Double) -> [Double] {
        var out = [Double](repeating: 0, count: held.count)
        let clampedDt = max(dt, 0.001)
        for i in 0..<held.count {
            let t = i < target.count ? target[i] : 0
            let rate = t > held[i] ? attackS : releaseS
            let alpha = 1 - exp(-clampedDt / max(rate, 0.0001))
            out[i] = held[i] + (t - held[i]) * alpha
        }
        return out
    }
}
