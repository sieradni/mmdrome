import Foundation

/// Pure download-sanity decisions for the native track-file loader.
///
/// The 2026-09-17 multi-skip fix validated TRANSFER completeness (body size,
/// 0-frame rejection) but NOT byte-adequacy: audio containers (FLAC, MP4,
/// MPEG) keep their declared duration in the HEADER, and Ogg/Opus granule
/// positions let a cut-inside-a-final-page body still report full length, so
/// a truncated download opens as a "full-length" AVAudioFile and reaches EOF
/// early — the 2026-09-18 LDM multi-skip (engine-side trackChanged 3–5 rows
/// ~50–100 ms apart, bridge trail shows no JS cmd between them).
///
/// TWO evidence kinds remain here after the 2026-09-19 revision:
///  1. `isTruncatedAgainstServer` — the byte count vs the server's announced
///     size, judged at the loader's trust boundary (store + serve). The byte
///     count is the only cut-position-independent evidence; the container is
///     the liar.
///  2. `isPrematureCompletion` — the measured player clock vs the scheduled
///     segment's own length, judged at completion time.
///
/// The 2026-09-18 schedule CLAMP was removed (2026-09-19): the completion
/// fires when the DATA runs out, which is always before any plausible clamp
/// bound for the truncations that matter, so the clamp never changed when a
/// poisoned segment completed — it only risked false-bounding at-floor
/// encodings. The premature gate (with evict-on-drop) is the defense that
/// actually fires. These functions live in Core so the matrices are
/// unit-tested; the loader/engine are thin adapters (design rule F2).
public enum DownloadSanity {

    /// Rejects a completed transfer whose byte count is materially short of
    /// the server's announced Content-Length. The 10 % margin (NOT 0) absorbs
    /// servers that send `Content-Length` only when they know the exact size
    /// and early header tweaks; requiring an EXACT match would false-reject
    /// legitimate streams. A missing/zero announced length is always OK —
    /// chunked servers have no length to lie about. RAW streams only: a
    /// transcode's announced length is a server-side estimate and must never
    /// be judged against source bytes.
    public static func isTruncatedAgainstServer(storedBytes: Int, serverLength: Int64) -> Bool {
        guard serverLength > 0 else { return false }
        return Double(storedBytes) < 0.9 * Double(serverLength)
        // The multiplier form (not storedBytes < serverLength - slack) so the
        // gate scales from small podcast files to 80 MB FLACs.
    }

    /// True when a segment completion arrived at a position that cannot be a
    /// real end: the player's clock is MEASURABLE (lastRenderTime/playerTime
    /// resolve — a completed node's clock going nil is not evidence either
    /// way) and the measured position sits >= 1 s before the scheduled
    /// segment's own end. The reference is the SCHEDULED SEGMENT (the
    /// container's own frame count — file truth), NOT the metadata duration:
    /// a mis-tagged track must not false-drop (the class of bug trusting
    /// element-derived duration once caused on the web side), and for a
    /// truncated download the header over-reports exactly like the metadata
    /// would, so file truth catches everything metadata would — plus the
    /// mis-tag case metadata would break. Defends the natural-advance path
    /// against fast completions from header-lying truncations (and any other
    /// poison that slips past the loader) — measured position cannot be faked
    /// by the container header. The 1 s margin keeps render-quantum slack out
    /// (cf. the FP-margin lesson, 2026-09-12: never test a boundary AT the
    /// boundary).
    public static func isPrematureCompletion(elapsedSeconds: Double, totalSeconds: Double, timeMeasured: Bool, remainingSeconds: Double) -> Bool {
        guard totalSeconds > 0, timeMeasured else { return false }
        return remainingSeconds >= 1.0
    }
}
