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

    // MARK: - Phase 2: the streaming writer's delivery policy

    /// DECISION on each delegate byte arrival: has the writer's accumulated
    /// buffer reached the point where the loader should deliver the `.part`
    /// to the engine as a PLAYABLE schedule source? Two triggers — the lead
    /// crossing (the stage contract's own boundary) and an arrival pushing
    /// the accumulated bytes past the next 512 KB flush rung (keeps the
    /// engine's chained-segment extension fed without per-arrival
    /// scheduling churn). The engine only ever SCHEDULES what the estimate
    /// proves schedulable, so delivering early is safe by construction.
    public static let writerFlushRungBytes: Int64 = 524_288 // 512 KB

    public static func writerShouldDeliver(
        accumulatedBytes: Int64,
        leadRequiredBytes: Int64?,
        lastDeliveredAt: Int64
    ) -> Bool {
        if let lead = leadRequiredBytes {
            // The lead crossing is the primary trigger: deliver the moment
            // the stage contract is satisfiable.
            if lastDeliveredAt < lead, accumulatedBytes >= lead { return true }
            // Subsequent rungs keep the extension fed at 512 KB granularity.
            if accumulatedBytes - lastDeliveredAt >= writerFlushRungBytes { return true }
        }
        return false
    }

    /// The writer's final-promotion contract: the accumulated `.part` bytes
    /// pass the SAME gates a download does. `isComplete` requires the exact
    /// announced body (raw streams only — a transcode's announced length is
    /// an estimate and cannot anchor the byte-exact gate; the design keeps
    /// transcodes on the full-download `downloadTask` path in Phase 2 for
    /// exactly this reason). Returns nil when completeness cannot be judged
    /// (no announced length) — the writer then ends the stream with a
    /// completion-event judgment instead of a byte verdict.
    public static func writerCompleteVerdict(
        accumulatedBytes: Int64,
        announcedBytes: Int64
    ) -> WriterVerdict? {
        guard announcedBytes > 0 else { return nil }
        if accumulatedBytes >= announcedBytes { return .promote }
        return .earlyClose
    }

    public enum WriterVerdict: Equatable {
        /// The full announced body is on disk: run the gate chain + promote
        /// to cache (identical to a downloadTask success).
        case promote
        /// The transfer ended before the announced body: retain the `.part`
        /// + record `pendingParts` so the next prefetch Range-continues it.
        case earlyClose
    }
}
