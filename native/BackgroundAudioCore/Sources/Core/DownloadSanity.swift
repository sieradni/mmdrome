import Foundation

/// Pure download-sanity decisions for the native track-file loader.
///
/// The 2026-09-17 multi-skip fix validated TRANSFER completeness (body size,
/// 0-frame rejection) but NOT byte-adequacy: audio containers (FLAC, MP4,
/// MPEG) keep their declared duration in the HEADER, so a download truncated
/// mid-body still opens as a "full-length" AVAudioFile. It then reaches EOF
/// minutes early — the user hears the track play halfway and the engine
/// chains the next rows while the next downloads are still in flight: the
/// 2026-09-18 LDM multi-skip (engine-side trackChanged 3–5 rows ~50–100 ms
/// apart, bridge trail shows no JS cmd between them). The missing signal was
/// the server's Content-Length: a completed transfer whose byte count falls
/// far short of the announced length is poison even though error == nil.
///
/// These gates live in Core so the truncation matrix is unit-tested; the
/// loader/engine are thin adapters (design rule F2).
public enum DownloadSanity {

    /// Rejects a completed transfer whose byte count is materially short of
    /// the server's announced Content-Length. The 10 % margin (NOT 0) absorbs
    /// servers that send `Content-Length` only when they know the exact size
    /// and early header tweaks; requiring an EXACT match would false-reject
    /// legitimate streams. A missing/zero announced length is always OK —
    /// chunked servers have no length to lie about.
    public static func isTruncatedAgainstServer(storedBytes: Int, serverLength: Int64) -> Bool {
        guard serverLength > 0 else { return false }
        return Double(storedBytes) < 0.9 * Double(serverLength)
        // The multiplier form (not storedBytes < serverLength - slack) so the
        // gate scales from small podcast files to 80 MB FLACs.
    }

    /// Minimum seconds of audio the stored byte count could possibly contain:
    /// byteCount / (the source's worst-case bytes-per-second), capped by the
    /// declared duration. Derived from the SAMPLE RATE of the probed file and
    /// the container's worst-case frame size — no bitrate metadata needed, so
    /// it works for any format (FLAC blocks, MPEG frames, MP4 packets).
    /// minimumBytesPerSecond sample rates (Hz); "worst case" = LOWEST rate
    /// (fewest samples per byte ⇒ fewest seconds per byte). 8000 Hz @ mono
    /// 8-bit is the smallest sane CD-era floor; WAV uses the lossless floor
    /// because a .wav extension byte-fails the AVAudioFile probe when the
    /// bytes are compressed audio.
    public static func minimumBytesPerSecond(sampleRateHz: Double, fileExtension: String?) -> Double {
        let rate = sampleRateHz > 0 ? sampleRateHz : 44_100
        let losslessFloor = rate * 1.0 // 16-bit mono
        switch (fileExtension ?? "").lowercased() {
        case "wav":
            return max(1, losslessFloor / 2) // 16-bit mono PCM
        default:
            return max(1, losslessFloor / 16) // 16kbit mono MPEG
        }
    }

    /// Clamps a scheduled segment's frame count (from the container HEADER) to
    /// what the stored byte count could physically contain. A truncated
    /// FLAC's header claims the full length; the clamp turns the early EOF
    /// from a "skip" into a hard stop the elapsed gate handles. Returns the
    /// original count when the byte evidence doesn't constrain it (unknown
    /// byte count, unknown rate) — never zeroes a legitimate schedule.
    public static func clampedScheduledFrames(headerFrames: Int64, storedBytes: Int?, minimumBytesPerSecond: Double, sampleRateHz: Double) -> Int64 {
        guard let storedBytes, storedBytes > 0 else { return headerFrames }
        guard sampleRateHz > 0, minimumBytesPerSecond > 0 else { return headerFrames }
        // Frames-per-byte lower bound from the file's ACTUAL sample rate:
        // even the densest encoding cannot pack more than
        // sampleRate/minimumBytesPerSecond frames into one byte.
        let framesPerByte = sampleRateHz / minimumBytesPerSecond
        let maxPlausibleFrames = Int64((Double(storedBytes) * framesPerByte).rounded(.down))
        // A 4% container overhead keeps files with large sidecar metadata
        // (embedded art, ID3v2, FLAC padding) from clamping below their true
        // content.
        guard maxPlausibleFrames > 0 else { return headerFrames }
        return min(headerFrames, max(1, Int64((Double(maxPlausibleFrames) / 1.04).rounded(.down))))
    }

    /// True when a segment completion arrived at a position that cannot be a
    /// real end: the player's clock is MEASURABLE (lastRenderTime/playerTime
    /// resolve — a completed node's clock going nil is not evidence either
    /// way) and the measured position sits >= 1 s before the effective end.
    /// Defends the natural-advance path against fast completions from
    /// header-lying truncations (and any other poison that slips past the
    /// loader) — measured position cannot be faked by the container header.
    /// The 1 s margin keeps render-quantum slack out (cf. the FP-margin
    /// lesson, 2026-09-12: never test a boundary AT the boundary).
    public static func isPrematureCompletion(elapsedSeconds: Double, totalSeconds: Double, timeMeasured: Bool, remainingSeconds: Double) -> Bool {
        guard totalSeconds > 0, timeMeasured else { return false }
        return remainingSeconds >= 1.0
    }
}
