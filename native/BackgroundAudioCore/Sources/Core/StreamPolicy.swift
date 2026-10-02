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
    /// announced body for a RAW stream (its announced length is a promise).
    /// Returns nil when completeness cannot be judged — no announced length,
    /// OR a TRANSCODE. A transcode's announced Content-Length is a server-side
    /// ESTIMATE of the yet-to-be-encoded output, so a byte-exact verdict would
    /// false-close (or false-promote) on ordinary encode-size drift; a transcode
    /// completion therefore ends through the decodability + duration-
    /// corroboration path (`DownloadSanity.transcodeDurationCorroborated`),
    /// exactly like a chunked raw body. Announced bytes STILL feed the staged
    /// schedule's delivered-end ESTIMATE — the estimate is not a promise.
    ///
    /// Transcode streaming (2026-10-02): this is the change that lets a
    /// transcode tap stream — its completion can no longer be misjudged by an
    /// estimate, so the writer may serve a transcode without the byte-exact
    /// hazard the original Phase 2 note cited as the reason not to.
    public static func writerCompleteVerdict(
        accumulatedBytes: Int64,
        announcedBytes: Int64,
        transcode: Bool = false
    ) -> WriterVerdict? {
        if transcode { return nil }
        guard announcedBytes > 0 else { return nil }
        if accumulatedBytes >= announcedBytes { return .promote }
        return .earlyClose
    }

    // MARK: - Transcode streaming (2026-10-02)

    /// The byte total the writer uses for BYTE↔LEAD and byte↔frame math. For a
    /// raw stream the snapshot's `size` IS the transfer's total. For a
    /// TRANSCODE the snapshot `size` is the SOURCE file's bytes — an order of
    /// magnitude larger than the output — so sizing the lead from it would
    /// demand ~85 % of the output before PLAYABLE, defeating the whole point.
    /// Prefer the response's own Content-Length when the server announces one.
    public static func effectiveTotalBytes(snapshotBytes: Int64, announcedBytes: Int64) -> Int64 {
        announcedBytes > 0 ? announcedBytes : snapshotBytes
    }

    /// DECISION: may the writer deliver a PLAYABLE source for this load? A
    /// transcode's schedule end is estimated from the byte ratio
    /// (`StreamSchedule.stagedEndFramesEstimate`), which needs the transfer's
    /// TOTAL — with no announced total there is no honest end, so a delivered
    /// source could never be scheduled and the load would cycle through the
    /// stall → give-up → JS-retry machine. Withhold the delivery: the transfer
    /// then completes and promotes through the duration-corroboration gate,
    /// byte-identical to today's full-download behavior. Raw streams are
    /// exempt (their announced total comes from the snapshot and is present).
    public static func mayDeliverProgress(announcedBytes: Int64, transcode: Bool) -> Bool {
        !transcode || announcedBytes > 0
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
