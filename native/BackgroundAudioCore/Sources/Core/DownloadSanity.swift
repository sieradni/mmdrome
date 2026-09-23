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
    /// poison that slips past the loader) — measured position cannot be faked
    public static func isPrematureCompletion(elapsedSeconds: Double, totalSeconds: Double, timeMeasured: Bool, remainingSeconds: Double) -> Bool {
        guard timeMeasured else { return false }
        return remainingSeconds >= 1.0
    }
}
