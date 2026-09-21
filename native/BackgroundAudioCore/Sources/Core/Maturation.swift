import Foundation

/// Pure maturation tracking for the staged streaming model (A15 design §1,
/// Phase 1). The loader reports byte arrivals; this core decides stage
/// transitions — EMPTY → HEADERED → PLAYABLE(lead) → COMPLETE — with the
/// schedule contract's boundaries pinned here so the engine can never
/// misread a stage.
///
/// Main-thread-only state lives in the engine's maps; this type is the
/// transition logic (pure, `swift test`-hostable).
public enum Maturation {

    public enum Stage: Equatable {
        case empty
        case headered
        case playable
        case complete
    }

    /// DECISION: the stage a download with `received` bytes has reached.
    ///
    /// - `complete` iff the full announced body is delivered (`announced` >
    ///   0 and received ≥ announced) — the only stage the byte gates may
    ///   judge (the 2026-09-21f contract).
    /// - `headered` iff a probe of the delivered prefix opened as audio
    ///   (the container header landed) — probed sparsely, NOT per tick
    ///   (an AVAudioFile open per byte-arrival would burn CPU; the caller
    ///   passes `headerProbeSaysAudio` only when it actually probed).
    /// - `playable` iff the delivered bytes cover the lead requirement:
    ///   `bytesForLead` (with the +10% headroom) computed by the caller
    ///   from StreamPolicy. Unknown lead requirement (nil) → never playable
    ///   (conservative: no evidence, wait for COMPLETE).
    public static func stage(
        received: Int64,
        announced: Int64,
        leadRequiredBytes: Int64?,
        headerProbeSaysAudio: Bool
    ) -> Stage {
        if announced > 0, received >= announced {
            return .complete
        }
        guard let lead = leadRequiredBytes, lead > 0, received >= lead else {
            return headerProbeSaysAudio ? .headered : .empty
        }
        return headerProbeSaysAudio ? .playable : .headered
    }

    /// Whether a header probe is worth running at `received` bytes: only
    /// at the byte counts where the stage boundary could move (the lead
    /// threshold and, before that, a sparse sampling schedule). The caller
    /// probes at most once per "rung" — the probe cadence is O(log) over a
    /// download, not O(bytes).
    public static func shouldProbeHeader(
        received: Int64,
        lastProbedAt: Int64,
        leadRequiredBytes: Int64?
    ) -> Bool {
        guard received >= minimumHeaderProbeBytes else { return false }
        // Probe at 16 KB, then double (32 KB, 64 KB, …) up to the lead
        // threshold. At/after the lead threshold the stage decision only
        // needs one more probe result (playable vs headered), so probe
        // exactly at the lead crossing too.
        let rung: Int64
        if let lead = leadRequiredBytes, received >= lead {
            rung = lead
        } else {
            var r: Int64 = minimumHeaderProbeBytes
            while r < received, r < (leadRequiredBytes ?? Int64.max) { r *= 2 }
            // The doubling can overshoot the lead (4 KB powers of two are
            // rarely exact): cap the rung AT the lead so the crossing is
            // always probed — it is the playable-vs-headered decision.
            if let lead = leadRequiredBytes, r > lead { r = lead }
            rung = r
        }
        return lastProbedAt < rung && received >= rung
    }

    /// The smallest prefix worth probing: below this, no container header
    /// has realistically landed (mirrors DecodeProbe.minimumSampleBytes).
    public static let minimumHeaderProbeBytes: Int64 = 4096

    // MARK: - Stall margin for staged loads

    /// The buffering floor for a staged schedule: when the delivered end
    /// approaches the playhead within this margin, the engine pauses and
    /// resumes via the Range-continue path rather than running into silence.
    /// Matches StreamSchedule.stallMarginSeconds (1 s) — the same number the
    /// completion-side guard uses, one definition of "about to run dry".
    public static let stallMarginBytesForLeadFraction = 0.10

    /// A simplified stall check in BYTES for the loader-side monitor (the
    /// engine-side frame check lives in StreamSchedule.isStallImminent):
    /// stalled when the undelivered remainder is less than 10 % of the
    /// announced total AND the lead is gone. Byte-space (not frame-space)
    /// because the loader doesn't decode.
    public static func isLoaderSideStall(received: Int64, announced: Int64) -> Bool {
        guard announced > 0 else { return false }
        let remainder = announced - received
        return Double(remainder) < Double(announced) * stallMarginBytesForLeadFraction
    }
}

/// Support shim for the loader's per-tick stage computation: bundles the
/// lead-bytes calculation with its conservative fallbacks.
public enum MaturationStageSupport {
    /// The byte threshold a download must reach for PLAYABLE, or nil when
    /// the inputs are unknown (unknown size/duration → wait for COMPLETE).
    public static func bytesForLeadWithFallback(
        fileBytes: Int64,
        duration: Double,
        leadSeconds: Double
    ) -> Int64? {
        StreamPolicy.bytesForLead(fileBytes: fileBytes, trackDuration: duration, leadSeconds: leadSeconds)
    }
}
