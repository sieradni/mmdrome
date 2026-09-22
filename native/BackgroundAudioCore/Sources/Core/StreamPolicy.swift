import Foundation

/// Pure policy for native staged streaming (A15 design §3). Streaming is
/// FULLY INTEGRATED (2026-09-21 user decision — the off/slowLink/on setting
/// was removed as unnecessary UI): every ELIGIBLE raw direct tap streams.
/// Eligibility lives engine-side (`TrackFileLoader.streamDecision` — the
/// loader owns the evidence); this core owns the quantities the staged
/// contract is built on: the lead sizing, the writer's delivery cadence,
/// and the final-promotion byte verdict.
///
/// Standing principles:
/// - The preload window is the OFFLINE BUFFER — never streamed (A14's
///   offline-advance contract; the engine's gate never routes preload rows
///   to the writer).
/// - A server without Range support cannot guarantee forward progress on a
///   stalled stream → full-download fallback (the `rangeUnsupportedKeys`
///   lesson, 2026-09-21f).
/// - Transcoded variants keep the full-download `downloadTask` path: their
///   announced length is a server-side estimate, which the byte-exact
///   promotion verdict cannot use.
public enum StreamPolicy {

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
