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
