import Foundation

/// Pure stream-schedule decisions for the staged-maturation streaming model
/// (A15 design, `docs/plans/2026-09-21-native-streaming.md` — Phase 0).
/// Inert until Phase 2/3 wire the engine to it; shipped with tests first so
/// the invariants are pinned before any schedule code depends on them.
///
/// The model: a track's local file matures EMPTY → HEADERED → PLAYABLE →
/// COMPLETE. A schedule may only be made from a PLAYABLE-or-better file and
/// must end inside the delivered region (the schedule contract) — so a
/// completion firing early is provably a STALL, never truncation. A running
/// schedule grows by CHAINING segments on the same player node
/// (`AVAudioPlayerNode` renders chained segments back-to-back), which makes
/// one node's completion stream a mix of SEGMENT ends (consume silently) and
/// TRACK ends (advance the queue).
///
/// Dependency-free, `swift test`-hostable (E5: CI compiles and tests the
/// core; no local toolchain).
public enum StreamSchedule {

    // MARK: - Maturation

    public enum Stage: Equatable {
        case empty
        case headered
        case playable
        case complete
    }

    /// Frames that are honestly schedulable given `deliveredBytes`: the
    /// player may consume up to the delivered end. Byte-to-frame conversion
    /// is deliberately caller-owned (container-dependent); this guard only
    /// clamps against the header's claim so a lying header can never extend
    /// the promise past real bytes (the 2026-09-18 lesson, inverted: the
    /// header LIES HIGH, delivered bytes are truth, take the MIN).
    public static func schedulableEndFrames(
        deliveredEndFrames: Int64,
        headerClaimedFrames: Int64
    ) -> Int64 {
        min(max(0, deliveredEndFrames), max(0, headerClaimedFrames))
    }

    /// The staged schedule contract: a schedule ending at `endFrames` is
    /// honest iff the end is inside the schedulable region and the segment
    /// is non-empty. `startFrame > endFrames` (seek past delivery) must
    /// never schedule.
    public static func canSchedule(
        startFrame: Int64,
        endFrames: Int64
    ) -> Bool {
        endFrames > startFrame && startFrame >= 0
    }

    // MARK: - Extension (chained segments)

    /// DECISION each stream-monitor tick: does the delivered end now justify
    /// chaining another segment? Extending mid-lead is churn (a timer-driven
    /// schedule call per tick); extend only when a meaningful chunk
    /// (`minExtensionSeconds` at the file's sample rate) is newly schedulable
    /// beyond the currently promised end. Never extends past the header
    /// claim (clamped upstream by `schedulableEndFrames`).
    public static let minExtensionSeconds = 5.0

    public static func extensionPlan(
        currentEndFrames: Int64,
        schedulableEndFrames: Int64,
        sampleRate: Double,
        headerClaimedFrames: Int64
    ) -> ExtensionPlan {
        guard sampleRate > 0,
              headerClaimedFrames > currentEndFrames,
              schedulableEndFrames > currentEndFrames
        else { return .none }
        let newlySchedulable = schedulableEndFrames - currentEndFrames
        let minFrames = Int64(minExtensionSeconds * sampleRate)
        guard newlySchedulable >= minFrames else { return .none }
        return .extend(to: schedulableEndFrames)
    }

    public enum ExtensionPlan: Equatable {
        /// Nothing worth chaining yet (or nothing left — header end reached).
        case none
        /// Chain a segment up to `to` frames (the new schedulable end).
        case extend(to: Int64)
    }

    // MARK: - Completion discrimination (the ONE new invariant)

    /// What a completion on a node means. With chained segments, the node's
    /// data-consumed completion fires at the end of EVERY segment; only the
    /// LAST scheduled segment's completion is the track end.
    ///
    /// `hasChainedSuccessor` is true iff, at completion time, another segment
    /// is already scheduled on the same node AFTER the one completing. The
    /// engine records this when it chains (`chainedSegments[node] += 1`) and
    /// decrements as completions consume.
    public static func completionVerdict(hasChainedSuccessor: Bool) -> CompletionVerdict {
        hasChainedSuccessor ? .segmentEnd : .trackEnd
    }

    public enum CompletionVerdict: Equatable {
        /// A chained segment finished; the node keeps rendering its successor.
        /// Consume silently — no advance, no gate, no eviction.
        case segmentEnd
        /// The final segment finished: natural track end (all existing
        /// identity/generation gates then apply unchanged).
        case trackEnd
    }

    // MARK: - Stall handling

    /// Is the playhead about to run off the delivered end? The stall margin
    /// exists so the pause happens while audio is still audible-adjacent,
    /// not after silence. `leadFrames` = distance between playhead and the
    /// delivered end.
    public static let stallMarginSeconds = 1.0

    public static func isStallImminent(
        playheadFrames: Int64,
        schedulableEndFrames: Int64,
        sampleRate: Double
    ) -> Bool {
        guard sampleRate > 0 else { return false }
        let margin = Int64(stallMarginSeconds * sampleRate)
        return schedulableEndFrames - playheadFrames <= margin
    }

    /// The stall verdict for a completion that fired before its promised end:
    /// with the schedule contract (§1) this can only happen on a staged
    /// schedule whose delivered end was reached — a stall, never truncation
    /// (truncation judgment stays EXCLUSIVELY on COMPLETE files through the
    /// existing `DownloadSanity` gates).
    public static func prematureCompletionVerdict(
        stage: Stage
    ) -> PrematureVerdict {
        switch stage {
        case .complete:
            // A COMPLETE file ending early is the existing poison path —
            // the engine's elapsed gate + evict + retry (unchanged).
            return .truncation
        case .playable, .headered, .empty:
            // A staged schedule ran out of delivered bytes: pause + resume
            // from the offset. No evict — the bytes are a valid prefix.
            return .streamStall
        }
    }

    public enum PrematureVerdict: Equatable {
        case truncation
        case streamStall
    }
}
