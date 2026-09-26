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

    /// BYTE-EXACT gate (2026-09-21, the Connectivity Assist workaround): a
    /// transfer whose own HTTP response announced `Content-Length: N` but
    /// delivered fewer bytes was cut by a clean early close — URLSession
    /// reports success (error == nil) for those, so the error path never
    /// sees them, and the 10 % metadata margin above passes drops up to
    /// 10 % of the file (~25 s of audio on a 4 MB opus) into the cache as
    /// poison. The per-transfer announcement IS a promise for raw streams:
    /// enforce it exactly. Direction-safe under transparent compression
    /// (URLSession decompresses; decompressed bytes are ≥ the announced
    /// compressed length, and the gate only rejects actual < announced).
    /// RAW streams only — a transcode's announced length is an estimate and
    /// stays excluded (see `isTruncatedAgainstServer`).
    public static func isShortOfAnnouncedBytes(actualBytes: Int, announcedBytes: Int64) -> Bool {
        guard announcedBytes > 0 else { return false }
        return Int64(actualBytes) < announcedBytes
    }

    /// TRANSCODE DURATION-CORROBORATION GATE (2026-09-23, the LDM-cellular
    /// `cannot parse response` post-mortem). A transcode body is exempt from
    /// BOTH byte gates (isTruncatedAgainstServer / isShortOfAnnouncedBytes):
    /// the announced Content-Length is a server-side ESTIMATE of the yet-to-be-
    /// encoded output, and the snapshot's `size` is the SOURCE file's bytes.
    /// That exemption left a transcode cut mid-stream — Navidrome's stream
    /// socket dying (URLSession -1010 `cannot parse response`) or a clean early
    /// close — with NO evidence gate: it decodes to N>0 frames, so the 0-frame
    /// probe passes, and it was stored as a COMPLETE cache entry. The poisoned
    /// entry then became a fade TARGET: `scheduleSegment` scheduled exactly the
    /// frames the container currently reports, the standby's audio ran out
    /// mid-ramp, and `abort-keep-active` killed the fade (the aborts the D1
    /// dead-air watchdog now recovers from).
    ///
    /// The corroboration that IS available: the container itself. A truncated
    /// Ogg/Opus cut inside the stream still re-serializes page headers with
    /// accurate granule positions for the audio it DOES carry, so
    /// AVAudioFile.length answers the REAL decodable duration of the delivered
    /// bytes — while the snapshot's metadata duration states the full track.
    /// A container claim materially short of the metadata duration is
    /// byte-truncation evidence that survives the estimate problem: no byte
    /// count is compared at all (delivered bytes track the audio actually
    /// carried in BOTH the truncated and the honest-short case, so they
    /// cannot discriminate — the parameter would be dead weight). The verdict
    /// only fires when the gap is large (>= 3 s AND >= 8 % of the track) so
    /// conservative roundings, per-track metadata slop and encoder padding
    /// can never false-reject.
    ///
    /// KNOWN LIMIT (accepted): a file whose metadata duration is
    /// catastrophically wrong-LONG (a badly tagged 30 s file recorded as
    /// 148 s) is indistinguishable from truncation by content alone and is
    /// rejected too. Its old behavior was also broken (cached, played short,
    /// premature-evicted, retried in a loop) — the terminal outcome is the
    /// same bounded-retry → fromError advance, minus the audible churn; the
    /// only cost is re-downloading that track on future sessions.
    ///
    /// - Parameters:
    ///   - probeFrames: AVAudioFile.length over the delivered body (0 =
    ///     undecodable — already rejected by the caller's 0-frame gate).
    ///   - sampleRate: the container's sample rate (frames → seconds).
    ///   - metadataDuration: the snapshot's track duration in seconds.
    ///   - transcode: raw streams stay on the byte gates — their container
    ///     claim is FULL (the header was downloaded complete) and a
    ///     mis-tagged duration must not false-reject them.
    public static func transcodeDurationCorroborated(
        probeFrames: Int64,
        sampleRate: Double,
        metadataDuration: Double,
        transcode: Bool
    ) -> Bool {
        guard transcode else { return false }
        guard probeFrames > 0, sampleRate > 0, metadataDuration > 1.0 else { return false }
        let claimSeconds = Double(probeFrames) / sampleRate
        let gap = metadataDuration - claimSeconds
        // Claim >= metadata: the container carries everything the metadata
        // promises (or more — tag slop the other way). Not truncation.
        guard gap > 0 else { return false }
        // Absolute AND relative: 3 s floor (rounding slop) and 8 % floor
        // (per-track metadata inaccuracy on long tracks).
        return gap >= 3.0 && gap >= 0.08 * metadataDuration
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
    /// poison that slips past the loader) — a hardware/OS-measured position
    /// cannot be faked by software.
    ///
    /// 2026-09-25 (1.2.41): the caller passes BOTH clocks. `nodeElapsed` —
    /// the completing node's own player-timeline position, captured inside
    /// the completion callback BEFORE the main hop — is the preferred
    /// truth: it is the NODE's own frames-consumed count, immune to the
    /// active-node read (positionBias, active-vs-completing mixups) and to
    /// the `cachedPosition` fallback. `elapsedSeconds` (the wall-clock read
    /// over the container timeline) is the FALLBACK: it keeps the gate
    /// armed when the node's clock is unreadable at completion time.
    /// `completionEvidence` resolves the preference ONCE for all gates.
    public static func isPrematureCompletion(elapsedSeconds: Double, totalSeconds: Double, timeMeasured: Bool, remainingSeconds: Double) -> Bool {
        guard timeMeasured else { return false }
        return remainingSeconds >= 1.0
    }

    /// The action for the ACTIVE node's EOF while a crossfade is in flight
    /// (2026-09-25, the two "caught a play halfway then restart" dumps).
    /// The 2026-09-21e abort-keep-active response for a PREMATURE verdict
    /// rested on the premise that the outgoing tail "plays out its real
    /// remaining tail and its genuine natural end advances the queue" —
    /// but a `dataConsumed` completion is ONE-SHOT: once it fires, the node
    /// has NO future completion, so the premise is impossible by
    /// construction. Whenever the abort runs on a near-end EOF the queue
    /// stalls silently until the D1 dead-air watchdog advances ~3 s late
    /// (elapsed ≈ end = the node is exhausted, not mid-tail).
    ///
    /// A NEAR-END EOF within `nearEndFinalizeEpsilonSeconds` of the
    /// scheduled segment end is measurement slop, not truncation evidence:
    /// real truncations EOF MINUTES early (the LDM signature), while the
    /// field's shortest gap is 1.0–1.1 s (202/202.5, 202/201.0) — the node
    /// is genuinely done, and the byte-complete streams promoted cleanly in
    /// both dumps (delivered == announced, no early-close, no loader
    /// failure). Finalizing the switch hands playback to the ALREADY-RAMPED
    /// standby and keeps `finalizeCrossfadeSwitch`'s own teardown (which
    /// drains and stops the exhausted outgoing node). The epsilon exceeds
    /// the whole family: rounding slop, cross-node render latency, and the
    /// ramp's last steps — and stays far below the 3 s dead-air grace so a
    /// misjudged finalize still lands INSIDE the watchdog's protection, not
    /// past it.
    ///
    /// 2026-09-25 (1.2.41): the measured position is the completing node's
    /// OWN consumed-frame count when available (`.dataPlayedBack` fires
    /// after the last frame RENDERS, so node truth reads ≈ the schedule
    /// end with no buffer-depth slop) — the wall-clock read is the
    /// fallback. `midFadeActiveEofAction` now takes the resolved
    /// `CompletionEvidence`; the (elapsedSeconds:…) overload remains for
    /// the test pins and callers without node evidence.
    ///
    /// - Parameters:
    ///   - elapsedSeconds: the MEASURED position (only meaningful when
    ///     `timeMeasured` is true).
    ///   - totalSeconds: the scheduled segment's length (file truth).
    ///   - remainingSeconds: totalSeconds − elapsedSeconds (>= 1.0 by the
    ///     time this is consulted — a verdict inside the 1 s margin already
    ///     finalized gate-free).
    ///   - timeMeasured: the §3.4 unmeasurable-clock rule — an unmeasurable
    ///     clock fell back to the stale `cachedPosition` and is never judged.
    public static let nearEndFinalizeEpsilonSeconds: Double = 2.0

    public enum MidFadeActiveEofAction: Equatable {
        /// Real end at the segment boundary: the switch point.
        case finalize
        /// NEAR-end (within the epsilon): measurement slop on a genuinely
        /// finished node — finalize instead of abort (the one-shot
        /// completion makes abort a dead-air wedge).
        case finalizeNearEnd
        /// Far short of the end: truncation evidence — abort-keep-active
        /// stands (the 2026-09-21e minimum response for genuinely SHORT
        /// bytes; the D1 watchdog owns the lost end).
        case abortKeepActive
    }

    public static func midFadeActiveEofAction(
        elapsedSeconds: Double,
        totalSeconds: Double,
        remainingSeconds: Double,
        timeMeasured: Bool
    ) -> MidFadeActiveEofAction {
        guard timeMeasured, totalSeconds > 0 else { return .finalize }
        if remainingSeconds < 1.0 { return .finalize }
        if remainingSeconds <= nearEndFinalizeEpsilonSeconds { return .finalizeNearEnd }
        return .abortKeepActive
    }

    // MARK: - Node-truth completion evidence (1.2.41, 2026-09-25)

    /// WHERE a completion's elapsed number came from — the discriminating
    /// fact every future dump needs to adjudicate a residual gate question
    /// (the 1.2.40 dumps forced a full re-adjudication precisely because
    /// the wall-clock line carried no source provenance).
    public enum CompletionEvidenceSource: Equatable {
        /// The completing node's own player-timeline position, captured
        /// INSIDE the completion callback before the main hop
        /// (`node.playerTime(forNodeTime: node.lastRenderTime)` — frames
        /// the node itself reports consumed). The preferred truth.
        case nodeTimeline
        /// The §3.4 wall-clock read (`currentPosition`) taken in the
        /// completion handler: the ACTIVE node's playerTime + positionBias
        /// over the container timeline. Fallback only.
        case wallClock
        /// No measurable clock anywhere: never judged.
        case unmeasured
    }

    /// One completion's elapsed-position evidence, already resolved to its
    /// best source. Built by `completionEvidence` (pure) from the raw
    /// readings; consumed by the gates (the premature gate, the mid-fade
    /// action) and by the danger lines (the source rides every verdict
    /// line so a dump can tell node truth from a fallback).
    public struct CompletionEvidence: Equatable {
        public let source: CompletionEvidenceSource
        /// Elapsed position in seconds on the schedule's own timeline.
        /// 0 for `.unmeasured` (the gates must not read it).
        public let elapsedSeconds: Double
        public let totalSeconds: Double

        public var remainingSeconds: Double { totalSeconds - elapsedSeconds }
        public var timeMeasured: Bool { source != .unmeasured }
    }

    /// Resolves ONE completion's position evidence: the completing node's
    /// own player-timeline capture wins whenever it is present and
    /// non-negative (a negative sampleTime is a mis-read — the node had
    /// rendered nothing measurable); the wall-clock read is the fallback
    /// ONLY when it is itself measurable (the §3.4 rule — an unmeasurable
    /// wall read silently fell back to the stale `cachedPosition` and is
    /// not evidence); otherwise `.unmeasured` — never judged.
    ///
    /// The node capture is expected to be `nil` whenever its reader met a
    /// nil lastRenderTime/playerTime — the exact conditions the old
    /// `timeMeasured` flag covered, now per-node and per-instant.
    public static func completionEvidence(
        nodeElapsedSeconds: Double?,
        wallElapsedSeconds: Double?,
        wallTimeMeasured: Bool,
        totalSeconds: Double
    ) -> CompletionEvidence {
        if let node = nodeElapsedSeconds, node >= 0 {
            return CompletionEvidence(source: .nodeTimeline, elapsedSeconds: node, totalSeconds: totalSeconds)
        }
        if wallTimeMeasured, let wall = wallElapsedSeconds, wall >= 0 {
            return CompletionEvidence(source: .wallClock, elapsedSeconds: wall, totalSeconds: totalSeconds)
        }
        return CompletionEvidence(source: .unmeasured, elapsedSeconds: 0, totalSeconds: totalSeconds)
    }

    /// The premature-completion verdict over RESOLVED evidence (the
    /// natural path's gate). Same contract as `isPrematureCompletion` —
    /// drop when a measurable clock places the completion materially short
    /// of the scheduled segment's end — with two differences:
    ///  - the node-truth read has NO buffer-depth slop under
    ///    `.dataPlayedBack` (the completion fires after the last frame
    ///    RENDERS), so the 1 s `remaining` margin now guards against REAL
    ///    slop only (rate-map rounding), and stays deliberately
    ///    conservative;
    ///  - an `.unmeasured` completion is never dropped (no clock = no
    ///    evidence = no eviction) — the §3.4 rule, unchanged.
    public static func isPrematureCompletion(evidence: CompletionEvidence) -> Bool {
        guard evidence.timeMeasured, evidence.totalSeconds > 0 else { return false }
        return evidence.remainingSeconds >= 1.0
    }

    /// The mid-fade ACTIVE-EOF action over RESOLVED evidence. Node truth
    /// replaces the epsilon's slop-absorption job: a `.dataPlayedBack`
    /// completion reads ≈ the schedule end by construction, so the field's
    /// 1.0–1.1 s shapes become `remaining < 1.0` → `.finalize` — the
    /// healthy path, one branch earlier. The epsilon stays as
    /// defense-in-depth for WALL-clock fallbacks (and any residual slop),
    /// which is why `remainingSeconds` (not the action set) is what
    /// changed. `.unmeasured` defaults to `.finalize` exactly like the
    /// pre-2026-09-25 behavior for this completion.
    public static func midFadeActiveEofAction(evidence: CompletionEvidence) -> MidFadeActiveEofAction {
        guard evidence.timeMeasured, evidence.totalSeconds > 0 else { return .finalize }
        if evidence.remainingSeconds < 1.0 { return .finalize }
        if evidence.remainingSeconds <= nearEndFinalizeEpsilonSeconds { return .finalizeNearEnd }
        return .abortKeepActive
    }
}
