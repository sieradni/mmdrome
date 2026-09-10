import Foundation

/// Stream-variant identity for the track-file cache.
///
/// One trackId can hold sonically DIFFERENT bytes: the original file or a
/// server transcode (`format` + `maxBitRate` query on the snapshot URL). The
/// loader used to key by trackId alone, so a raw file downloaded on Wi-Fi
/// kept playing after low-data mode engaged (and vice versa) — the requested
/// URL was never compared against the cached file's origin.
///
/// Quality policy (product decision): an already-loaded variant is PRESERVED
/// unless the request is HIGHER quality, which UPGRADES (evict +
/// re-download). Never re-download just to downgrade — bandwidth first. Raw
/// outranks every transcode; transcodes rank by bitrate cap; a same-rate
/// different-format tie serves the cached bytes (equivalent tier, no
/// re-download).
public enum TrackVariant: Sendable, Hashable {
    case raw
    case transcode(format: String, maxBitRate: Int)

    /// Derives the variant from a snapshot stream URL. Only the `format` /
    /// `maxBitRate` query items matter — auth tokens, `estimateContentLength`
    /// and friends must never fork the cache identity. An absent or empty
    /// `format` is the original file; a missing or unparseable bitrate falls
    /// back to the client's default cap (128, matching transcodePolicy.ts) so
    /// the key stays deterministic for every URL shape.
    public init(url: URL) {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            self = .raw
            return
        }
        let format = (items.first(where: { $0.name == "format" })?.value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !format.isEmpty else {
            self = .raw
            return
        }
        let bitrate = items.first(where: { $0.name == "maxBitRate" })?.value.flatMap(Int.init) ?? 0
        self = .transcode(format: format, maxBitRate: bitrate > 0 ? bitrate : 128)
    }

    /// Canonical cache-identity fragment: "raw" or "mp3@64".
    public var key: String {
        switch self {
        case .raw:
            return "raw"
        case .transcode(let format, let maxBitRate):
            return "\(format)@\(maxBitRate)"
        }
    }

    /// Quality rank for the preserve-unless-upgrade rule. Raw is unbeatable;
    /// transcodes compare by bitrate cap.
    public var rank: Int {
        switch self {
        case .raw:
            return Int.max
        case .transcode(_, let maxBitRate):
            return maxBitRate
        }
    }
}

/// Serves the cached variant iff it satisfies the request under the
/// preserve-unless-upgrade rule (equal or higher quality). False means the
/// request must re-download (upgrade, or nothing cached).
public func shouldServeCached(cached: TrackVariant, requested: TrackVariant) -> Bool {
    cached.rank >= requested.rank
}

/// Composite loader-cache key. The on-disk filename hashes this (stable FNV —
/// same input ⇒ same file across launches, TODO 4.5a). The pair is
/// constructed, never parsed, except for the same-track prefix scan in the
/// loader's evict path.
public func transcodeCacheKey(trackId: String, variant: TrackVariant) -> String {
    "\(trackId)|\(variant.key)"
}
