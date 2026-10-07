import Foundation

/// Seek-capability declaration, decoded from the JS snapshot (2026-10-07,
/// Phase 0/2 of `docs/plans/2026-10-07-seek-intent-and-stream-epochs.md`).
///
/// JS DECLARES, NATIVE EXECUTES: the web bundle derives this from the SAME
/// transcode decision that built the row's URL (one source of truth) and the
/// engine reads it as a hint only — the RUNTIME verdict (below) is the
/// authority, so a wrong `canServerOffset` costs one wasted request and can
/// never play the wrong bytes.
public struct SeekCapability: Equatable {
    /// The server will re-encode from an offset (the engine still verifies).
    public let canServerOffset: Bool
    /// Container proven splice-safe for a raw epoch ("flac" | "ogg"); Phase 3.
    public let clientSplice: String?
    /// The Subsonic offset parameter name (Navidrome `timeOffset`).
    public let paramName: String?
    public let sourceBitrate: Int?
    public let sourceFileType: String?

    public init(
        canServerOffset: Bool,
        clientSplice: String? = nil,
        paramName: String? = nil,
        sourceBitrate: Int? = nil,
        sourceFileType: String? = nil
    ) {
        self.canServerOffset = canServerOffset
        self.clientSplice = clientSplice
        self.paramName = paramName
        self.sourceBitrate = sourceBitrate
        self.sourceFileType = sourceFileType
    }

    /// Decodes the snapshot field. An absent or malformed dict returns nil —
    /// the engine then takes the Phase-1 (position-preserving wait) path.
    public init?(dict: [String: Any]) {
        guard let canServerOffset = dict["canServerOffset"] as? Bool else { return nil }
        self.canServerOffset = canServerOffset
        self.clientSplice = dict["clientSplice"] as? String
        self.paramName = dict["paramName"] as? String
        self.sourceBitrate = (dict["sourceBitrate"] as? NSNumber)?.intValue
        self.sourceFileType = dict["sourceFileType"] as? String
    }
}

/// The global kill switch (plan §8). `off` reproduces Phase-1 behavior
/// exactly: a far seek waits position-preserving, opens no epoch and issues no
/// extra request — the field rollback for Phases 2-3 without a release.
public enum SeekEpochMode: String {
    case auto
    case off
}

/// The runtime verdict on an epoch response (plan §2.6). The verdict is the
/// PRIMARY signal, read from the epoch container's own claimed length at the
/// existing first-schedule open boundary — before audio enters the graph.
/// String-raw so the engine's debug state and bridge events carry it verbatim.
public enum SeekEpochVerdict: String, Equatable {
    /// The response starts at (about) the requested offset: `timelineBase = T`.
    case honored
    /// The offset was ignored — the body is the row's ordinary head-first
    /// transfer: rebase to 0 and keep the intent armed (NEVER snap the UI to 0).
    case ignored
    /// Neither band matched: do NOT schedule the epoch (it might be a lying
    /// container). Fall back to the row's normal transfer; the intent stays.
    case unknown
}

/// Pure epoch math for server-offset seeks.
///
/// The coordinate invariant the engine upholds:
/// `absoluteSeconds = timelineBase + localSeconds`, with `localSeconds` never
/// leaving the schedule layer. This core owns the epoch-relative arguments
/// every such site needs, plus the verdict that decides the base.
public enum StreamEpoch {

    /// The Subsonic parameter Navidrome reads as `Request.Offset`.
    public static let offsetParamName = "timeOffset"

    /// Below this forward distance a seek just waits: the epoch's request
    /// overhead (a new job, a fresh header decode) is not worth it. Plan §8
    /// records the knob; raising it trades latency for fewer server jobs.
    public static let minimumOffsetSeconds: Double = 3

    /// The epoch KEY namespace marker (plan §2.7). An epoch transfer's cache
    /// key is derived from — never equal to — the row's own key, so no ledger
    /// (serve / cache / promote / maturation) can confuse the two. The
    /// loader's sweep uses `isEpochKey`, and `servingURL` can never see one
    /// because `state.cache` only ever holds row keys.
    public static let epochKeySuffix = "|epoch-"

    /// The epoch's cache key for a row key + offset. Derived, so the
    /// quarantine property is test-pinned rather than re-derived at each call
    /// site.
    public static func epochKey(_ rowKey: String, offsetSeconds: Int) -> String {
        "\(rowKey)\(epochKeySuffix)\(offsetSeconds)"
    }

    public static func isEpochKey(_ key: String) -> Bool {
        key.contains(epochKeySuffix)
    }

    /// Verdict tolerance: pre-input `-ss` is frame-accurate in practice, but
    /// `timeOffset` is an INTEGER second count, containers round their claims,
    /// and a piped FLAC patches its duration by `Duration - Offset`. The band
    /// is small on purpose — acting on a lying container is the failure this
    /// guards (plan §8: wider = fewer false rebases, more blind trust).
    public static let toleranceFraction: Double = 0.01
    public static let minToleranceSeconds: Double = 2
    public static let maxToleranceSeconds: Double = 20

    /// The integer-second offset an epoch requests. `nil` = no epoch (the
    /// caller waits instead), so a zero/negative/trivial scrub can never open
    /// one.
    public static func offsetSeconds(_ seconds: Double) -> Int? {
        guard seconds.isFinite, seconds >= minimumOffsetSeconds else { return nil }
        let whole = Int(seconds.rounded(.down))
        return whole >= Int(minimumOffsetSeconds) ? whole : nil
    }

    /// The epoch's URL: the row's stream URL with the offset parameter set.
    /// Nil when the offset is not epoch-worthy (see `offsetSeconds`).
    public static func offsetURL(_ url: URL, seconds: Double) -> URL? {
        guard let offset = offsetSeconds(seconds) else { return nil }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var items = components.queryItems ?? []
        items.removeAll { $0.name == offsetParamName }
        items.append(URLQueryItem(name: offsetParamName, value: String(offset)))
        components.queryItems = items
        return components.url
    }

    /// Does this URL carry the transcode params whose offset the server honors?
    /// URL-shape only (`format` present and not `raw`): the direct-play
    /// downgrade (an explicit format equal to the source suffix) is exactly
    /// what the runtime verdict exists to catch, so it is deliberately NOT
    /// predicted here — and `Accept-Ranges` is never consulted (a completed
    /// transcode reports `bytes`, and the header is not CORS-readable).
    public static func supportsServerOffset(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        guard let format = components.queryItems?.first(where: { $0.name == "format" })?.value else { return false }
        let normalized = format.trimmingCharacters(in: .whitespaces).lowercased()
        return !normalized.isEmpty && normalized != "raw"
    }

    /// The verdict band in seconds for a track of this length.
    public static func toleranceSeconds(trackSeconds: Double) -> Double {
        guard trackSeconds > 0 else { return minToleranceSeconds }
        let raw = trackSeconds * toleranceFraction
        return min(max(raw, minToleranceSeconds), maxToleranceSeconds)
    }

    /// The seconds an epoch opened at `offsetSeconds` is expected to carry.
    public static func expectedEpochSeconds(trackSeconds: Double, offsetSeconds: Double) -> Double {
        max(0, trackSeconds - offsetSeconds)
    }

    /// The epoch's expected BYTE count. Fact 21: `estimateContentLength` is
    /// computed from the FULL duration even for offset streams, so an epoch's
    /// announced bytes describe the whole track and every byte-ratio decision
    /// must be epoch-relative (never `delivered/announced` against the row).
    public static func expectedEpochBytes(
        announcedBytes: Double,
        trackSeconds: Double,
        offsetSeconds: Double
    ) -> Double {
        guard announcedBytes > 0, trackSeconds > 0 else { return 0 }
        let ratio = expectedEpochSeconds(trackSeconds: trackSeconds, offsetSeconds: offsetSeconds) / trackSeconds
        return announcedBytes * ratio
    }

    /// The frame ceiling an epoch may promise: its own delivered frames, but
    /// never more than the container claims (a claim short of the expected
    /// epoch is the container's own honesty — respect it).
    ///
    /// Consumed by PHASE 3's bounded-window extension (plan §2.4/§2.9 step 5);
    /// pinned here now so the window logic does not have to invent its ceiling
    /// rule at the call site. Phase 2's engine derives its schedulable end from
    /// the container estimate instead (the served window IS the whole tail).
    public static func epochEndableFrames(containerFrames: Double, expectedEpochFrames: Double) -> Double {
        max(0, min(containerFrames, expectedEpochFrames))
    }

    /// THE verdict (plan §2.6). `containerFrames` is the epoch container's
    /// own claimed length in the epoch file's frame units; `expectedEpochFrames`
    /// is `trackSeconds - offsetSeconds` in the same units; `trackFrames` is
    /// the full track.
    ///
    /// - around the epoch's expected length → offset honored;
    /// - around the track's full length → offset ignored (head-first body);
    /// - anything else → unknown, which must NOT be scheduled (the caller
    ///   falls back to the row's normal transfer with the intent armed).
    public static func offsetHonored(
        containerFrames: Double,
        expectedEpochFrames: Double,
        trackFrames: Double,
        toleranceFrames: Double
    ) -> SeekEpochVerdict {
        guard containerFrames.isFinite, containerFrames > 0, trackFrames > 0 else { return .unknown }
        if containerFrames <= expectedEpochFrames + toleranceFrames { return .honored }
        if containerFrames >= trackFrames - toleranceFrames { return .ignored }
        return .unknown
    }

    /// Does the epoch's own span reach the declared track end? False leaves a
    /// TAIL GAP: the row's remaining seconds still need bytes from the row's
    /// own transfer (the scheduler must not announce the row as complete).
    ///
    /// PHASE 3 rail (plan §2.9 step 5): a bounded window always leaves a tail
    /// to fill, and this is the predicate that says so. Phase 2's epochs are
    /// whole-tail, so nothing calls it yet — pinned by StreamEpochTests so the
    /// window work inherits the rule.
    public static func epochEndIsTrackEnd(
        offsetSeconds: Double,
        epochSeconds: Double,
        declaredTrackSeconds: Double,
        toleranceSeconds: Double
    ) -> Bool {
        guard declaredTrackSeconds > 0 else { return true }
        return offsetSeconds + epochSeconds >= declaredTrackSeconds - toleranceSeconds
    }
}
