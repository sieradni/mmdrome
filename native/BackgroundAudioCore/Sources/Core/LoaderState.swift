import Foundation

/// Pure state model for the track-file loader's claim/chain/complete/evict
/// cycle. Deliberately free of any networking machinery so an XCTest target
/// can verify the transition semantics on the host (no URLSession delegate
/// queue involved). `TrackFileLoader` is the thin adapter that binds a real
/// `URLSessionDownloadTask` to this state.
public struct LoaderState<Task> {
    public private(set) var cache: [String: URL] = [:]
    public private(set) var inFlight: [String: Task] = [:]
    public private(set) var pending: [String: [(URL?, Error?) -> Void]] = [:]
    /// Identifies the particular download currently owned by each track id.
    /// A canceled URLSession task may still deliver its completion after a new
    /// fetch has claimed the same id, so completion must be token-checked before
    /// it can clear or populate the replacement request.
    public private(set) var requestIDs: [String: UUID] = [:]
    /// Byte count of each stored cache file, recorded at store time (the loader
    /// is the only place bytes enter the app, so it is also the only moment the
    /// stored byte count is trustworthy — a later disk stat can race a purge).
    /// Audio containers (FLAC/MP4/MPEG) keep their declared duration in the
    /// HEADER, so a truncated download still probes as a full-length file; the
    /// byte count is the evidence the header is lying (2026-09-18 LDM
    /// multi-skip). Absent entry = unknown (older entries, failed stat).
    public private(set) var storedBytes: [String: Int] = [:]

    public init() {}

    public func cached(_ id: String) -> URL? { cache[id] }

    public func isActive(_ id: String) -> Bool { inFlight[id] != nil }

    public func pendingCount(for id: String) -> Int { pending[id]?.count ?? 0 }

    /// Registers an in-flight download. Returns false when `id` is already
    /// active — the caller must `chain` onto the existing task instead of
    /// starting a second download.
    @discardableResult
    public mutating func claim(_ id: String, task: Task, requestID: UUID = UUID()) -> Bool {
        guard inFlight[id] == nil else { return false }
        inFlight[id] = task
        requestIDs[id] = requestID
        return true
    }

    public func isCurrent(_ id: String, requestID: UUID) -> Bool {
        requestIDs[id] == requestID
    }

    /// Queues a completion onto the in-flight download for `id` so it fires
    /// exactly once, in chain order, when the download finishes.
    public mutating func chain(_ id: String, _ completion: @escaping (URL?, Error?) -> Void) {
        pending[id, default: []].append(completion)
    }

    /// Ends the in-flight download for `id` and returns every chained
    /// completion (empty when nothing was pending).
    public mutating func complete(_ id: String, requestID: UUID) -> [(URL?, Error?) -> Void] {
        guard requestIDs[id] == requestID else { return [] }
        inFlight[id] = nil
        requestIDs[id] = nil
        return pending.removeValue(forKey: id) ?? []
    }

    /// Stores a cache entry. Pass `bytes` when the file's byte count is known
    /// (the loader records it right after the move-to-cache); a nil count
    /// clears any previous record — an unknown count must never masquerade as
    /// an old one.
    public mutating func store(_ url: URL, for id: String, bytes: Int? = nil) {
        cache[id] = url
        if let bytes {
            storedBytes[id] = bytes
        } else {
            storedBytes.removeValue(forKey: id)
        }
    }

    /// The recorded byte count for a cache file, matched by URL (the caller
    /// holds the serve URL, not the composite key). nil = file not in the
    /// cache map or count unknown.
    public func storedBytes(forFileAt url: URL) -> Int? {
        for (key, cachedURL) in cache where cachedURL.standardizedFileURL == url.standardizedFileURL {
            return storedBytes[key]
        }
        return nil
    }

    /// Drops everything for `id`. The caller cancels the returned task and
    /// deletes the returned cached file (if any).
    public mutating func evict(_ id: String) -> (task: Task?, url: URL?) {
        let task = inFlight.removeValue(forKey: id)
        requestIDs[id] = nil
        pending.removeValue(forKey: id)
        storedBytes.removeValue(forKey: id)
        return (task, cache.removeValue(forKey: id))
    }
}