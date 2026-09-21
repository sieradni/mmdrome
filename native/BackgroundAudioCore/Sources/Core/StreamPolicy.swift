import Foundation

/// Pure policy for WHEN native playback may stream instead of full-download
/// (A15 design §3 — Phase 0). Inert until Phase 2 wires it into `loadAndStart`.
///
/// Principles:
/// - Streaming is for the DIRECT TAP (the user is waiting) and only when the
///   link cannot deliver the full file faster than the staged lead needs.
/// - The preload window is the OFFLINE BUFFER — never streamed (A14's
///   offline-advance contract).
/// - A server without Range support cannot guarantee forward progress on a
///   stalled stream → full-download fallback (the `rangeUnsupportedKeys`
///   lesson, 2026-09-21f).
public enum StreamPolicy {

    public enum Mode: Equatable {
        /// Feature off (the default until field data): everything full-download.
        case off
        /// Stream only when the link is the constraint.
        case slowLink
        /// Stream every direct tap regardless of bandwidth (diagnostics).
        case on
    }

    /// DECISION for one direct tap. `estimatedFullDownloadSeconds` comes from
    /// the recent-transfer bandwidth estimate × file size (caller-owned);
    /// `estimatedSecondsToPlayable` from the same bandwidth over the lead
    /// bytes. A fast link wins by full download: simpler, cache-warms for
    /// offline, byte-gate-protected (the staged path trades the byte-exact
    /// gate for the lead contract).
    public static func shouldStreamDirectTap(
        mode: Mode,
        rangeSupported: Bool,
        estimatedFullDownloadSeconds: Double,
        estimatedSecondsToPlayable: Double
    ) -> Bool {
        switch mode {
        case .off:
            return false
        case .on:
            return rangeSupported
        case .slowLink:
            guard rangeSupported else { return false }
            // Only stream when waiting for full completion is meaningfully
            // slower than reaching the playable lead. The 1.25× slack keeps
            // borderline links on the simpler full-download path.
            return estimatedSecondsToPlayable * 1.25 < estimatedFullDownloadSeconds
        }
    }

    /// Preload-window rows NEVER stream — they are the offline buffer. This
    /// is a hard rule, not a heuristic: streaming preloads would break the
    /// offline-advance contract (A14) that the web engine's cache-hit/miss
    /// split already provides.
    public static func shouldStreamPreloadRow(mode: Mode) -> Bool {
        false
    }

    /// The lead-buffer requirement for a PLAYABLE schedule: enough audio
    /// ahead of the playhead that a normal network jitter does not stall
    /// immediately. 15 s matches the app's crossfade ceiling — a lead shorter
    /// than the configured fade could not cover Phase 3's fade-target
    /// readiness (lead ≥ crossfadeDuration).
    public static let minimumLeadSeconds = 15.0

    /// The effective lead for a load, never below the minimum and never more
    /// than the track itself (a 12 s jingle is playable whole).
    public static func effectiveLeadSeconds(trackDuration: Double) -> Double {
        if trackDuration > 0 {
            return min(minimumLeadSeconds, trackDuration)
        }
        return minimumLeadSeconds
    }

    /// Bytes needed to reach the lead, from an average bytes/second rate
    /// (audio bitrate ≈ fileBytes / duration). Returns nil when the inputs
    /// are unknown (unknown duration/size) — the caller then waits for
    /// COMPLETE (conservative: no evidence, no streaming).
    public static func bytesForLead(
        fileBytes: Int64,
        trackDuration: Double,
        leadSeconds: Double
    ) -> Int64? {
        guard fileBytes > 0, trackDuration > 0, leadSeconds > 0 else { return nil }
        let bytesPerSecond = Double(fileBytes) / trackDuration
        // +10% headroom over the average-rate estimate (VBR tails, container
        // overhead at the head).
        return Int64((bytesPerSecond * leadSeconds) * 1.10)
    }
}
