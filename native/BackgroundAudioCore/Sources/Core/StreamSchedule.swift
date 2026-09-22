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

    // MARK: - Phase 2: the delivered-end estimate + the buffering contract

    /// Frames honestly schedulable from a PARTIAL file, estimated from the
    /// byte ratio. The container header claims `headerClaimedFrames` total;
    /// `deliveredBytes` of `announcedBytes` have landed. Biased DOWN by
    /// `slack` (default 0.98) — an undershoot pauses slightly early at the
    /// delivered boundary (the buffering pause, safe); an overshoot runs the
    /// data dry mid-segment (a stall the completion backstop catches, but
    /// the audible gap is worse). CBR error is container overhead ±2 %.
    /// Returns 0 when the inputs carry no evidence (announced unknown → no
    /// estimate → the caller must not stage; conservative).
    public static func estimatedFramesEndable(
        headerClaimedFrames: Int64,
        deliveredBytes: Int64,
        announcedBytes: Int64,
        slack: Double = 0.98
    ) -> Int64 {
        guard headerClaimedFrames > 0, deliveredBytes > 0, announcedBytes > 0 else { return 0 }
        let ratio = min(1.0, Double(deliveredBytes) / Double(announcedBytes))
        return Int64((Double(headerClaimedFrames) * ratio * slack).rounded(.down))
    }

    /// DECISION after a buffering pause: has enough new audio landed beyond
    /// the stalled position to resume without immediately re-stalling?
    /// `resumeMarginSeconds` (2 s) is deliberately BELOW `minExtensionSeconds`
    /// (5 s): resuming from a stall re-schedules everything schedulable, so
    /// even a small chunk unblocks the user — while timer-driven EXTENSION of
    /// a running schedule stays at the higher churn bar.
    public static let resumeMarginSeconds = 2.0

    public static func shouldResumeAfterStall(
        stalledFrames: Int64,
        schedulableEndFrames: Int64,
        sampleRate: Double
    ) -> Bool {
        guard sampleRate > 0 else { return false }
        let margin = Int64(resumeMarginSeconds * sampleRate)
        return schedulableEndFrames - stalledFrames >= margin
    }

    /// Seconds of zero progress during a buffering pause before the engine
    /// gives up on the stream and surfaces an error (the JS bounded retry
    /// takes over — its re-engage Range-continues the same .part bytes).
    public static let stallGiveUpSeconds = 10.0

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

    // MARK: - The promote tail (design review 2026-09-21, F3)

    /// DECISION when the writer PROMOTES a COMPLETE file: the chained tail
    /// must reach the file's REAL end. Deliberately NO minimum-extension
    /// bar — `minExtensionSeconds` exists to bound timer churn on a RUNNING
    /// schedule; at completion there will be no further extensions, so any
    /// positive remainder must be chained or it is silence at the end of
    /// every streamed track (the 0.98 estimate slack ≈ 2 % of the file —
    //  ~6 s at 4 min — was previously dropped on the 5 s bar). Still never
    /// past the header claim, never a no-op, never a rewind.
    public static func completionTailPlan(
        currentEndFrames: Int64,
        schedulableEndFrames: Int64,
        sampleRate: Double,
        headerClaimedFrames: Int64
    ) -> Int64? {
        guard sampleRate > 0,
              headerClaimedFrames > currentEndFrames,
              schedulableEndFrames > currentEndFrames
        else { return nil }
        return schedulableEndFrames
    }

    // MARK: - Phase 3: staged tracks and the crossfade

    /// May a fade be AUTOMATED for the staged track in this state? While
    /// still streaming (estimate-based schedule), NO: the promise ends short
    /// of the metadata transition point (the 2 % slack biases down), so the
    /// fade window cannot cover the ramp — and the buffering pause would tear
    /// a mid-flight fade down. Once COMPLETE the schedule IS file truth (the
    /// byte gates proved it) and the staged track fades exactly like a
    /// full-download track. The engine applies this at the monitor's setup
    /// choke point AND in the staged schedule branch (an armed monitor must
    /// not survive a re-schedule that lost eligibility).
    public static func fadeEligibility(isScheduleComplete: Bool) -> Bool {
        isScheduleComplete
    }

    /// The verdict for a staged node's LAST-segment completion (no chained
    /// successor) — the Phase 3 end-discrimination matrix. This is the one
    /// new interaction: the staged end and the fade switch point are the
    /// SAME completion when a fade is in flight.
    ///
    /// - complete + fade in flight → the SWITCH POINT: finalize (the standby
    ///   is already mid-ramp; a direct advance would race it — the 1.2.28
    ///   wedge's shape). No premature gate here: the byte gates already
    ///   proved this file, and abort-keep-active would strand it (a complete
    ///   staged schedule has no remaining tail to "keep playing").
    /// - complete + no fade → the natural advance (sleep/loop/next logic).
    /// - not complete + no fade → the buffering pause.
    /// - not complete + fade in flight → contractually impossible (fades arm
    ///   only on complete schedules) — defense in depth: abort the fade and
    ///   take the buffering pause rather than finalize against a promise that
    ///   just expired.
    public static func stagedEndVerdict(
        isScheduleComplete: Bool,
        fadeInFlight: Bool
    ) -> StagedEndVerdict {
        switch (isScheduleComplete, fadeInFlight) {
        case (true, true): return .finalizeSwitch
        case (true, false): return .advance
        case (false, false): return .bufferingPause
        case (false, true): return .abortFadeThenPause
        }
    }

    public enum StagedEndVerdict: Equatable {
        /// The fade's switch point: finalizeCrossfadeSwitch (the standby
        /// becomes active; the outgoing staged state tears down in finalize).
        case finalizeSwitch
        /// Natural end: sleep-park / loop-one / advance / queue-end logic.
        case advance
        /// The buffering pause (never an advance, never an evict).
        case bufferingPause
        /// Defense in depth only (contractually unreachable): drop the fade
        /// automation, then take the buffering pause.
        case abortFadeThenPause
    }

    /// F3 (2026-09-22 field dump): the stall-ledger rescue verdict. A stall
    /// whose delivered bytes have REACHED the announced total means the
    /// transfer is DONE — a live completion path would have promoted the
    /// file and un-stalled the schedule. Remaining stalled at
    /// delivered == announced is therefore a lost-completion defect (the F1
    /// class), not slow bandwidth: burning the give-up timer plus a JS retry
    /// round trip on a fully-downloaded track is pure waste. Rescue =
    /// complete the schedule from the on-disk file.
    /// `announcedBytes == 0` (no Content-Length evidence) never rescues —
    /// equality with zero means nothing.
    public static func stallRescueEligible(deliveredBytes: Int64, announcedBytes: Int64) -> Bool {
        announcedBytes > 0 && deliveredBytes >= announcedBytes
    }
}
