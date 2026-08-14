/**
 * Snaps a pitch (in octaves) to the nearest semitone when it falls within a
 * tolerance measured in semitones. `toleranceSemitones` ∈ [0, 0.5]: 0 disables
 * snapping, 0.5 snaps every value (max distance to a semitone is half a
 * semitone). Values outside that range are clamped defensively so a caller can
 * never pass a tolerance that silently disables snapping or over-snaps.
 *
 * Both the Web Audio engine and the native AVAudioEngine apply this exact
 * function, so a pitch set in one backend lands on the same semitone grid as
 * the other (see native/BackgroundAudioCore/Sources/Core/PitchSnap.swift).
 */
export function snapPitchToSemitone(octaves: number, toleranceSemitones: number): number {
  const tolerance = Math.min(0.5, Math.max(0, toleranceSemitones))
  const semitones = octaves * 12
  // Round half AWAY FROM ZERO — `Math.round` rounds half toward +∞, which would
  // diverge from Swift's `Double.rounded()` (`.toNearestOrAwayFromZero`) at a
  // negative half-semitone (e.g. -0.5 → 0 here, -1 in Swift).
  const nearestSemitones = semitones < 0 ? -Math.round(-semitones) : Math.round(semitones)
  const nearest = nearestSemitones / 12
  const distance = Math.abs(octaves - nearest) * 12
  return distance <= tolerance ? nearest : octaves
}
