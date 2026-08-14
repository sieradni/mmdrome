import Foundation

/// Snaps a pitch (in octaves) to the nearest semitone when it falls within a
/// tolerance measured in semitones. `toleranceSemitones` ∈ [0, 0.5]: 0 disables
/// snapping, 0.5 snaps every value (max distance to a semitone is half a
/// semitone). Values outside that range are clamped defensively.
///
/// Mirrors the Web Audio implementation exactly
/// (src/lib/playbackCore/pitchSnap.ts) so both engines land on the same
/// semitone grid.
public func snapPitchToSemitone(octaves: Double, toleranceSemitones: Double) -> Double {
    let tolerance = min(0.5, max(0, toleranceSemitones))
    // `.rounded()` defaults to `.toNearestOrAwayFromZero` — the TypeScript twin
    // must round half away from zero too (`Math.round` alone rounds toward +∞
    // for negative halves and would diverge here).
    let nearest = (octaves * 12).rounded() / 12
    let distance = abs(octaves - nearest) * 12
    return distance <= tolerance ? nearest : octaves
}
