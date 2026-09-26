import Foundation
import AVFoundation
import Accelerate
import UIKit
import BackgroundAudioCore

// MARK: - Shared models

public struct NativeTrack {
    public let index: Int
    public let trackId: String
    public let title: String
    public let artist: String
    public let album: String
    public let duration: Double
    /** Server-reported file size in bytes (Subsonic song.size; 0 = unknown).
     *  The loader's truncation gate compares the completed transfer against
     *  it — a truncated file's container still reports more audio than the
     *  delivered bytes contain (FLAC STREAMINFO header, Ogg last-page
     *  granule positions, MP4 moov), so the announced byte count is the
     *  only cut-position-independent honest evidence. */
    public let size: Int
    public let url: URL
    public let coverUrl: URL?
    public let replayGain: Double?
    public let albumReplayGain: Double?

    public init?(from dict: [String: Any], index: Int) {
        guard
            let trackId = dict["trackId"] as? String,
            let title = dict["title"] as? String,
            let artist = dict["artist"] as? String,
            let album = dict["album"] as? String,
            let urlStr = dict["url"] as? String,
            let url = URL(string: urlStr)
        else { return nil }
        self.index = index
        self.trackId = trackId
        self.title = title
        self.artist = artist
        self.album = album
        self.duration = dict["duration"] as? Double ?? 0
        self.size = dict["size"] as? Int ?? 0
        self.url = url
        if let coverStr = dict["coverUrl"] as? String, !coverStr.isEmpty {
            self.coverUrl = URL(string: coverStr)
        } else {
            self.coverUrl = nil
        }
        self.replayGain = dict["replayGain"] as? Double
        self.albumReplayGain = dict["albumReplayGain"] as? Double
    }

    /// Replay gain factor (linear) for the given mode, defaulting to 1.0 when unknown.
    public func replayGainLinear(mode: String) -> Double {
        let gainDb: Double?
        if mode == "track" {
            gainDb = replayGain
        } else if mode == "album" {
            gainDb = albumReplayGain
        } else {
            gainDb = nil
        }
        guard let gainDb = gainDb, gainDb.isFinite else { return 1.0 }
        return pow(10.0, gainDb / 20.0)
    }
}

public struct NativeFilterConfig {
    public let type: String
    public let frequency: Double
    public let gain: Double
    public let q: Double
    public let enabled: Bool

    public init(from dict: [String: Any]) {
        self.type = dict["type"] as? String ?? "peaking"
        self.frequency = dict["frequency"] as? Double ?? 1000
        self.gain = dict["gain"] as? Double ?? 0
        self.q = dict["q"] as? Double ?? 0.7071067811865476
        self.enabled = dict["enabled"] as? Bool ?? true
    }
}

public enum NativeLoopMode: String {
    case none = "none"
    case one = "one"
    case all = "all"
}

public struct NativeEngineState {
    public let index: Int
    public let trackId: String
    public let position: Double
    public let duration: Double
    public let playing: Bool
    public let speed: Double
}

// MARK: - Track file loader

/// Downloads remote stream URLs into the caches directory so they can be scheduled
/// on AVAudioPlayerNode via AVAudioFile (which requires local file URLs).
final class TrackFileLoader {
    /// All loader bookkeeping lives here; this class only binds a real
    /// URLSessionDownloadTask to it. Main-thread-only — see `prefetch`.
    private var state = LoaderState<URLSessionDownloadTask>()
    /// Resumable downloads (2026-09-21, the "discarding delivered bytes on a
    /// flaky interface is a subpar response" review): retained clean-close
    /// prefixes per composite cache key — the loader keeps a `.part` file
    /// and continues it with `Range: bytes=<offset>-` instead of starting
    /// over. Loud failures carry URLSession's own opaque `resumeData` in
    /// the completion's error userInfo (no delegate needed — the block API
    /// delivers it). Main-thread-only like everything else in the loader.
    private var pendingParts: [String: DownloadResume.Pending] = [:]
    private var resumeDataByCacheKey: [String: Data] = [:]
    /// Keys whose server answered 200 (full body) to a Range request — that
    /// server does not support ranges, so retaining prefixes for them would
    /// loop replace→close→retain forever. Sticky until a download succeeds.
    private var rangeUnsupportedKeys: Set<String> = []
    /// Maturation byte floor (2026-09-24 field dump, the playable→headered
    /// downgrade): the 1 s maturation tick feeds `received` from the
    /// in-flight task's counter alone. A resumed attempt (Range-append or
    /// opaque resumeData) restarts that counter at 0 — the tick saw a
    /// `playable` entry drop to `headered` with `received=0 announced=?`,
    /// because the LEDGER key is the cache key (one maturation per track
    /// across attempts). The floor seeds the tick's effective byte count
    /// with the bytes ALREADY on disk (the retained prefix the resume
    /// continues), so stage transitions stay monotonic across attempt
    /// boundaries. Recorded at the error/early-close retention sites,
    /// cleared on promote / evict / cleanup / prune.
    private var maturationByteFloor: [String: Int64] = [:]
    /// Diagnostic sink (2026-09-19): the loader's gate verdicts ride the
    /// engine's structured event log instead of bare prints. Level only —
    /// the domain is fixed ("loader"); set by the engine at init.
    var eventSink: ((NativeEvent.Level, String) -> Void)?
    private func event(_ level: NativeEvent.Level, _ message: String) {
        eventSink?(level, message)
    }
    /// Live counts for the debug snapshot (no file I/O — pure state reads).
    func stats() -> (cached: Int, inFlight: Int) {
        (state.cache.count, state.inFlight.count)
    }
    /// True while a staged stream writer owns a key (the engine's retry
    /// consults it before restarting a staged load).
    var hasActiveWriter: Bool { streamWriter != nil }
    /// Dump-visible scratch count: keys with a retained clean-close prefix
    /// or an opaque resumeData offer (a stuck resume shows up here as a
    /// nonzero count that never drains).
    var pendingResumeScratchCount: Int {
        pendingParts.count + resumeDataByCacheKey.count
    }

    /// Scratch offers whose cache entry is gone (Caches purge between
    /// retain and resume). `evict` drops the maps by key, but a purge
    /// removes the FILES without touching these maps — the offer then
    /// points at nothing. Called from `cleanup` (the per-load radius
    /// sweep): the offer's own destination is the evidence — no file → no
    /// continuation is possible (planNextAttempt's rangeAppend would
    /// request from an offset that reads into nothing; the attempt's own
    /// body-replace fallback recovers, but the phantom inflates the
    /// dump-visible scratch count and races a concurrent writer's remove)
    /// — drop the map entries so the next attempt plans FRESH honestly.
    func prunePhantomResumeState() {
        // Snapshot the keys: mutating a dictionary while iterating its own
        // keys view is a Swift hazard (the indices invalidate under us).
        for key in Array(pendingParts.keys) where destinationByKey[key] == nil {
            pendingParts[key] = nil
            maturationByteFloor[key] = nil
        }
        for key in Array(resumeDataByCacheKey.keys) where destinationByKey[key] == nil {
            resumeDataByCacheKey[key] = nil
        }
        rangeUnsupportedKeys = rangeUnsupportedKeys.filter { destinationByKey[$0] != nil }
    }
    /// Fired on the MAIN thread the moment a download's bookkeeping settles:
    /// (trackId, succeeded). The engine's 1 s sampler only sees downloads
    /// in flight AT tick time — a download that starts and finishes between
    /// two ticks (fast LAN, small transcoded file) never fires a progress
    /// event, so the engine hooks THIS to announce `done`/`gone` instantly
    /// (the "preload indicators stay empty" report, 2026-09-14).
    var onDownloadFinished: ((String, Bool) -> Void)?
    /// In-flight download progress counters per composite cache key, read by
    /// the engine's 1 s preload-progress sampler (TODO: parity with the web
    /// preloader's queue-row tints). URLSessionDownloadTask exposes no
    /// progress callback — its `countOfBytes*` properties are the only
    /// readable source.
    var inFlightProgress: [(key: String, trackId: String, received: Int64, expected: Int64?)] {
        state.inFlight.map { key, task in
            (key, trackId(of: key), task.countOfBytesReceived, task.countOfBytesExpectedToReceive > 0 ? task.countOfBytesExpectedToReceive : nil)
        }
    }
    /// Variant served per composite cache key (transcodeCacheKey) — the
    /// preserve-unless-upgrade serve check needs each file's origin variant.
    private var variantOf: [String: TrackVariant] = [:]
    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        return URLSession(configuration: config)
    }()

    // MARK: Resumable downloads — pure-decision helpers

    /// The `.part` scratch URL for a destination (same directory; hidden
    /// from serving — `servingURL` only reads `state.cache`).
    private func partURL(for destination: URL) -> URL {
        destination.appendingPathExtension("part")
    }

    /// Retained-prefix byte count for a destination, or nil. Reads the
    /// `.part` file if the pending state claims one (a purged scratch file
    /// invalidates the claim).
    private func retainedPartBytes(for destination: URL, cacheKey: String) -> Int64? {
        guard let pending = pendingParts[cacheKey], !pending.parts.isEmpty,
              !pending.fromOpaqueResumeData else { return nil }
        let attrs = try? FileManager.default.attributesOfItem(atPath: partURL(for: destination).path)
        let size = (attrs?[.size] as? Int64) ?? 0
        return size > 0 ? size : nil
    }

    private func dropPending(cacheKey: String, destination: URL) {
        pendingParts[cacheKey] = nil
        try? FileManager.default.removeItem(at: partURL(for: destination))
    }

    // MARK: Maturation staging (A15 Phase 1 — events only, inert otherwise)

    /// Per-key maturation state: last known stage + the last byte count at
    /// which a header probe ran (the probe cadence is log, not per-tick).
    /// Main-thread-only like all loader state.
    private var maturationStages: [String: Maturation.Stage] = [:]
    private var maturationLastProbeAt: [String: Int64] = [:]

    // MARK: Streaming writer (A15 Phase 2) — direct-tap staged loads

    /// One in-flight staged load. The writer appends server bytes into the
    /// SAME `.part` scratch the downloadTask retention uses, so a stalled
    /// stream and a failed download share ONE continuation substrate
    /// (`pendingParts` → Range-append). Main-thread-owned state; file I/O
    /// happens on the stream session's serial delegate queue.
    struct StreamWriter {
        let cacheKey: String
        let track: NativeTrack
        let destination: URL
        let part: URL
        let requestID: UUID
        let claimedAt: Date
        var announcedBytes: Int64      // captured from the response headers
        var accumulatedBytes: Int64 = 0
        var lastDeliveredAt: Int64 = 0
        var deliveredPlayable = false
        /// IN-LOADER CONTINUATION (2026-09-24): bytes already on disk from
        /// the attempt this writer CONTINUES. `accumulatedBytes` starts here
        /// and the delegate's per-task counter is ADDED — every byte
        /// comparison (the verdict, the gates, the schedule estimate, the
        /// arrival ledger) sees the MERGED file, never the remainder alone.
        var resumeOffset: Int64 = 0
        /// How many in-loader continuations this track's writer has already
        /// used. Caps the recovery loop: a server that accepts the Range and
        /// closes early at the same offset forever would otherwise cycle a
        /// request per timeout indefinitely — past the cap the failure
        /// yields to the JS retry (its own reload ladder terminates).
        var continuationAttempt: Int = 0
        /// NETWORK EVIDENCE (2026-09-25): the attempt's response fingerprint
        /// (status + Connection/Content-Length/Content-Range/Accept-Ranges/
        /// Content-Type). Captured per attempt in the delegate's response
        /// hop; logged verbatim at the early close so a dump can confirm or
        /// rule out Wi-Fi data assist / proxies (`Connection: close` from a
        /// path that should keep-alive is the verdict signal).
        var responseFingerprint: DownloadResume.ResponseFingerprint? = nil
    }

    private var streamWriter: StreamWriter? = nil
    private var streamWriterTask: URLSessionDataTask? = nil
    private var streamWriterHandle: FileHandle? = nil
    /// Prefetch requests that arrived while the writer owned the key: they
    /// chain onto the writer's final verdict (deliver(nil, err) or the
    /// promoted destination) instead of starting a parallel download.
    private var streamWriterChains: [String: [(URL?, Error?) -> Void]] = [:]

    /// The stream session — the writer NEEDS progressive byte callbacks,
    /// which the block-based downloadTask API doesn't offer. The delegate
    /// instance is held so `streamLoad` can hand it the opened file handle.
    /// Its queue is serial by default, so `didReceive data` appends are
    /// ordered.
    private lazy var streamSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        let delegate = StreamWriterDelegate()
        delegate.owner = self
        streamWriterDelegate = delegate
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }()
    private var streamWriterDelegate: StreamWriterDelegate? = nil

    /// Recent-transfer bandwidth estimate (bytes/second) from the last
    /// successful download — evidence for the slow-link decision. Nil until
    /// the first download of the session lands (no evidence → the slow-link
    /// mode stays on the full-download path; conservative default).
    private(set) var recentTransferRate: Double? = nil
    private var claimAt: [String: Date] = [:]

    /// A multi-delivery progress report for a staged load.
    struct StreamProgress {
        let trackId: String
        let url: URL
        let stage: StreamSchedule.Stage
        let deliveredBytes: Int64
        let announcedBytes: Int64
    }

    /// The full streaming policy gate: should THIS direct tap stream instead
    /// of full-download? Streaming is FULLY INTEGRATED (2026-09-21 user
    /// decision — the off/slowLink/on setting was removed as unnecessary UI;
    /// every eligible raw tap streams): the gate is per-tap eligibility only
    /// (variant, in-flight, scratch, range support, size/duration evidence).
    /// The engine asks; the loader owns the evidence; the eligibility list
    /// is the contract.
    func streamDecision(for track: NativeTrack) -> Bool {
        let requested = TrackVariant(url: track.url)
        // Transcodes keep the full-download path in Phase 2: their announced
        // length is a server-side estimate, which the honesty contract (the
        // schedule ends inside delivered bytes, judged against an exact
        // announced total) cannot use.
        guard requested == .raw else { return false }
        let cacheKey = transcodeCacheKey(trackId: track.trackId, variant: requested)
        // A downloadTask already owns this key (preload chain, Range
        // continuation): never race it with a second byte stream.
        guard !state.isActive(cacheKey) else { return false }
        // Scratch state means the NEXT attempt is a Range continuation — the
        // resumable download path owns this round.
        guard pendingParts[cacheKey] == nil, resumeDataByCacheKey[cacheKey] == nil else { return false }
        // A server that ignored Range once cannot guarantee stream forward
        // progress (the give-up recovery would re-download whole).
        guard !rangeUnsupportedKeys.contains(cacheKey) else { return false }
        // An active writer for another track: one writer at a time (direct
        // taps are serial — the user taps one row).
        guard streamWriter == nil else { return false }
        // Unknown byte size or duration: no lead estimate → no streaming
        // (no evidence, no action — the standing principle).
        guard track.size > 0, track.duration > 0 else { return false }
        return true
    }

    /// Starts a staged load for `track`: a dataTask whose delegate appends
    /// bytes into the `.part` scratch as they arrive. `onProgress` fires on
    /// MAIN at the PLAYABLE crossing and each 512 KB rung after it; the
    /// engine schedules/extends from the growing file. `onFinished` fires
    /// once on MAIN: the promoted destination (gate chain passed — identical
    /// to a downloadTask success) or an error (scratch retained for the
    /// Range-continue path).
    func streamLoad(
        _ track: NativeTrack,
        onProgress: @escaping (StreamProgress) -> Void,
        onFinished: @escaping (StreamProgress?, Error?) -> Void,
        onArrival: @escaping (Int64) -> Void
    ) {
        let requested = TrackVariant(url: track.url)
        let cacheKey = transcodeCacheKey(trackId: track.trackId, variant: requested)
        let destination = Self.destinationURL(for: track, variant: requested)
        let part = partURL(for: destination)
        let requestID = UUID()
        // A pre-existing .part from a previous retention must not be appended
        // onto (the writer writes from scratch — a pendingPart here would
        // have made streamDecision false, but a race guard costs nothing).
        try? FileManager.default.removeItem(at: part)
        var writer = StreamWriter(
            cacheKey: cacheKey,
            track: track,
            destination: destination,
            part: part,
            requestID: requestID,
            claimedAt: Date(),
            announcedBytes: requested == .raw ? Int64(track.size) : 0)
        let handle: FileHandle
        do {
            let parent = destination.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: part.path) {
                FileManager.default.createFile(atPath: part.path, contents: nil)
            }
            handle = try FileHandle(forWritingTo: part)
        } catch {
            event(.danger, "stream: writer open failed for \(track.trackId): \(error.localizedDescription) — full-download fallback")
            onFinished(nil, error)
            return
        }
        streamWriterHandle = handle
        streamWriter = writer
        claimAt[cacheKey] = writer.claimedAt
        destinationByKey[cacheKey] = destination
        var request = URLRequest(url: track.url)
        request.timeoutInterval = 120
        // Materialize the session FIRST (F2, 2026-09-22 field dump): the
        // lazy init is what creates `streamWriterDelegate`. The old order —
        // attach before first touch — attached the handle to NIL on the
        // session's FIRST-ever stream (the delegate didn't exist yet), then
        // the lazy init minted a fresh delegate with no handle, and every
        // `didReceive data` hit `guard let handle else { return }` — the
        // writer "ran" while dropping ALL bytes (the dump's attempt 1:
        // "writer started", then total silence — no schedule, no maturation,
        // no bytes, for 74 s until the user's seek forced attempt 2, where
        // the now-existing delegate attached fine and everything worked).
        let task = streamSession.dataTask(with: request)
        streamWriterDelegate?.attach(handle)
        // The multi-delivery closures ride the writer struct: main-thread
        // updates happen in the delegate hop (didReceive data → main), which
        // calls writerDidReceiveBytes/writerDidComplete below.
        streamProgressHandler = onProgress
        streamFinishedHandler = onFinished
        streamArrivalHandler = onArrival
        streamWriterTask = task
        task.resume()
    }

    private var streamProgressHandler: ((StreamProgress) -> Void)? = nil
    private var streamFinishedHandler: ((StreamProgress?, Error?) -> Void)? = nil
    /// Fires on MAIN for EVERY byte arrival (not just 512 KB rung crossings):
    /// the engine's stall-resume decision and give-up timer key on RAW
    /// progress — gating them on rungs starved a resuming trickle stream for
    /// tens of seconds and killed making-progress streams as "no progress"
    /// (F2, design review). Cheap per-arrival struct updates only.
    private var streamArrivalHandler: ((Int64) -> Void)? = nil

    /// MAIN: the response header landed — the server's own Content-Length
    /// refines the snapshot's size estimate for the schedule math, and the
    /// status code classifies a CONTINUATION's answer (206 = the remainder;
    /// anything else = the server ignored the range → fresh overwrite).
    func writerDidReceiveResponse(announced: Int64, statusCode: Int) {
        guard var writer = streamWriter else { return }
        if writer.resumeOffset > 0, statusCode != 206 {
            // The continuation's request was answered with a NON-range body
            // (a plain 200 = the WHOLE file from byte 0). Appending it
            // splices prefix+full, and TRUNCATING the live .part races the
            // delegate queue (bytes already appended before the truncate
            // both poison the file and overcount the counter past file
            // truth — the gates would pass on a lie). The only safe
            // response: ABORT to a fresh download — discard the scratch
            // (bytes appended from a whole-file body cannot be separated
            // from the prefix), mark the key Range-unsupported (the
            // eligibility guard then never continues on this server
            // again), and hand the row to the retry path, whose prefetch
            // plans FRESH. The queued cancel-completion is silenced AND
            // neutralized: handlers nil'd first, the stored writer's
            // accumulatedBytes zeroed (the error branch's retention guard
            // is `> 0`), streamWriter nil'd so writerDidComplete early-
            // returns.
            event(.danger, "stream: continuation answered \(statusCode) (range ignored) for \(writer.track.trackId) — scratch destroyed, fresh download (no in-writer overwrite)")
            rangeUnsupportedKeys.insert(writer.cacheKey)
            let offsetForLog = writer.accumulatedBytes
            let chains = streamWriterChains.removeValue(forKey: writer.cacheKey) ?? []
            let engineFinished = streamFinishedHandler
            streamProgressHandler = nil
            streamFinishedHandler = nil
            streamArrivalHandler = nil
            streamWriterTask?.cancel()
            pendingParts[writer.cacheKey] = nil
            maturationByteFloor[writer.cacheKey] = nil
            try? FileManager.default.removeItem(at: writer.part)
            // NO main-thread close here: the delegate queue may hold queued
            // writes for this handle, and FileHandle.write on a closed
            // handle raises. The delegate closes its own handle in
            // didCompleteWithError — ordered AFTER every write on the
            // serial queue — and the queued cancel-completion then hops to
            // main, where writerDidComplete early-returns (streamWriter is
            // already nil). The loader's handle copy is dropped WITHOUT
            // closing (the delegate owns the close).
            streamWriterHandle = nil
            streamWriter = nil
            streamWriterTask = nil
            claimAt.removeValue(forKey: writer.cacheKey)
            let fallback = NSError(domain: "mmdrome.loader", code: -7004, userInfo: [NSLocalizedDescriptionKey: "Stream cut short (\(offsetForLog) of \(writer.announcedBytes) bytes, range unsupported): \(writer.track.title)"])
            for chain in chains { chain(nil, fallback) }
            engineFinished?(nil, fallback)
            onDownloadFinished?(writer.track.trackId, false)
            return
        }
        guard announced > 0 else { return }
        // A 206's Content-Length is the REMAINDER — never let it shrink the
        // announced total (the verdict + gates judge the MERGED bytes against
        // the ORIGINAL transfer's total).
        if writer.resumeOffset > 0, announced < writer.announcedBytes { return }
        writer.announcedBytes = announced
        streamWriter = writer
    }

    /// MAIN: recompute the stage after a byte arrival and deliver when the
    /// writer policy says so. Called from the delegate hop.
    func writerDidReceiveBytes(_ received: Int64) {
        guard var writer = streamWriter else { return }
        // MERGED math: the task's counter is the remainder only on a
        // continuation — add the prefix offset so every downstream consumer
        // (verdict, gates, estimate, arrival ledger) sees whole-file bytes.
        writer.accumulatedBytes = writer.resumeOffset + received
        let track = writer.track
        let lead = StreamPolicy.effectiveLeadSeconds(trackDuration: track.duration)
        let leadBytes = MaturationStageSupport.bytesForLeadWithFallback(
            fileBytes: Int64(track.size), duration: track.duration, leadSeconds: lead)
        // F2 (design review): EVERY arrival feeds the engine's progress
        // ledger (stall resume + give-up timer) — rung-gated deliveries alone
        // starved a resuming trickle stream for tens of seconds and let the
        // give-up timer kill streams that WERE making progress.
        streamArrivalHandler?(writer.accumulatedBytes)
        let merged = writer.accumulatedBytes
        // COUNTER TRUTH (2026-09-25 dump — the "repeatedly skipping" report):
        // the writer state is stored on EVERY arrival. The old code advanced
        // accumulatedBytes ONLY inside the rung-delivery branch, so the
        // counter ran up to one 512 KB rung behind the on-disk .part (the
        // delegate writes per byte) — and the early-close verdict then
        // compared the COUNTER against the DISK: the continuation's Range
        // offset never matched the scratch size, every continuation aborted
        // as a "size mismatch", destroyed a ~97 %-complete file, and the row
        // cycled JS retries into give-up skips (all four dump gaps were
        // < 524288 B: 348007/67429/4691, 400136/285044/389678, 231941/510469
        // /196099). The rung gate paces PROGRESS DELIVERIES (the extension
        // channel's cadence) — it must never quantize the byte COUNT, which
        // is the completion verdict's and the continuation offset's truth.
        streamWriter = writer
        let shouldDeliver = StreamPolicy.writerShouldDeliver(
            accumulatedBytes: merged,
            leadRequiredBytes: leadBytes,
            lastDeliveredAt: writer.lastDeliveredAt)
        guard shouldDeliver else { return }
        writer.deliveredPlayable = true
        writer.lastDeliveredAt = merged
        streamWriter = writer
        streamProgressHandler?(StreamProgress(
            trackId: writer.track.trackId,
            url: writer.part,
            stage: .playable,
            deliveredBytes: merged,
            announcedBytes: writer.announcedBytes))
    }

    /// NETWORK EVIDENCE: the attempt's response fingerprint arrived on main
    /// — store it on the live writer (replaces any prior attempt's; the
    /// early-close log reports the LAST response, the one that ended the
    /// transfer).
    func writerDidReceiveFingerprint(_ fp: DownloadResume.ResponseFingerprint) {
        guard var writer = streamWriter else { return }
        writer.responseFingerprint = fp
        streamWriter = writer
    }

    /// MAIN: the transfer ended (cleanly or with an error). Run the writer's
    /// completion verdict: promote through the SAME gate chain as a download,
    /// or retain the scratch for Range-continue.
    ///
    /// HANDLER-DELIVERY ORDER (F1, 2026-09-22 field dump): `clearWriterState`
    /// used to run BEFORE the verdict — but it nils `streamFinishedHandler`,
    /// so every subsequent `streamFinishedHandler?(...)` call was a silent
    /// no-op: the loader promoted/retained/error'd, and the ENGINE never
    /// heard a word. Row 4 of the dump played the full symptom: delivered ==
    /// announced → promotion succeeded in the loader → engine never told →
    /// its staged schedule stayed non-complete → the playhead hit the
    /// delivered end → buffering stall at the LAST tick → 10 s give-up → JS
    /// retry — for a file that was already fully downloaded. The handlers
    /// are captured BEFORE any state clears; `clearWriterState` runs after.
    func writerDidComplete(_ error: Error?) {
        guard var writer = streamWriter else { return }
        // Capture the engine legs up front (F1): the verdict branches below
        // may run async work before delivering; state clears must never
        // precede a delivery that still needs the handler.
        let onFinished = streamFinishedHandler
        let handle = streamWriterHandle
        streamWriterHandle = nil
        try? handle?.close()
        // The writer state stays live through the whole verdict below (the
        // promotion path reads writer.announcedBytes etc.), so the maps are
        // cleared HERE, explicitly, not in a defer that would run before the
        // body finished reading them. Handler STORAGE is nil'd here (hygiene:
        // no stale closures retained past the writer's life) — this is safe
        // ONLY because every delivery below goes through the `onFinished`
        // CAPTURE, not the storage. That ordering is the F1 invariant.
        func clearWriterState() {
            streamWriter = nil
            streamWriterTask = nil
            streamProgressHandler = nil
            streamFinishedHandler = nil
            streamArrivalHandler = nil
            claimAt.removeValue(forKey: writer.cacheKey)
        }
        if let error {
            clearWriterState()
            event(.danger, "stream: writer failed for \(writer.track.trackId): \(error.localizedDescription) — scratch retained (\(writer.accumulatedBytes)B)")
            // Range-continue substrate: identical to a downloadTask loud-fail
            // minus the opaque resumeData (a dataTask has none — the .part
            // prefix IS the resume state).
            if writer.accumulatedBytes > 0 {
                pendingParts[writer.cacheKey] = DownloadResume.Pending(
                    parts: [writer.accumulatedBytes],
                    announcedTotal: writer.announcedBytes)
                // The byte floor seeds the maturation tick across the
                // upcoming resume attempt (whose task counter restarts at 0).
                maturationByteFloor[writer.cacheKey] = writer.accumulatedBytes
            }
            flushWriterChains(key: writer.cacheKey, url: nil, error: error)
            clearWriterState()
            onFinished?(nil, error)
            onDownloadFinished?(writer.track.trackId, false)
            return
        }
        // DISK TRUTH AT THE VERDICT (2026-09-25, the "repeatedly skipping"
        // dump's phantom): the counter is per-byte now, but this verdict is
        // where a counter regression does the most damage — the dump's
        // rung-lagged counter judged COMPLETE files (disk == announced,
        // exactly, three attempts running) "cut short" and the continuation
        // guard destroyed them. The disk is the delivered truth: a short
        // verdict with the announced body already on disk PROMOTES (the
        // gate chain below re-judges the file — no gate is skipped). Its
        // danger line is by definition a REGRESSION ALARM — report the
        // dump. Disk < counter stays untrusted (a file smaller than the
        // counted bytes is corruption, never promoted on a lie).
        if writer.announcedBytes > 0, writer.accumulatedBytes < writer.announcedBytes {
            let onDisk = (try? FileManager.default.attributesOfItem(atPath: writer.part.path)[.size] as? Int64) ?? 0
            if onDisk >= writer.announcedBytes {
                event(.danger, "stream: counter \(writer.accumulatedBytes)B trails disk \(onDisk)B (announced \(writer.announcedBytes)B) for \(writer.track.trackId) — DISK TRUTH wins, promoting (counter/verdict divergence is a regression alarm)")
                writer.accumulatedBytes = onDisk
            }
        }
        // Clean end: judge completeness against the announced body.
        let verdict = StreamPolicy.writerCompleteVerdict(
            accumulatedBytes: writer.accumulatedBytes,
            announcedBytes: writer.announcedBytes)
        switch verdict {
        case .promote:
            clearWriterState()
            // Promote the .part to the destination and run the SAME gate
            // chain a download passes (min-bytes → decodability → byte-exact
            // announced). Resume changes how a download recovers; the gates
            // decide what counts as complete — unchanged here.
            do {
                let size = writer.accumulatedBytes
                if size < TrackFileLoader.minimumAudioBytes {
                    event(.danger, "stream: promoted body under \(TrackFileLoader.minimumAudioBytes)B for \(writer.track.trackId) — rejecting")
                    try? FileManager.default.removeItem(at: writer.part)
                    let err = NSError(domain: "mmdrome.loader", code: -7001, userInfo: [NSLocalizedDescriptionKey: "Streamed file truncated (\(size) bytes): \(writer.track.title)"])
                    flushWriterChains(key: writer.cacheKey, url: nil, error: err)
                    clearWriterState()
                    onFinished?(nil, err)
                    onDownloadFinished?(writer.track.trackId, false)
                    return
                }
                if FileManager.default.fileExists(atPath: writer.destination.path) {
                    try FileManager.default.removeItem(at: writer.destination)
                }
                try FileManager.default.moveItem(at: writer.part, to: writer.destination)
                let probeFrames = (try? AVAudioFile(forReading: writer.destination).length) ?? 0
                guard probeFrames > 0 else {
                    event(.danger, "stream: promoted file decodes to 0 frames for \(writer.track.trackId) — rejecting")
                    try? FileManager.default.removeItem(at: writer.destination)
                    let err = NSError(domain: "mmdrome.loader", code: -7002, userInfo: [NSLocalizedDescriptionKey: "Streamed file is not decodable audio: \(writer.track.title)"])
                    flushWriterChains(key: writer.cacheKey, url: nil, error: err)
                    clearWriterState()
                    onFinished?(nil, err)
                    onDownloadFinished?(writer.track.trackId, false)
                    return
                }
                if DownloadSanity.isShortOfAnnouncedBytes(actualBytes: Int(size), announcedBytes: writer.announcedBytes) {
                    event(.danger, "stream: promoted body short of announced (\(size) of \(writer.announcedBytes)) for \(writer.track.trackId) — retaining for Range-continue")
                    try? FileManager.default.moveItem(at: writer.destination, to: writer.part)
                    pendingParts[writer.cacheKey] = DownloadResume.Pending(parts: [size], announcedTotal: writer.announcedBytes)
                    maturationByteFloor[writer.cacheKey] = size
                    let err = NSError(domain: "mmdrome.loader", code: -7004, userInfo: [NSLocalizedDescriptionKey: "Stream cut short (\(size) of \(writer.announcedBytes) bytes): \(writer.track.title)"])
                    flushWriterChains(key: writer.cacheKey, url: nil, error: err)
                    clearWriterState()
                    onFinished?(nil, err)
                    onDownloadFinished?(writer.track.trackId, false)
                    return
                }
                // All gates passed: promote. Identical bookkeeping to a
                // downloadTask success.
                let elapsed = max(0.05, Date().timeIntervalSince(writer.claimedAt))
                recentTransferRate = Double(size) / elapsed
                resumeDataByCacheKey[writer.cacheKey] = nil
                rangeUnsupportedKeys.remove(writer.cacheKey)
                maturationByteFloor[writer.cacheKey] = nil
                dropPending(cacheKey: writer.cacheKey, destination: writer.destination)
                state.store(writer.destination, for: writer.cacheKey, bytes: Int(size))
                variantOf[writer.cacheKey] = TrackVariant(url: writer.track.url)
                event(.info, "stream: promoted \(writer.track.trackId) (\(size)B, \(probeFrames) frames) — cache entry complete")
                flushWriterChains(key: writer.cacheKey, url: writer.destination, error: nil)
                let final = StreamProgress(
                    trackId: writer.track.trackId,
                    url: writer.destination,
                    stage: .complete,
                    deliveredBytes: size,
                    announcedBytes: writer.announcedBytes)
                clearWriterState()
                onFinished?(final, nil)
                onDownloadFinished?(writer.track.trackId, true)
            } catch {
                event(.danger, "stream: promotion failed for \(writer.track.trackId): \(error.localizedDescription)")
                flushWriterChains(key: writer.cacheKey, url: nil, error: error)
                clearWriterState()
                onFinished?(nil, error)
                onDownloadFinished?(writer.track.trackId, false)
            }
        case .earlyClose:
            // The chains ride a LOCAL (2026-09-24): the continuation below
            // re-attaches them to the new writer; the error branches flush
            // them directly — a map lookup would miss what this case already
            // removed.
            let chains = streamWriterChains.removeValue(forKey: writer.cacheKey) ?? []
            let err = NSError(domain: "mmdrome.loader", code: -7004, userInfo: [NSLocalizedDescriptionKey: "Stream cut short (\(writer.accumulatedBytes) of \(writer.announcedBytes) bytes): \(writer.track.title)"])
            let diskAtClose = (try? FileManager.default.attributesOfItem(atPath: writer.part.path)[.size] as? Int64) ?? 0
            if writer.accumulatedBytes >= TrackFileLoader.minimumAudioBytes {
                let fpLine = writer.responseFingerprint.map { " [" + DownloadResume.responseFingerprintLine($0) + "]" } ?? ""
                event(.danger, "stream: clean early close for \(writer.track.trackId) (counter \(writer.accumulatedBytes)B, disk \(diskAtClose)B of announced \(writer.announcedBytes)B)\(fpLine) — scratch retained, next attempt Range-resumes")
                pendingParts[writer.cacheKey] = DownloadResume.Pending(
                    parts: [writer.accumulatedBytes],
                    announcedTotal: writer.announcedBytes)
                maturationByteFloor[writer.cacheKey] = writer.accumulatedBytes
                // IN-LOADER CONTINUATION (2026-09-24 dump-1, the "crossfade
                // stop, cycles at 0-1 s" report): an ACTIVE track's early
                // close used to deliver -7004 to the JS retry machine, whose
                // reload re-engages from 0:00 — each cycle replayed the tiny
                // staged lead (1.2 s), streamed to the same ~95 % mark, died
                // again. With a live staged schedule we now OWN the recovery:
                // re-request the remainder with `Range: bytes=<delivered>-`
                // and append into the SAME .part the staged schedule reads.
                // Audio never stops; when the merged bytes pass the promote
                // gates the normal completion fires and the natural end is
                // restored. The writer's chains (prefetch claims on this
                // key) re-attach — they follow the writer's final verdict.
                // Guarded on Range support (a 200-answering server would
                // re-deliver the WHOLE body into the append — double bytes).
                if DownloadResume.writerContinuationEligible(
                    offset: writer.accumulatedBytes,
                    hasRetainedPart: FileManager.default.fileExists(atPath: writer.part.path)),
                   !rangeUnsupportedKeys.contains(writer.cacheKey),
                   // LOOP CAP (2026-09-24 design review): a server that
                   // accepts the Range and closes at the same offset forever
                   // would cycle one request per timeout indefinitely. Past
                   // the cap the failure yields to the JS retry (its own
                   // ladder terminates — bounded above, never an infinite
                   // silent loop).
                   writer.continuationAttempt < 3 {
                    startWriterContinuation(writer: writer, chained: chains)
                } else {
                    event(.info, "stream: continuation unavailable for \(writer.track.trackId) (range ignored, cap, or no scratch) — handing to the JS retry")
                    for chain in chains { chain(nil, err) }
                    clearWriterState()
                    onFinished?(nil, err)
                    onDownloadFinished?(writer.track.trackId, false)
                }
            } else {
                // Nothing usable delivered: no scratch to continue (a
                // zero-byte Range resume would re-download from 0 anyway).
                event(.danger, "stream: clean early close for \(writer.track.trackId) with only \(writer.accumulatedBytes)B — nothing retained, next attempt starts fresh")
                try? FileManager.default.removeItem(at: writer.part)
                for chain in chains { chain(nil, err) }
                clearWriterState()
                onFinished?(nil, err)
                onDownloadFinished?(writer.track.trackId, false)
            }
        case nil:
            // No announced length: the byte verdict cannot run. Treat the
            // transfer's end as final and judge through the decodability
            // gate only (an honest server without Content-Length is rare;
            // the header-claim vs delivered estimate still bounded every
            // schedule made from this file).
            do {
                let size = writer.accumulatedBytes
                if FileManager.default.fileExists(atPath: writer.destination.path) {
                    try FileManager.default.removeItem(at: writer.destination)
                }
                try FileManager.default.moveItem(at: writer.part, to: writer.destination)
                let probeFrames = (try? AVAudioFile(forReading: writer.destination).length) ?? 0
                guard probeFrames > 0, size >= TrackFileLoader.minimumAudioBytes else {
                    try? FileManager.default.removeItem(at: writer.destination)
                    let err = NSError(domain: "mmdrome.loader", code: -7002, userInfo: [NSLocalizedDescriptionKey: "Streamed file is not decodable audio: \(writer.track.title)"])
                    flushWriterChains(key: writer.cacheKey, url: nil, error: err)
                    clearWriterState()
                    onFinished?(nil, err)
                    onDownloadFinished?(writer.track.trackId, false)
                    return
                }
                // TRANSCODE DURATION CORROBORATION at the stream promote
                // boundary (same rationale as the download path): a socket-cut
                // transcode promoted on decodability alone would poison the
                // cache as "complete" and later die mid-fade as a standby.
                // RAW streams stay exempt (container claim is full; a
                // mis-tagged duration must not false-reject) — variant decides.
                let probeSampleRate = (try? AVAudioFile(forReading: writer.destination).fileFormat.sampleRate) ?? 0
                let writerVariant = TrackVariant(url: writer.track.url)
                if DownloadSanity.transcodeDurationCorroborated(
                    probeFrames: probeFrames,
                    sampleRate: probeSampleRate,
                    metadataDuration: writer.track.duration,
                    transcode: writerVariant != .raw) {
                    event(.danger, "stream: promoted transcode cut short (container claim \(String(format: "%.1f", Double(probeFrames) / max(1, probeSampleRate)))s of metadata \(String(format: "%.1f", writer.track.duration))s) for \(writer.track.trackId) — rejecting, scratch retained")
                    try? FileManager.default.moveItem(at: writer.destination, to: writer.part)
                    pendingParts[writer.cacheKey] = DownloadResume.Pending(
                        parts: [Int64(size)],
                        announcedTotal: 0)
                    let err = NSError(domain: "mmdrome.loader", code: -7003, userInfo: [NSLocalizedDescriptionKey: "Transcode cut short (container claims \(Int(Double(probeFrames) / max(1, probeSampleRate)))s of \(Int(writer.track.duration))s): \(writer.track.title)"])
                    flushWriterChains(key: writer.cacheKey, url: nil, error: err)
                    clearWriterState()
                    onFinished?(nil, err)
                    onDownloadFinished?(writer.track.trackId, false)
                    return
                }
                state.store(writer.destination, for: writer.cacheKey, bytes: Int(size))
                variantOf[writer.cacheKey] = TrackVariant(url: writer.track.url)
                event(.info, "stream: promoted \(writer.track.trackId) (\(size)B, no announced length — decodability-gated)")
                flushWriterChains(key: writer.cacheKey, url: writer.destination, error: nil)
                let final = StreamProgress(
                    trackId: writer.track.trackId,
                    url: writer.destination,
                    stage: .complete,
                    deliveredBytes: size,
                    announcedBytes: 0)
                clearWriterState()
                onFinished?(final, nil)
                onDownloadFinished?(writer.track.trackId, true)
            } catch {
                flushWriterChains(key: writer.cacheKey, url: nil, error: error)
                clearWriterState()
                onFinished?(nil, error)
                onDownloadFinished?(writer.track.trackId, false)
            }
        }
    }

    /// IN-LOADER RANGE CONTINUATION for a failed ACTIVE stream (2026-09-24
    /// dump-1): re-request the remainder (`Range: bytes=<delivered>-`) and
    /// append into the SAME .part the staged schedule reads. Audio never
    /// stops, the staged schedule's track-id guards stay valid (same track),
    /// and no JS retry round trip restarts the track at 0:00. Runs entirely
    /// on main: the writer verdict was main, and the new task's deliveries
    /// re-enter the same writerDidReceiveBytes/writerDidComplete hops. The
    /// resumed writer carries `resumeOffset` so every byte comparison sees
    /// the MERGED file; a 200 answer is converted to a fresh overwrite by
    /// writerDidReceiveResponse. Failure (reopen) falls back to the OLD
    /// recovery — the JS retry's reload prefetch Range-continues the
    /// retained prefix.
    private func startWriterContinuation(writer: StreamWriter, chained: [(URL?, Error?) -> Void]) {
        let offset = writer.accumulatedBytes
        let track = writer.track
        event(.info, "stream: writer continuation for \(track.trackId) — counter offset \(offset)B, continuing from disk truth — same .part, staged schedule undisturbed")
        // The old handle is ALREADY closed (the delegate closed it at
        // completion). Reopen for append — same permissions the writer had.
        var reopenedHandle: FileHandle?
        var continueFrom = writer.accumulatedBytes
        do {
            let h = try FileHandle(forWritingTo: writer.part)
            reopenedHandle = h
            // APPEND SEMANTICS (adversarial trace 2026-09-24): FileHandle
            // (forWritingTo:) positions at BYTE 0 — writing without seeking
            // would overwrite the retained prefix from its first byte (the
            // spliced-file poison class, and the byte COUNTER would still
            // report the full total, passing the gates on a lie).
            let onDisk = (try? FileManager.default.attributesOfItem(atPath: writer.part.path)[.size] as? Int64) ?? 0
            // DISK-FIRST CONTINUATION (2026-09-25 dump — the "repeatedly
            // skipping" report): `offset` is the SCHEDULING counter, the
            // disk is the DELIVERED truth. The old `onDisk == offset` guard
            // inverted that trust: a normal rung-short close (onDisk >
            // offset) aborted EVERY continuation, destroyed the ~97 %-
            // complete scratch, and cycled JS retries into give-up skips
            // (every dump gap was < 524288 B — one delivery rung). The file
            // can only be REJECTED when it cannot support the offset:
            // SMALLER (purged/truncated flush, phantom retention — the
            // splice class the 2026-09-24 trace guarded) or PAST the
            // announced total (cross-attempt corruption). onDisk > offset
            // is the NORMAL shape and continues.
            guard onDisk >= offset, writer.announcedBytes <= 0 || onDisk <= writer.announcedBytes else {
                try? h.close()
                event(.danger, "stream: continuation aborted — scratch \(onDisk)B cannot support offset \(offset)B (announced \(writer.announcedBytes)B) for \(track.trackId) — scratch destroyed, fresh download")
                // The scratch is UNTRUSTWORTHY (purged or truncated mid-
                // flush): retaining pendingParts would send the JS retry's
                // download path Range-continuing from a phantom offset —
                // the splice again. Destroy the retention so its prefetch
                // plans FRESH (retainedPartBytes also self-defends by
                // reading the file, but the map must not outlive the
                // evidence).
                pendingParts[writer.cacheKey] = nil
                maturationByteFloor[writer.cacheKey] = nil
                try? FileManager.default.removeItem(at: writer.part)
                abortContinuation(writer: writer, chained: chained)
                return
            }
            // Continue from the FILE's end: the Range request re-fetches
            // from the true delivered mark, not the counter's.
            try h.seekToEndOfFile()
            continueFrom = onDisk
        } catch {
            // Fallback = the OLD recovery: the JS retry re-engages and its
            // reload's prefetch continues the retained prefix. The reopen
            // detail rides the log; the RETRY sees the underlying -7004 (the
            // failure reason the retry machine is entitled to act on). The
            // handle may be OPEN here (seek threw after a successful open)
            // — close it before aborting or the FD leaks.
            try? reopenedHandle?.close()
            event(.danger, "stream: continuation reopen failed for \(track.trackId): \(error.localizedDescription) — handing to the JS retry")
            abortContinuation(writer: writer, chained: chained)
            return
        }
        // Every failure path above returns; reaching here means the reopen
        // and the append-seek both succeeded.
        guard let handle = reopenedHandle else { return }
        var request = URLRequest(url: track.url)
        request.timeoutInterval = 120
        request.setValue(DownloadResume.rangeHeader(offset: continueFrom), forHTTPHeaderField: "Range")
        let task = streamSession.dataTask(with: request)
        // Reset the delegate's counter: this task delivers the REMAINDER.
        streamWriterDelegate?.attach(handle)
        streamWriterHandle = handle
        streamWriterTask = task
        // The RESUMED writer: accumulated bytes continue from the DISK mark
        // so the verdict/gates/estimate all judge the merged file. The rung
        // ledger seeds there too (the next delivery is the next 512 KB rung
        // above it), and the attempt counter arms the loop cap.
        var resumed = writer
        resumed.resumeOffset = continueFrom
        resumed.accumulatedBytes = continueFrom
        resumed.lastDeliveredAt = continueFrom
        resumed.continuationAttempt += 1
        streamWriter = resumed
        // Defensive bookkeeping parity with streamLoad: a state key without
        // a destination would read as a phantom (the prune filter).
        destinationByKey[writer.cacheKey] = writer.destination
        // The chains re-attach: they follow THIS writer's final verdict
        // (promote → destination, or a later error).
        streamWriterChains[writer.cacheKey] = chained
        task.resume()
    }

    /// The -7004 error the early-close verdict built — re-created for the
    /// reopen-failure fallback so both recoveries report the SAME failure
    /// shape to the JS retry machine.
    private func lastContinuationError(_ writer: StreamWriter) -> Error {
        NSError(domain: "mmdrome.loader", code: -7004, userInfo: [NSLocalizedDescriptionKey: "Stream cut short (\(writer.accumulatedBytes) of \(writer.announcedBytes) bytes): \(writer.track.title)"])
    }

    /// The continuation-abort fallback (reopen failure, size mismatch): the
    /// JS retry re-engages and its reload's prefetch Range-continues the
    /// retained prefix. The engine leg is captured BEFORE the state clears
    /// (the F1 ordering); the clears are INLINED here because
    /// `clearWriterState` is a writerDidComplete-local nested func — calling
    /// it from here would not compile.
    private func abortContinuation(writer: StreamWriter, chained: [(URL?, Error?) -> Void]) {
        let fallback = lastContinuationError(writer)
        let engineFinished = streamFinishedHandler
        streamWriter = nil
        streamWriterTask = nil
        streamProgressHandler = nil
        streamFinishedHandler = nil
        streamArrivalHandler = nil
        claimAt.removeValue(forKey: writer.cacheKey)
        for chain in chained { chain(nil, fallback) }
        engineFinished?(nil, fallback)
        onDownloadFinished?(writer.track.trackId, false)
    }


    private func flushWriterChains(key: String, url: URL?, error: Error?) {
        let chains = streamWriterChains.removeValue(forKey: key) ?? []
        for chain in chains { chain(url, error) }
    }

    /// Engine-facing give-up (A15 Phase 2, the stall contract): cancel the
    /// active writer WITHOUT the engine seeing a second error — the monitor
    /// tick's `onError` is the single report, the JS retry re-engages, and
    /// the writer's own completion path (didCompleteWithError, fired by
    /// cancel()) records the delivered prefix into `pendingParts` so the
    /// retry's prefetch Range-continues it instead of re-downloading from
    /// zero. Without this, a stalled stream kept running and its next 512 KB
    /// rung re-scheduled a STAGED schedule from 0:00 behind the retry —
    /// the restart-from-the-beginning bug class, resurrected.
    func cancelActiveWriterRetainingScratch() {
        guard streamWriter != nil else { return }
        // Silence the ENGINE legs first (nil both handlers): the completion
        // that cancel() triggers must not deliver to onFinished/onProgress —
        // the monitor already reported, and a second report would double-
        // engage the JS retry. The loader-side bookkeeping still runs.
        streamProgressHandler = nil
        streamFinishedHandler = nil
        streamArrivalHandler = nil
        streamWriterTask?.cancel()
    }

    /// Advances the maturation state for one in-flight key and reports
    /// TRANSITIONS as structured events (Phase 1's entire purpose: the ring
    /// carries the staged model's field evidence before the engine consumes
    /// any of it). Called from the engine's 1 s preload sampler — same
    /// cadence, no new timer.
    func tickMaturation() {
        for (key, trackId, received, expected) in inFlightProgress {
            let previous = maturationStages[key] ?? .empty
            // RESUMED ATTEMPTS (2026-09-24 dump): a Range/resumeData restart
            // re-zeroes the task's own byte counter. Seed the tick's effective
            // byte count with the retained prefix (the floor recorded at the
            // last retention) so the stage never DOWNgrades mid-track — the
            // ledger is per cache key, one maturation across attempts.
            let floor = maturationByteFloor[key] ?? 0
            let effectiveReceived = max(received, floor)
            // Lead requirement: Phase 1 uses the policy minimum over the
            // track's metadata duration (the conservative default); a real
            // per-track decision arrives with Phase 2 wiring.
            let track = trackForId(trackId)
            let lead = StreamPolicy.effectiveLeadSeconds(trackDuration: track?.duration ?? 0)
            let leadBytes = MaturationStageSupport.bytesForLeadWithFallback(
                fileBytes: Int64(track?.size ?? 0),
                duration: track?.duration ?? 0,
                leadSeconds: lead)
            let probed: Bool
            let probeSaysAudio: Bool
            if Maturation.shouldProbeHeader(received: effectiveReceived, lastProbedAt: maturationLastProbeAt[key] ?? 0, leadRequiredBytes: leadBytes) {
                maturationLastProbeAt[key] = effectiveReceived
                // The probe: an AVAudioFile open over the CURRENT cache
                // destination (the in-flight task is a downloadTask; its
                // temp file is not readable by us). Only keys with a
                // destination on disk can be probed; the downloadTask temp
                // is off-limits, so a HEADERED verdict is deferred to the
                // completion path for direct downloads. The .part resume
                // prefix, however, IS readable — probe it when present.
                if let part = partScratchURL(forKey: key) , FileManager.default.fileExists(atPath: part.path) {
                    let frames = (try? AVAudioFile(forReading: part).length) ?? 0
                    probeSaysAudio = frames > 0
                    probed = true
                } else {
                    probed = false
                    probeSaysAudio = false
                }
            } else {
                probed = false
                probeSaysAudio = false
            }
            let stage = Maturation.stage(
                received: effectiveReceived,
                announced: expected ?? 0,
                leadRequiredBytes: leadBytes,
                headerProbeSaysAudio: probed ? probeSaysAudio : (previous == .headered || previous == .playable))
            // MONOTONIC CLAMP (2026-09-24 dump): the ledger is per cache key
            // ACROSS attempts, and a resumed attempt (Range or opaque
            // resumeData) restarts its byte counter at 0 — the tick saw
            // playable→headered with `received=0`. A legit regression cannot
            // reach this tick (evict resets the ledger explicitly), so a
            // downgrade here is always a resume artifact: hold the previous
            // stage (maturation is diagnostic-only — Phase 1 contract) until
            // the new attempt re-earns it. Floors above cover the Range
            // attempts; this clamp covers opaque resumeData, whose delivered
            // count is unknowable.
            if stage != previous {
                func rank(_ s: Maturation.Stage) -> Int {
                    switch s {
                    case .empty: return 0
                    case .headered: return 1
                    case .playable: return 2
                    case .complete: return 3
                    }
                }
                if rank(stage) < rank(previous) { continue }
                maturationStages[key] = stage
                event(.info, "maturation \(previous)→\(stage) track=\(trackId) received=\(effectiveReceived) announced=\(expected.map(String.init) ?? "?")")
            }
        }
    }

    /// The .part scratch URL for a cache key, if one is being retained.
    private func partScratchURL(forKey key: String) -> URL? {
        guard let destination = destinationByKey[key] else { return nil }
        let part = partURL(for: destination)
        return FileManager.default.fileExists(atPath: part.path) ? part : nil
    }

    /// Destinations recorded at prefetch start (the key alone cannot rebuild
    /// the URL — the file extension comes from the track's URL). Pruned in
    /// evict.
    private var destinationByKey: [String: URL] = [:]

    /// The queued track for a trackId (nil if gone from the queue).
    private func trackForId(_ trackId: String) -> NativeTrack? {
        engineTrackLookup?(trackId)
    }
    /// Injected by the engine at init (it owns the queue).
    var engineTrackLookup: ((String) -> NativeTrack?)?

    /// The maturation stages map — dump-visible (a staged model that never
    /// leaves `empty` on a slow link is field-diagnosable).
    var maturationSummary: [String: String] {
        maturationStages.mapValues { "\($0)" }
    }

    // MARK: Native decode probe (2026-09-21 — evidence, not a table)

    /// Downloads a tiny sample of `sampleURL` (a low-bitrate server-side
    /// transcode — same shape as the web probe's request) and hands the REAL
    /// bytes to AVAudioFile, the exact decoder the playback graph uses.
    /// Two-phase, mirroring `formatProbe.ts`: transport failures and error
    /// bodies answer `network` (never persisted, retried next boot); only
    /// bytes the decoder actually opened and read produce `ok`/`unsupported`.
    func probeDecode(sampleURL: URL, completion: @escaping (_ verdict: String, _ detail: String) -> Void) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 15
        let probeSession = URLSession(configuration: config)
        let task = probeSession.dataTask(with: sampleURL) { body, response, error in
            // Deliberately NOT main-thread-bound: the probe is independent of
            // the audio graph; the completion hops wherever the caller needs.
            guard error == nil, let http = response as? HTTPURLResponse else {
                completion("network", error?.localizedDescription ?? "no response")
                return
            }
            let status = http.statusCode
            guard let body, !body.isEmpty else {
                completion("network", "http \(status) empty body")
                return
            }
            let verdict = DecodeProbe.classifyTransportWithMinimum(statusCode: status, bodyBytes: body)
            switch verdict {
            case .network:
                completion("network", "http \(status) body \(body.count)B (error payload or too small)")
                return
            case .unsupported(let reason):
                completion("unsupported", reason)
                return
            case .ok:
                break // real media bytes — proceed to the decoder
            }
            let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("mmprobe-").appendingPathExtension("bin")
            do {
                try body.write(to: tmp, options: .atomic)
            } catch {
                completion("network", "sample write failed: \(error.localizedDescription)")
                return
            }
            defer { try? FileManager.default.removeItem(at: tmp) }
            var decodeError: String?
            var frames: Int64 = 0
            do {
                let audio = try AVAudioFile(forReading: tmp)
                frames = audio.length
                if frames > 0 {
                    // Read a frame to force real demux work (length alone can
                    // trust the header; a frame read exercises the decoder).
                    guard let format = try? AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: audio.fileFormat.sampleRate, channels: max(1, audio.fileFormat.channelCount), interleaved: false) else {
                        throw NSError(domain: "mmdrome.probe", code: 1)
                    }
                    let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)
                    if let buf { try audio.read(into: buf) }
                }
            } catch {
                decodeError = error.localizedDescription
            }
            let verdict2 = DecodeProbe.classifyDecode(decodeError: decodeError, decodedFrames: frames)
            switch verdict2 {
            case .ok(let f):
                completion("ok", "\(f) frames decoded by AVAudioFile")
            case .unsupported(let reason):
                completion("unsupported", reason)
            case .network:
                completion("network", "unexpected transport verdict in decode phase")
            }
        }
        task.resume()
    }

    /// Serve check under the preserve-unless-upgrade rule (TrackVariant): the
    /// exact variant when cached, else the best cached variant of this track
    /// whose quality covers the request. A cached LOWER variant never
    /// satisfies a higher request — that path re-downloads (upgrade).
    private func servingURL(forTrackId trackId: String, requested: TrackVariant) -> URL? {
        let prefix = trackId + "|"
        var best: (variant: TrackVariant, url: URL)?
        for (key, url) in state.cache {
            guard key.hasPrefix(prefix), let variant = variantOf[key] else { continue }
            guard shouldServeCached(cached: variant, requested: requested) else { continue }
            if let current = best {
                if variant.rank > current.variant.rank {
                    best = (variant, url)
                }
            } else {
                best = (variant, url)
            }
        }
        return best?.url
    }

    func localURL(for track: NativeTrack) -> URL? {
        if track.url.isFileURL { return track.url }
        return servingURL(forTrackId: track.trackId, requested: TrackVariant(url: track.url))
    }

    /// The byte count recorded when the file was stored (nil = unknown).
    /// Read by the engine's schedule clamp — the header of a truncated
    /// download still claims the original duration, the byte count is the
    /// evidence.
    func storedBytes(forFileAt url: URL) -> Int? {
        state.storedBytes(forFileAt: url)
    }

    func prefetch(_ track: NativeTrack, completion: @escaping (URL?, Error?) -> Void) {
        // Every completion is delivered on the main thread, including cache hits.
        // Capacitor invokes plugin methods on its bridge queue, while the audio
        // graph, loader state, and crossfade timers are main-thread-owned.
        let deliver: (URL?, Error?) -> Void = { url, error in
            if Thread.isMainThread {
                completion(url, error)
            } else {
                DispatchQueue.main.async {
                    completion(url, error)
                }
            }
        }
        if track.url.isFileURL {
            deliver(track.url, nil)
            return
        }
        // Variant-aware serve (preserve-unless-upgrade): a cached raw file
        // satisfies a later transcode request, and a cached HIGHER transcode
        // satisfies a lower one — no re-download just to downgrade.
        let requested = TrackVariant(url: track.url)
        if let url = servingURL(forTrackId: track.trackId, requested: requested) {
            // 2026-09-17 multi-skip hardening: the multi-skip cascade served
            // TRUNCATED cached files as good. A cache entry below the smallest
            // plausible audio file is a poisoned partial download — never
            // deliver it; evict so the fetch below re-downloads fresh bytes
            // (no minimum existed: error==nil only proves the transfer
            // completed, not that the bytes are audio). A missing file
            // (Caches purge between lookup and read) also fails the size read.
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
            // 2026-09-18: the byte count recorded at store time is the
            // SECOND half of the serve check — a file the disk has since
            // PURGED-down (or one stored before the count existed) fails the
            // stat and falls back to the store-time record; both must clear
            // the server-length gate before serving.
            let recorded = state.storedBytes(forFileAt: url) ?? size
            if size >= TrackFileLoader.minimumAudioBytes,
               !DownloadSanity.isTruncatedAgainstServer(storedBytes: recorded, serverLength: requested == .raw ? Int64(track.size) : 0) {
                deliver(url, nil)
                return
            }
            self.event(.danger, "cache file rejected at serve (size \(size), recorded \(recorded)) for \(track.trackId) — evicting partial")
            evict(track.trackId, variant: requested)
        }
        let cacheKey = transcodeCacheKey(trackId: track.trackId, variant: requested)
        if let writer = streamWriter, writer.cacheKey == cacheKey {
            // The STREAM WRITER owns this key (Phase 2 direct tap in flight):
            // chain onto its final verdict instead of racing a second byte
            // stream. Chained calls receive the promoted destination (gate
            // chain passed) or the failure error — the same shape the
            // downloadTask in-flight chain delivers.
            streamWriterChains[cacheKey, default: []].append(deliver)
            return
        }
        if state.isActive(cacheKey) {
            // A download for this track+VARIANT is already in flight (started
            // by `prefetchUpcoming`). Chain onto it instead of dropping the
            // completion: `loadAndStart` only schedules its track once this
            // fires, so a dropped callback leaves the engine silently stalled.
            // A different variant in flight does NOT satisfy this request —
            // its key differs, so claiming below downloads in parallel rather
            // than chaining onto the wrong bytes.
            state.chain(cacheKey, deliver)
            return
        }

        let destination = Self.destinationURL(for: track, variant: requested)
        let requestID = UUID()
        // The server's announced byte count for the gate at completion time.
        // The snapshot's `size` is the ORIGINAL file's size: exact for raw
        // streams (the only mode where the gate applies — a transcode's
        // Content-Length is a server-side estimate and must not be judged
        // against the source's bytes; its truncations are caught by the
        // elapsed gate instead). 0 disables the server-length gate.
        let expectedBytes: Int64 = requested == .raw ? Int64(track.size) : 0
        // RESUMABLE DOWNLOADS (2026-09-21, the "discarding delivered bytes on
        // a flaky interface is a subpar response" review): pick the
        // continuation BEFORE building the task. Three shapes, decided by the
        // pure `DownloadResume` core: URLSession's own opaque resumeData
        // (loud failures — the system reassembles internally), a Range
        // append onto a retained clean-close prefix (the Connectivity-Assist
        // shape), or a fresh full download. Established mechanisms, no bytes
        // wasted, and every gate below still runs on the FINAL bytes —
        // resume changes how a download RECOVERS, never what counts as
        // complete.
        let continuation = DownloadResume.planNextAttempt(
            pending: pendingParts[cacheKey],
            opaqueResumeData: resumeDataByCacheKey[cacheKey])
        if case .fresh = continuation {
            // Stale scratch state must not survive into a fresh attempt.
            resumeDataByCacheKey[cacheKey] = nil
            dropPending(cacheKey: cacheKey, destination: destination)
        }
        var request: URLRequest? = nil
        var resumeData: Data? = nil
        switch continuation {
        case .fresh:
            request = URLRequest(url: track.url)
        case .opaqueResume:
            // URLSession's own continuation: the opaque data carries the
            // system's internal byte accounting, which a hand-built Range
            // request cannot see. Consumed below via
            // downloadTask(withResumeData:).
            resumeData = resumeDataByCacheKey[cacheKey]
            self.event(.info, "resume: opaque resumeData (\(resumeData?.count ?? 0)B) for \(track.trackId) (\(requested))")
        case .rangeAppend(let offset):
            var r = URLRequest(url: track.url)
            r.setValue(DownloadResume.rangeHeader(offset: offset), forHTTPHeaderField: "Range")
            request = r
            self.event(.info, "resume: Range bytes=\(offset)- for \(track.trackId) (\(requested))")
        }
        let part = partURL(for: destination)
        destinationByKey[cacheKey] = destination
        // For a Range attempt the response's own Content-Length is the
        // REMAINDER — the byte gate must judge the merged bytes against the
        // ORIGINAL transfer's total (recorded when the prefix was retained).
        let originalAnnounced: Int64 = {
            if case .rangeAppend = continuation { return pendingParts[cacheKey]?.announcedTotal ?? 0 }
            return 0
        }()
        let completionBody: @Sendable (URL?, URLResponse?, Error?) -> Void = { [weak self] tempURL, response, error in
            // Swift 6 capture semantics: `event` is an instance method, and the
            // download completion closure is `@Sendable` — explicit `self.` is
            // required at every call inside it (CI compile finding, 2026-09-20).
            // The diagnostics sink is main-queue-pumped and thread-safe, so the
            // delegate-queue calls here are safe by design.
            // The temp file is only valid until this handler returns. Move it
            // synchronously on the delegate queue before hopping to main — an
            // async hop would let the system delete the temp file first, which
            // is exactly the "couldn't be opened because there is no such file"
            // seen in the HUD. State bookkeeping (isCurrent/complete/store) still
            // happens on main.
            var movedURL: URL? = nil
            var moveError: Error? = nil
            // RESUMABLE: the clean-close retention decision made on this
            // delegate queue is applied to the main-thread state maps in the
            // main hop below (the loader's maps are main-thread-only).
            var retainPending: DownloadResume.Pending? = nil
            if let temp = tempURL, error == nil {
                // RESUMABLE: when this attempt was a Range continuation, the
                // delivered body is the REMAINDER — append it onto the
                // retained prefix BEFORE any validation, then judge only the
                // combined file. A 206 whose Content-Range start does not
                // equal the requested offset, or a plain 200 (server ignored
                // the range), means the body is NOT the remainder: the fresh
                // body REPLACES the prefix (never appended — that would
                // double the bytes).
                var effectiveSize = 0
                if case .rangeAppend(let reqOffset) = continuation, let temp = tempURL {
                    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                    let rangeStart = DownloadResume.parseContentRangeStart(
                        (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Range"))
                    let appendable = DownloadResume.rangeResponseIsAppendable(statusCode: statusCode)
                        && rangeStart == reqOffset
                    if appendable {
                        do {
                            let handle = try FileHandle(forWritingTo: part)
                            defer { try? handle.close() }
                            _ = try handle.seekToEnd()
                            let data = try Data(contentsOf: temp, options: .mappedIfSafe)
                            try handle.write(contentsOf: data)
                            self?.event(.info, "resume: appended \(data.count)B at offset \(reqOffset) for \(track.trackId) (206 aligned)")
                            effectiveSize = Int((try? FileManager.default.attributesOfItem(atPath: part.path)[.size] as? Int64) ?? 0)
                            // The combined file now lives at `part` — judge it
                            // directly (temp is discarded below by moving to
                            // destination first for gate uniformity).
                        } catch {
                            self?.event(.danger, "resume append failed for \(track.trackId): \(error.localizedDescription) — falling back to fresh")
                            try? FileManager.default.removeItem(at: part)
                            effectiveSize = -1 // force the fresh path below
                        }
                    } else {
                        self?.event(.info, "resume: server answered \(statusCode) (start \(rangeStart.map(String.init) ?? "nil"), wanted \(reqOffset)) — range ignored, body REPLACES prefix for \(track.trackId)")
                        try? FileManager.default.removeItem(at: part)
                        self?.rangeUnsupportedKeys.insert(cacheKey)
                    }
                }
                // A range-appended attempt reads its merged bytes from the
                // .part file; fresh/200-replaced attempts move `temp` into
                // the validation pipeline below. `mergeSource` is the file
                // the gates judge.
                var mergeSource: URL? = temp
                if case .rangeAppend(let reqOffset) = continuation,
                   DownloadResume.rangeResponseIsAppendable(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0) {
                    if effectiveSize >= 0, FileManager.default.fileExists(atPath: part.path) {
                        mergeSource = part
                        // Move the merged part into destination for validation
                        // (the gates and AVAudioFile probe work on destination).
                        let parent = destination.deletingLastPathComponent()
                        try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
                        if FileManager.default.fileExists(atPath: destination.path) {
                            try? FileManager.default.removeItem(at: destination)
                        }
                        try? FileManager.default.moveItem(at: part, to: destination)
                        mergeSource = destination
                        _ = reqOffset
                    }
                }
                if let src = mergeSource {
                do {
                    // 2026-09-17 multi-skip hardening: the move-to-cache gate
                    // accepted ANY completed transfer. A truncated download
                    // (server cut, network death after the response header)
                    // then "played" in milliseconds and chained the advance
                    // (the completion cascade). Reject undersized bodies here
                    // so they can never be stored, chained, or tinted done.
                    // Routed through moveError (NOT an early return) so the
                    // main-hop bookkeeping below still runs state.complete +
                    // the error deliver — an early return would leave the
                    // loader's in-flight entry active forever.
                    let attrs = try FileManager.default.attributesOfItem(atPath: src.path)
                    let tempSize = (attrs[.size] as? Int) ?? 0
                    if tempSize < TrackFileLoader.minimumAudioBytes {
                        self?.event(.danger, "download under \(TrackFileLoader.minimumAudioBytes) bytes for \(track.trackId) (got \(tempSize)) — treating as error")
                        try? FileManager.default.removeItem(at: src)
                        if src != temp { try? FileManager.default.removeItem(at: temp) }
                        moveError = NSError(domain: "mmdrome.loader", code: -7001, userInfo: [NSLocalizedDescriptionKey: "Download truncated (\(tempSize) bytes) for \(track.title)"])
                    } else {
                    let parent = destination.deletingLastPathComponent()
                    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
                    if src != destination {
                        if FileManager.default.fileExists(atPath: destination.path) {
                            try FileManager.default.removeItem(at: destination)
                        }
                        do {
                            try FileManager.default.moveItem(at: src, to: destination)
                        } catch {
                            self?.event(.info, "moveItem failed for \(track.trackId) \(error.localizedDescription) — trying copy (volume mismatch workaround)")
                            try FileManager.default.copyItem(at: src, to: destination)
                            try? FileManager.default.removeItem(at: src)
                        }
                    }
                    movedURL = destination
                    // 2026-09-17 design hardening: validate at the TRUST
                    // BOUNDARY. The loader is the only place bytes enter the
                    // app — probe DECODABILITY here, before the file is ever
                    // stored, so the downstream serve/schedule/completion
                    // gates stay pure defense-in-depth (the multi-skip bug
                    // existed because validation lagged the cache). A file
                    // that opens but yields no frames is poison; reject it
                    // exactly like an undersized body.
                    let probeFrames = (try? AVAudioFile(forReading: destination).length) ?? 0
                    if probeFrames <= 0 {
                        self?.event(.danger, "downloaded file decodes to 0 frames for \(track.trackId) — rejecting")
                        try? FileManager.default.removeItem(at: destination)
                        movedURL = nil
                        moveError = NSError(domain: "mmdrome.loader", code: -7002, userInfo: [NSLocalizedDescriptionKey: "Downloaded file is not decodable audio: \(track.title)"])
                    }
                    // 2026-09-18 LDM multi-skip: the gates above prove the
                    // TRANSFER completed, not that it is COMPLETE. A body cut
                    // mid-stream still opens as a "full-length" file — the
                    // container reports more audio than the delivered bytes
                    // contain (FLAC STREAMINFO / MP4 moov duration headers,
                    // Ogg cut inside a final page whose header arrived), so
                    // nothing downstream can tell truncation from truth except
                    // the promised byte count. Compare against the snapshot's
                    // Subsonic `size` (raw only — see expectedBytes above).
                    // 2026-09-21 Connectivity Assist workaround: a CLEAN
                    // early close (server promised Content-Length, sent less,
                    // closed without error) reports success — the error path
                    // never sees it and the 10 % metadata margin above passes
                    // drops up to 10 % of the file into the cache as poison.
                    // The per-transfer announcement IS a promise for raw
                    // streams: enforce it exactly (transcodes excluded —
                    // their announced length is an estimate). Direction-safe
                    // under transparent compression (decompressed ≥ announced).
                    let announcedBytes = requested == .raw
                        ? (originalAnnounced > 0 ? originalAnnounced : (response?.expectedContentLength ?? 0))
                        : 0
                    if moveError == nil, movedURL != nil,
                       DownloadSanity.isShortOfAnnouncedBytes(
                           actualBytes: tempSize,
                           announcedBytes: announcedBytes) {
                        // RESUMABLE (2026-09-21): a clean early close used to
                        // DELETE the delivered bytes and start over — on a
                        // flaky interface one track could re-download from
                        // zero repeatedly. The prefix is retained as the .part
                        // scratch file and the next attempt continues it with
                        // `Range: bytes=<delivered>-` (a 206 aligned answer
                        // appends; anything else replaces the prefix). Raw
                        // streams only: a transcode's announced length is an
                        // estimate and must not anchor a resume. Retention is
                        // bounded by DownloadResume's part cap —
                        // planNextAttempt falls back to fresh there.
                        if requested == .raw && !(self?.rangeUnsupportedKeys.contains(cacheKey) ?? true) {
                            let parent = destination.deletingLastPathComponent()
                            try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
                            if FileManager.default.fileExists(atPath: part.path) {
                                try? FileManager.default.removeItem(at: part)
                            }
                            try? FileManager.default.moveItem(at: destination, to: part)
                            let retainedBytes = (try? FileManager.default.attributesOfItem(atPath: part.path)[.size] as? Int64) ?? 0
                            if retainedBytes > 0 {
                                self?.event(.danger, "clean early close for \(track.trackId) (got \(tempSize) of \(announcedBytes)) — prefix retained (\(retainedBytes)B), next attempt Range-resumes")
                                retainPending = DownloadResume.Pending(parts: [retainedBytes], announcedTotal: announcedBytes)
                            } else {
                                self?.event(.danger, "clean early close for \(track.trackId) but prefix retention failed — full re-download on retry")
                            }
                        } else {
                            self?.event(.danger, "download short of announced Content-Length for \(track.trackId) (got \(tempSize) of \(announcedBytes), no error) — rejecting")
                        }
                        try? FileManager.default.removeItem(at: destination)
                        movedURL = nil
                        moveError = NSError(domain: "mmdrome.loader", code: -7004, userInfo: [NSLocalizedDescriptionKey: "Download cut short (\(tempSize) of \(announcedBytes) bytes): \(track.title)"])
                    }
                    if moveError == nil, movedURL != nil,
                       DownloadSanity.isTruncatedAgainstServer(
                           storedBytes: tempSize,
                           serverLength: expectedBytes) {
                        self?.event(.danger, "download truncated vs server size for \(track.trackId) (got \(tempSize) of \(expectedBytes)) — rejecting")
                        try? FileManager.default.removeItem(at: destination)
                        movedURL = nil
                        moveError = NSError(domain: "mmdrome.loader", code: -7003, userInfo: [NSLocalizedDescriptionKey: "Download truncated vs server size: \(track.title)"])
                    }
                    // TRANSCODE DURATION CORROBORATION (2026-09-23, the LDM
                    // `cannot parse response` post-mortem): a transcode is
                    // exempt from BOTH byte gates (its Content-Length is an
                    // estimate, the snapshot size is the SOURCE's bytes),
                    // which left a socket-cut transcode — decodable to N>0
                    // frames — a COMPLETE cache entry. That poisoned entry
                    // became a fade target whose audio ran out mid-ramp (the
                    // abort-keep-active aborts the D1 watchdog recovers from).
                    // The container claim (AVAudioFile.length over the
                    // delivered bytes — Ogg page granule positions are
                    // accurate per page) corroborated against the metadata
                    // duration is the evidence that survives the estimate
                    // problem: no byte count compared at all. The poisoned
                    // transcode NEVER enters the cache → the standby slot
                    // stays honest (in-flight chain + fade re-check), and the
                    // truncated transfer resumes like any other -7003
                    // rejection.
                    let probeSampleRate = (try? AVAudioFile(forReading: destination).fileFormat.sampleRate) ?? 0
                    if moveError == nil, movedURL != nil, requested != .raw,
                   DownloadSanity.transcodeDurationCorroborated(
                       probeFrames: probeFrames,
                       sampleRate: probeSampleRate,
                       metadataDuration: track.duration,
                       transcode: true) {
                        let claimSeconds = Double(probeFrames) / max(1, probeSampleRate)
                        self?.event(.danger, "download transcode cut short (container claim \(String(format: "%.1f", claimSeconds))s of metadata \(String(format: "%.1f", track.duration))s) for \(track.trackId) — rejecting")
                        try? FileManager.default.removeItem(at: destination)
                        movedURL = nil
                        moveError = NSError(domain: "mmdrome.loader", code: -7003, userInfo: [NSLocalizedDescriptionKey: "Transcode cut short (container claims \(Int(claimSeconds))s of \(Int(track.duration))s): \(track.title)"])
                    }
                    }
                } catch {
                    moveError = error
                    self?.event(.danger, "final store failed for \(track.trackId) dir=\(destination.deletingLastPathComponent().path) err=\(error.localizedDescription) tempExists=\(FileManager.default.fileExists(atPath: temp.path)) destParentExists=\(FileManager.default.fileExists(atPath: destination.deletingLastPathComponent().path))")
                }
                }
            }
            DispatchQueue.main.async { [weak self] in
                guard let self = self else {
                    if let moved = movedURL { try? FileManager.default.removeItem(at: moved) }
                    return
                }
                guard self.state.isCurrent(cacheKey, requestID: requestID) else {
                    if let moved = movedURL { try? FileManager.default.removeItem(at: moved) }
                    return
                }
                let pendings = self.state.complete(cacheKey, requestID: requestID)
                if let moved = movedURL {
                    // RESUMABLE: a completed transfer clears all scratch
                    // state for the key — the next attempt is a plain hit.
                    self.resumeDataByCacheKey[cacheKey] = nil
                    self.rangeUnsupportedKeys.remove(cacheKey)
                    self.dropPending(cacheKey: cacheKey, destination: destination)
                    // Record the delivered byte count at store time — the only
                    // moment it is trustworthy (a later disk stat can race a
                    // Caches purge). The schedule clamp reads it via
                    // `storedBytes(forFileAt:)`.
                    let storedSize = (try? FileManager.default.attributesOfItem(atPath: moved.path)[.size] as? Int) ?? 0
                    self.state.store(moved, for: cacheKey, bytes: storedSize > 0 ? storedSize : nil)
                    self.variantOf[cacheKey] = requested
                    // Bandwidth evidence (F1, design review): the slow-link
                    // decision reads recentTransferRate — it must be fed by
                    // EVERY completed transfer, not only the writer's promote
                    // (a first-session slowLink mode could otherwise never
                    // stream, and a writer-fed rate went stale across the
                    // non-streaming tracks between staged loads). The claim
                    // timestamp is recorded at prefetch start (the same map
                    // the writer uses) and cleared just below.
                    if let startedAt = self.claimAt.removeValue(forKey: cacheKey), storedSize > 0 {
                        let elapsed = max(0.05, Date().timeIntervalSince(startedAt))
                        self.recentTransferRate = Double(storedSize) / elapsed
                    }
                    deliver(moved, nil)
                    pendings.forEach { $0(moved, nil) }
                    self.onDownloadFinished?(track.trackId, true)
                } else {
                    let err = moveError ?? error
                    // The failed attempt consumed its claim timestamp — drop
                    // it so a retained-prefix retry's rate is not measured
                    // across the dead gap.
                    claimAt.removeValue(forKey: cacheKey)
                    // RESUMABLE: a loud failure (connection ripped out) may
                    // carry URLSession's opaque resumeData in the error's
                    // userInfo — the system's own continuation offer. Store it
                    // for the next attempt (planNextAttempt prefers it over a
                    // Range append: the opaque data carries URLSession's
                    // internal byte accounting). A retained clean-close
                    // prefix stands too (retainPending from the gate above).
                    // Both are cleared on eventual success or a fresh-attempt
                    // fallback.
                    if let resume = (err as NSError?)?.userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
                        self.resumeDataByCacheKey[cacheKey] = resume
                    }
                    if let retain = retainPending {
                        self.pendingParts[cacheKey] = retain
                        // Maturation byte floor (2026-09-24): the resumed
                        // attempt's task counter restarts at 0 — seed the
                        // tick with the bytes ALREADY on disk so the stage
                        // cannot downgrade. The clean-close retention knows
                        // its exact count (retainPending.deliveredBytes).
                        if retain.deliveredBytes > 0 {
                            self.maturationByteFloor[cacheKey] = retain.deliveredBytes
                        }
                    }
                    deliver(nil, err)
                    pendings.forEach { $0(nil, err) }
                    self.onDownloadFinished?(track.trackId, false)
                }
            }
        }
        // The SAME completion body drives both task constructors: a plain
        // request (fresh / Range-append) and URLSession's own resumeData
        // continuation — identical gates on the final bytes either way.
        let task: URLSessionDownloadTask = resumeData != nil
            ? session.downloadTask(withResumeData: resumeData!, completionHandler: completionBody)
            : session.downloadTask(with: request!, completionHandler: completionBody)
        if state.claim(cacheKey, task: task, requestID: requestID) {
            // Bandwidth-evidence start time (F1, design review): the
            // completion hop reads this to update recentTransferRate for the
            // slow-link decision. Recorded only when the claim WINS — a
            // chained request never transfers, so its timestamp would poison
            // the rate (claimAt is cleared by the writer paths and evict).
            claimAt[cacheKey] = Date()
            task.resume()
        } else {
            // Unreachable on the main thread (the isActive check above already
            // chained) — defensive: never resume a second download for a
            // claimed key, and never leak the abandoned task.
            task.cancel()
            state.chain(cacheKey, deliver)
        }
    }

    /// Drops cached file(s) for a track and cancels any in-flight fetch for
    /// them so the next prefetch re-fetches from the server. With no variant,
    /// ALL variants go (queue cleanup); pass the scheduled variant to drop one
    /// (the corrupt-file path must not nuke the good variants).
    func evict(_ trackId: String, variant: TrackVariant? = nil) {
        var keys: [String]
        if let variant = variant {
            keys = [transcodeCacheKey(trackId: trackId, variant: variant)]
        } else {
            let prefix = trackId + "|"
            keys = state.cache.keys.filter { $0.hasPrefix(prefix) }
            for key in state.inFlight.keys where key.hasPrefix(prefix) && !keys.contains(key) {
                keys.append(key)
            }
        }
        for key in keys {
            let (task, url) = state.evict(key)
            variantOf.removeValue(forKey: key)
            task?.cancel()
            // PHASE 2: an evicted key that the stream writer owns tears the
            // writer down too — no orphaned byte stream appending into a
            // scratch file the cache has disowned.
            if let writer = streamWriter, writer.cacheKey == key {
                // EVICT TWIN OF BUG G (fixed 2026-09-25): NO main-thread
                // close — the delegate queue may hold queued writes for
                // this handle, and a close that lands between them raises
                // on the delegate (or kills a write the counter already
                // counted). Same contract as the non-206 continuation
                // abort: silence the legs, cancel the task, drop the
                // loader's handle copy WITHOUT closing —
                // didCompleteWithError owns the close, ordered after every
                // write on the serial queue. The completion's main hop
                // early-returns (writer nil'd below) and the pre-captured
                // chains own the delivery.
                streamProgressHandler = nil
                streamFinishedHandler = nil
                streamArrivalHandler = nil
                streamWriterTask?.cancel()
                streamWriterHandle = nil
                streamWriter = nil
                streamWriterTask = nil
                claimAt.removeValue(forKey: key)
                flushWriterChains(key: key, url: nil, error: NSError(domain: "mmdrome.loader", code: -7005, userInfo: [NSLocalizedDescriptionKey: "Streamed load evicted: \(trackId)"]))
                try? FileManager.default.removeItem(at: writer.part)
            }
            streamWriterChains.removeValue(forKey: key)
            // RESUMABLE: scratch state is keyed per cache key — drop it with
            // the cache entry or a stale prefix/offer survives into the next
            // fetch (and the .part file lingers on disk).
            pendingParts[key] = nil
            resumeDataByCacheKey[key] = nil
            rangeUnsupportedKeys.remove(key)
            maturationStages[key] = nil
            maturationLastProbeAt[key] = nil
            maturationByteFloor[key] = nil
            destinationByKey[key] = nil
            if let url = url {
                try? FileManager.default.removeItem(at: url)
                try? FileManager.default.removeItem(at: partURL(for: url))
            }
        }
    }

    /// Cache entries whose size falls below this are partial downloads —
    /// never served, never stored, always evicted (2026-09-17 multi-skip:
    /// the cascade served truncated preloaded files as good).
    static let minimumAudioBytes = 4096

    /// The trackId fragment of a composite cache key ("trackId|variant").
    private func trackId(of cacheKey: String) -> String {
        guard let idx = cacheKey.firstIndex(of: "|") else { return cacheKey }
        return String(cacheKey[cacheKey.startIndex..<idx])
    }

    /// Cached composite keys — read by the engine's preload-progress sampler
    /// to distinguish "download finished" (key present) from "evicted/gone".
    var cacheKeys: Set<String> { Set(state.cache.keys) }

    /// F4 (2026-09-22 field dump): the ACTIVE WRITER's byte progress, read
    /// by the engine's 1 s sampler exactly like `inFlightProgress`. The
    /// writer is a dataTask with a delegate — it NEVER appears in
    /// `state.inFlight` (that map holds downloadTasks only) — so streamed
    /// tracks were invisible to the progress channel: no queue-row tint, no
    /// seek-bar loaded layer, for the entire stream (the "no visual for
    /// loaded/buffered" report). Nil when no writer is live.
    var writerProgress: (key: String, trackId: String, received: Int64, expected: Int64?)? {
        guard let writer = streamWriter else { return nil }
        return (writer.cacheKey, writer.track.trackId, writer.accumulatedBytes,
                writer.announcedBytes > 0 ? writer.announcedBytes : nil)
    }

    /// Deletes cached files for tracks that are no longer within `keepRadius` of `currentIndex`.
    func cleanup(currentIndex: Int, tracks: [NativeTrack], keepRadius: Int = 3) {
        let minIndex = currentIndex - keepRadius
        let maxIndex = currentIndex + keepRadius
        for track in tracks where track.index < minIndex || track.index > maxIndex {
            evict(track.trackId)
        }
        // Phantom resume offers (2026-09-24 dump, loaderPendingResume=3):
        // offers whose destination file is gone (Caches purge between retain
        // and resume) can never continue — drop their map entries so the
        // dump-visible scratch count stays truthful and the next attempt
        // plans fresh honestly.
        prunePhantomResumeState()
    }

    private static func destinationURL(for track: NativeTrack, variant: TrackVariant) -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("mmdrome-tracks", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Stable FNV over trackId + variant (not String.hashValue, which is
        // process-seeded): cache files must survive across launches or every
        // launch re-downloads the whole queue and orphans the previous
        // launch's files (TODO 4.5a). Variants hash apart, so raw and
        // transcoded bytes never overwrite each other — the
        // preserve-unless-upgrade rule needs both on disk. Pre-variant files
        // (bare FNV(trackId)) orphan harmlessly; Caches is system-purged.
        let hash = StableID.fnv1a64(transcodeCacheKey(trackId: track.trackId, variant: variant)).description
        var ext = track.url.pathExtension
        // Navidrome stream URLs end in /stream.view?query — pathExtension is "view",
        // not the real audio suffix. Use no extension so AVAudioFile probes the
        // header (or .mp3 fallback). Real file URLs (WebDAV) keep their suffix.
        if ext == "view" || ext == "rest" || ext == "stream" { ext = "" }
        let name = ext.isEmpty ? "\(hash)" : "\(hash).\(ext)"
        return dir.appendingPathComponent(name)
    }
}

// MARK: - Stream writer delegate (A15 Phase 2)

/// `TrackFileLoader` stays a plain class (its downloadTask path needs no
/// delegate), so the streaming writer gets a tiny forwarder: byte arrivals
/// append to the `.part` file ON THE SERIAL DELEGATE QUEUE (ordered, no
/// torn writes), then hop to main for state updates. The file handle is
/// owned here — opened by the loader at start, closed at completion or
/// cancellation.
private final class StreamWriterDelegate: NSObject, URLSessionDataDelegate {
    weak var owner: TrackFileLoader?
    private var handle: FileHandle?
    private var totalReceived: Int64 = 0

    func attach(_ handle: FileHandle) {
        self.handle = handle
        totalReceived = 0
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        completionHandler(.allow)
        // The server's own announcement (when it sends Content-Length) is
        // more precise than the snapshot's size — update the writer's
        // announced total on main (the schedule estimate reads it). The
        // status rides along: a continuation's non-206 answer converts the
        // writer to a fresh overwrite (writerDidReceiveResponse).
        let announced = Int64(response.expectedContentLength)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // NETWORK EVIDENCE: snapshot the response's network facts per
        // attempt (data-assist/proxy verdicts live in these headers). The
        // fingerprint rides the writer's state so the completion verdict
        // logs it verbatim at the early close.
        if let http = response as? HTTPURLResponse {
            let fp = DownloadResume.ResponseFingerprint(
                statusCode: http.statusCode,
                connectionHeader: http.value(forHTTPHeaderField: "Connection"),
                contentLengthHeader: http.value(forHTTPHeaderField: "Content-Length"),
                contentRangeHeader: http.value(forHTTPHeaderField: "Content-Range"),
                acceptRangesHeader: http.value(forHTTPHeaderField: "Accept-Ranges"),
                contentTypeHeader: http.value(forHTTPHeaderField: "Content-Type"))
            DispatchQueue.main.async { [weak self] in
                self?.owner?.writerDidReceiveFingerprint(fp)
            }
        }
        DispatchQueue.main.async { [weak self] in
            self?.owner?.writerDidReceiveResponse(announced: announced, statusCode: status)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let handle else { return }
        handle.write(data)
        totalReceived += Int64(data.count)
        let total = totalReceived
        DispatchQueue.main.async { [weak self] in
            self?.owner?.writerDidReceiveBytes(total)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        try? handle?.close()
        handle = nil
        DispatchQueue.main.async { [weak self] in
            self?.owner?.writerDidComplete(error)
        }
    }
}

// MARK: - Native audio engine

/// Single-path native audio engine. Runs in foreground AND background (AVAudioSession
/// category `.playback`). The Svelte app is a remote control: it sends queue snapshots
/// and commands; the engine owns the clock, gapless scheduling, crossfades and loop
/// handling, and reports track changes via `onTrackChanged`.
public final class NativeAudioEngine: NSObject {

    public var onTrackChanged: ((String) -> Void)?
    public var onPlaybackStateChanged: ((Bool) -> Void)?
    public var onQueueEnded: (() -> Void)?
    public var onError: ((String) -> Void)?
    /// Fired when the native sleep timer expires (playback has been paused).
    public var onSleepTimerFired: (() -> Void)?
    /// Preload download progress (queue-row tint parity with web): fired by
    /// the 1 s sampler ONLY on a real state change (pure PreloadProgress diff
    /// — never a steady chatter stream). "progress"/"done"/"gone".
    public var onPreloadProgress: ((String, String, Double?) -> Void)?
    // (loader hook wired in setup, below)

    // MARK: - Nodes

    private let engine = AVAudioEngine()
    private let playerA = AVAudioPlayerNode()
    private let playerB = AVAudioPlayerNode()
    private let gainA = AVAudioMixerNode()
    private let gainB = AVAudioMixerNode()
    private let mixer = AVAudioMixerNode()
    private let timePitch = AVAudioUnitTimePitch()
    private let varispeed = AVAudioUnitVarispeed()
    private let eq = AVAudioUnitEQ(numberOfBands: 24)
    private let preamp = AVAudioMixerNode()

    // ── Spectrum tap (2026-09-15) ────────────────────────────────────────
    // A TAP node connected FROM the preamp in parallel with the main path
    // (preamp → mainMixerNode stays untouched); the tap's own output is
    // left unconnected — AVAudioEngine renders any tapped node, so the
    // engine copies frames into `spectrumTapBuffer` on the realtime thread
    // (preallocated, no locks/no allocation in the callback — a torn frame
    // is acceptable for a visualization). The FFT + band aggregation run
    // on the MAIN thread at read time (`spectrum()`), publishing the
    // per-band snapshot under `spectrumLock`.
    private let spectrumTap = AVAudioMixerNode()
    private let spectrumLock = NSLock()
    private var spectrumSnapshot: [Double] = Array(repeating: 0, count: SpectrumBands.bandCount)
    private var spectrumTapBuffer: [Float] = []
    private var spectrumWindow: [Float] = []
    private var spectrumHasNewFrame = false
    private var spectrumTapInstalled = false
    private var spectrumFFTSetup: FFTSetup? = nil
    private let spectrumLog2n: UInt = 11 // 2048-point FFT
    private var spectrumFFTSize: Int { 1 << spectrumLog2n }

    // MARK: - State

    private let loader = TrackFileLoader()
    /// The codec probe lives on the loader (it owns the download machinery);
    /// the plugin reaches it through this accessor — the engine's other
    /// surface (queue, graph, state) is orthogonal to byte fetching.
    var loaderForProbe: TrackFileLoader { loader }
    /// Structured diagnostics (2026-09-19): every print()/diagnostic the
    /// engine emits rides THIS instead of stdout, so the Debug HUD Copy dump
    /// carries the danger verdicts (premature drops, evictions, aborts,
    /// stale drops) a phone user could previously never see. danger/info
    /// always record; debug-level entries are write-time gated by
    /// `setDebugDomains`. Delivered to the HUD via `getDebugEvents`.
    internal var eventLog = NativeEventLog()
    internal func eventAdd(_ level: NativeEvent.Level, _ domain: String, _ message: String) {
        eventLog.add(now: ProcessInfo.processInfo.systemUptime, domain: domain, level: level, message)
    }
    /// Opt-in verbose domains (HUD toggles → bridge → here). NOT persisted
    /// natively — the HUD re-pushes them whenever it opens, so a fresh
    /// launch defaults to the danger+info baseline.
    internal func setDebugDomains(_ domains: Set<String>) {
        eventLog.setActiveDomains(domains)
        eventAdd(.info, "engine", "debug domains set: \(domains.sorted().joined(separator: ","))")
    }
    internal func debugEvents(sinceSeq: Int, limit: Int = 1000) -> [String: Any] {
        let events = eventLog.events(sinceSeq: sinceSeq, limit: limit)
        return [
            "events": events.map { ["seq": $0.seq, "t": $0.t, "domain": $0.domain, "level": $0.level.rawValue, "msg": $0.message] },
            "nextSeq": eventLog.nextSeq,
            "dropped": eventLog.droppedCount,
        ]
    }
    /// Instant completion announcements (no tick wait): the loader fires this
    /// the moment a download settles and the engine emits `done`/`gone`
    /// immediately. Routes through `emitPreload` so the sampler's
    /// `lastPreloadEmitted` diff state stays coherent (its completion pass
    /// then never re-announces). Emissions are window-guarded exactly like
    /// the sampler's; duplicates (e.g. a prefetch-chain error also emitting
    /// `gone`) are harmless — the JS reducer treats a repeat `gone` as a
    /// no-op eviction, and the failed row stays retryable per A5 (dim until
    /// the retry lands, then `done` fires from here).
    private func handleDownloadFinished(_ trackId: String, _ succeeded: Bool) {
        guard succeeded else {
            if trackId == currentTrackId || preloadWindowIds.contains(trackId) {
                emitPreload(trackId, "gone", nil)
            }
            return
        }
        // Current track bypasses the window: its completion drives the seek
        // bar's loaded layer (native §3.4).
        if trackId == currentTrackId || preloadWindowIds.contains(trackId) {
            emitPreload(trackId, "done", 1)
        }
    }

    private var tracks: [NativeTrack] = []
    /// Memoized effective durations for tracks with `duration == 0` (TODO 4.5b):
    /// without this, `state()` (driven by the 250 ms poll and `refreshNowPlaying`)
    /// re-opens an AVAudioFile for every zero-duration track on every call, even
    /// while stopped. Only positive values are cached — a 0 means "file not
    /// downloaded yet", which must be re-probed once the file lands.
    private var computedDurations: [String: Double] = [:]
    private var loopMode: NativeLoopMode = .none

    private var activeIndex: Int = 0
    private var isActiveB = false
    private var activeNode: AVAudioPlayerNode { isActiveB ? playerB : playerA }
    private var standbyNode: AVAudioPlayerNode { isActiveB ? playerA : playerB }
    private var activeGain: AVAudioMixerNode { isActiveB ? gainB : gainA }
    private var standbyGain: AVAudioMixerNode { isActiveB ? gainA : gainB }

    /// Seconds offset added to raw player time to account for seek position.
    private var positionBias: Double = 0
    /// The scheduled segment's own end position in seconds (start + planned
    /// frames over the file's sample rate) — the FILE's truth, not the
    /// metadata duration. The premature-completion gate judges against this:
    /// metadata can exceed the real audio (mis-tagged files would false-drop
    /// legit completions), and a header-lying truncation schedules a segment
    /// LONGER than its bytes, so the decoder's early EOF lands measurably
    /// before this bound. 0 = never judged.
    private var scheduledSegmentSeconds: Double = 0
    /// Cached position used while paused / not rendering.
    private var cachedPosition: Double = 0

    private var isPlaying = false
    /// True once a schedule exists that can be resumed (vs. an empty queue).
    private var hasLiveSchedule = false
    /// Crossfade lifecycle — one value (phase + target index) instead of the
    /// old trio so the two can never drift apart; the pure transition model
    /// lives in BackgroundAudioCore (TODO 1.1/1.8).
    private var crossfade = CrossfadeState.idle

    /// Incremented on every schedule reset so stale completion handlers are ignored.
    private var scheduleGeneration = 0
    /// Incremented when the standby player's pending segment is cancelled so its
    /// (stop-triggered) completion handler cannot fake a natural track advance.
    private var standbyScheduleGeneration = 0
    /// Standby generation captured when the standby segment was scheduled.
    private var standbyGeneration = 0

    private var crossfadeMonitor: Timer?
    private var volumeRampTimer: Timer?
    /// 1 s preload-progress sampler (queue-row tints) — started with playback.
    private var preloadProgressTimer: Timer?
    /// Last EMITTED snapshot per trackId (the diff baseline).
    private var lastPreloadEmitted: [String: PreloadProgress] = [:]
    /// The VISIBLE preload window is now DERIVED from the live queue
    /// (`syncPreloadWindow` — pure `preloadWindowIndexes` in Core), not
    /// pushed from JS: the old `setPreloadWindow` set raced every snapshot
    /// (the push rode BEFORE the bridge call; `setQueue`/`setQueueAndPlay`/
    /// `refreshQueue` reset the stored set to nil AFTER), leaving the engine
    /// permanently unsynced — the instant completion hook then treated nil
    /// as "report nothing" and almost every `done` was silently dropped
    /// (the "only one row ever shows preloaded" report, 2026-09-14).
    private var preloadWindowIds: Set<String> = []
    private var rampStepCount = 0
    /// Set when speed/pitch/tape-mode changed since the last schedule; consumed
    /// at the next schedule or resume.
    private var paramsDirty = false
    /// Debounced restart timer: applies param changes by re-scheduling the
    /// current track (units are only ever written while the node is stopped).
    private var paramRestartTimer: Timer?

    // MARK: - Sleep timer

    private var sleepTimer: Timer?
    /// When true, pauses at the natural end of the current track.
    private var sleepAtTrackEnd = false
    /// Set when an end-of-track sleep paused exactly as the current track's
    /// segment completed. The schedule is fully consumed, so the next `play()`
    /// advances like a natural track end instead of resuming a dead node
    /// (which would leave the JS state frozen on the finished track).
    private var waitingAtTrackEnd = false

    // MARK: - Settings

    private var speed: Double = 1
    private var pitchOctaves: Double = 0
    private var tapeMode = false
    private var snapTolerance: Double = 0.15
    private var replayGainMode = "off"
    private var preampDb: Double = 0
    private var masterVolume: Double = 1
    /// JS `iosAudioMixing` setting ('exclusive' | 'mix'), mirrored by the
    /// `setAudioMixing` bridge alongside `SessionController`. Read here (not
    /// hardcoded) so an engine restart keeps the user's sharing choice.
    public var audioMixingMode = "exclusive"
    private var crossfadeDuration: Double = 0
    private var crossfadeCurve = "sigmoid"
    private var sigmoidSteepness: Double = 6
    /// Number of upcoming files to keep warm. When crossfade is enabled, the
    /// immediate successor is always retained as a transition reserve even when
    /// this setting is zero.
    private var preloadCount = 0
    /// Bumped whenever the track list is replaced (setQueue/refreshQueue/
    /// divergence reset). In-flight sequential-prefetch chains check it in
    /// their completions and drop the rest of the chain instead of prefetching
    /// against a queue that no longer exists.
    private var prefetchGeneration = 0
    private var lastCrossfadeReadiness: CrossfadeReadiness?
    /// Track id whose crossfade automation a user seek suppressed (the seek
    /// landed inside its window — `isSeekInCrossfadeWindow`). Cleared when a
    /// DIFFERENT track loads (`playTrack`), so the suppression never leaks
    /// into the next track. Web parity: audioManager `_seekSuppressed`.
    private var seekSuppressedTrackId: String?
    /// Set by abortCrossfadeKeepActive: a fade aborted mid-flight means the
    /// CURRENT track must finish WITHOUT further fade automation — its
    /// position is already past the transition point, so a re-armed monitor
    /// would instantly re-fade into the (evicted) target and churn. Cleared
    /// in playTrack (a new track instance gets fresh fades).
    private var fadeAbortedTrackId: String?
    /// Re-entrancy beacon for finalizeCrossfadeSwitch (2026-09-21c): the
    /// premature-drop eviction (and any future mid-fade decision) checks
    /// this — a completion arriving WHILE finalize runs is a crossed-state
    /// artifact of the re-entrant chain, not evidence about the file.
    private var reentrancyGuard = 0
    /// Recently played track ids, NEWEST FIRST (2026-09-21 field detector).
    /// Written at the END of a successful playTrack (the outgoing row joins;
    /// same-id restarts are skipped so a row's own restart doesn't count as a
    /// prior play). Capped at 8 — deep history is irrelevant to a "jumped back
    /// 5-10 rows" signature and duplicates dedupe naturally.
    private var recentlyPlayedTrackIds: [String] = []
    /// Previous run's NSException breadcrumb, when present (debugState only).
    private var lastLaunchCrash: String?

    public override init() {
        super.init()
        // The loader is main-thread-owned like the engine; route its gate
        // verdicts into the structured event log (domain "loader").
        loader.eventSink = { [weak self] level, message in
            self?.eventAdd(level, "loader", message)
        }
        // Maturation staging (A15 Phase 1): the loader's per-tick stage
        // machine needs the queue for per-track lead sizing.
        loader.engineTrackLookup = { [weak self] trackId in
            self?.tracks.first(where: { $0.trackId == trackId })
        }
        // The real fix for the 1.2.13 launch crash is in setupGraph(): every
        // node is attached before it is connected (the crash was an
        // unattached spectrumTap). Kept simple on purpose — AVFoundation
        // raises ObjC NSExceptions that Swift's do/catch cannot intercept,
        // and a wrong-graph-silently-playing app is worse than a loud
        // developer-visible crash in a build the store never shipped.
        // Defense = the attach/connect audit in the docs + this comment.
        setupGraph()
        // Last-launch crash breadcrumb (the 1.2.13/1.2.14 .ips files were
        // NSException crashes): the handler writes a small Caches file during
        // the crash; init reads and clears it and debugState() surfaces it —
        // a crash report reaches the Debug HUD without a user-exported .ips.
        CrashBreadcrumb.installHook()
        if let breadcrumb = CrashBreadcrumb.readAndClear() {
            eventAdd(.danger, "engine", "LAST-LAUNCH CRASH: \(breadcrumb)")
            lastLaunchCrash = breadcrumb
        }
        loader.onDownloadFinished = { [weak self] trackId, succeeded in
            self?.handleDownloadFinished(trackId, succeeded)
        }
    }

    private func setupGraph() {
        engine.attach(playerA)
        engine.attach(playerB)
        engine.attach(gainA)
        engine.attach(gainB)
        engine.attach(mixer)
        engine.attach(timePitch)
        engine.attach(varispeed)
        engine.attach(eq)
        engine.attach(preamp)
        // The spectrum tap MUST be attached before engine.connect touches it —
        // connecting an unattached node throws at graph build (the 1.2.13
        // launch crash: the plugin instantiates the engine at app open, so
        // the exception killed every launch). Found by inspection after the
        // crash report — add a node here AND attach it here.
        engine.attach(spectrumTap)

        engine.connect(playerA, to: gainA, format: nil)
        engine.connect(playerB, to: gainB, format: nil)
        engine.connect(gainA, to: mixer, format: nil)
        engine.connect(gainB, to: mixer, format: nil)
        engine.connect(mixer, to: timePitch, format: nil)
        engine.connect(timePitch, to: varispeed, format: nil)
        engine.connect(varispeed, to: eq, format: nil)
        // Spectrum tap is IN-LINE: preamp → tap → mainMixer. A mixer with an
        // input but NO output connection is a dead-end render branch, and a
        // dead-end in the graph makes engine.start() FAIL on device — which
        // used to crash at play(): the failed start was swallowed and
        // player.play() on a stopped engine raises an NSException (1.2.14
        // play crash). An in-line mixer is pass-through (unity gain, like
        // gainA/gainB) so the tap cannot color the audio.
        engine.connect(eq, to: preamp, format: nil)
        engine.connect(preamp, to: spectrumTap, format: nil)
        engine.connect(spectrumTap, to: engine.mainMixerNode, format: nil)

        mixer.outputVolume = 1.0
        gainA.outputVolume = 1.0
        gainB.outputVolume = 1.0
        preamp.outputVolume = 1.0
        timePitch.pitch = 0.0
        timePitch.rate = 1.0
        varispeed.rate = 1.0
        for band in eq.bands { band.bypass = true }
    }

    /// Starts the engine if needed. Returns whether the engine IS RUNNING
    /// afterward. Callers MUST check the result before `player.play()` —
    /// playing into a stopped engine raises an NSException (SIGABRT; the
    /// 1.2.14 play crash). The failure itself only logs here; the call site
    /// reports the honest error.
    /// Deliberately NOT `@discardableResult` (the bare call in play() was the
    /// 1.2.14 crash shape): an ignored Bool result warns at compile time, so
    /// a future direct-play site can't silently skip the guard.
    private func ensureEngineRunning() -> Bool {
        guard !engine.isRunning else { return true }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: SessionController.categoryOptions(for: audioMixingMode))
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Non-fatal: engine.start may still succeed if session already active.
            eventAdd(.danger, "engine", "ensureEngineRunning session activate failed: \(error.localizedDescription)")
        }
        installSpectrumTapIfNeeded()
        engine.prepare()
        do {
            try engine.start()
            return true
        } catch {
            eventAdd(.danger, "engine", "engine start failed: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Spectrum tap

    /// Installs the AVAudioEngine tap on the spectrum node once (idempotent).
    /// The tap callback runs on a REALTIME audio thread: it only copies
    /// channel 0 into the preallocated `spectrumTapBuffer` and flags the
    /// frame — no locks, no allocation. FFT/aggregation happen on the main
    /// thread in `spectrum()`.
    private func installSpectrumTapIfNeeded() {
        guard !spectrumTapInstalled else { return }
        let fmt = spectrumTap.outputFormat(forBus: 0)
        guard fmt.sampleRate > 0 else { return }
        spectrumTapInstalled = true
        spectrumTapBuffer = [Float](repeating: 0, count: spectrumFFTSize)
        spectrumWindow = [Float](repeating: 0, count: spectrumFFTSize)
        vDSP_hann_window(&spectrumWindow, UInt(spectrumFFTSize), Int32(vDSP_HANN_NORM))
        spectrumFFTSetup = vDSP_create_fftsetup(spectrumLog2n, FFTRadix(FFT_RADIX2))
        spectrumTap.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buffer, _ in
            guard let self, let channel = buffer.floatChannelData?[0] else { return }
            let frames = min(Int(buffer.frameLength), self.spectrumFFTSize)
            guard frames > 0 else { return }
            // No locks/allocation: copy channel 0 into the preallocated
            // buffer (`channel` is already UnsafeMutablePointer<Float>). A
            // torn frame (main thread reading mid-copy) is fine for a
            // visualizer.
            for i in 0..<frames { self.spectrumTapBuffer[i] = channel[i] }
            for i in frames..<self.spectrumFFTSize { self.spectrumTapBuffer[i] = 0 }
            self.spectrumHasNewFrame = true
        }
    }

    /// Bridge-facing read: FFT the latest tap frame (standard vDSP real-FFT
    /// split-complex pattern, main thread), aggregate into SpectrumBands,
    /// and return the per-band 0..1 levels + the audio-active flag. While
    /// paused the snapshot reads ZEROS — the tap freezes on the last real
    /// frame, so the JS overlay must decay to silence, never show a stale
    /// picture.
    public func spectrum() -> (bands: [Double], playing: Bool) {
        let playing = isPlaying
        if playing && spectrumHasNewFrame, let setup = spectrumFFTSetup {
            spectrumHasNewFrame = false
            let n = spectrumFFTSize
            let halfN = n / 2
            var windowed = [Float](repeating: 0, count: n)
            spectrumTapBuffer.withUnsafeBufferPointer { src in
                vDSP_vmul(src.baseAddress!, 1, spectrumWindow, 1, &windowed, 1, UInt(n))
            }
            var realp = [Float](repeating: 0, count: halfN)
            var imagp = [Float](repeating: 0, count: halfN)
            var mags = [Double](repeating: 0, count: halfN)
            // Pack the real signal the way vDSP_fft_zrip expects: even
            // samples → realp, odd samples → imagp (what vDSP_ctoz does
            // for a contiguous float buffer — spelled out here to keep the
            // stride semantics unambiguous).
            for i in 0..<halfN {
                realp[i] = windowed[2 * i]
                imagp[i] = windowed[2 * i + 1]
            }
            realp.withUnsafeMutableBufferPointer { realPtr in
                imagp.withUnsafeMutableBufferPointer { imagPtr in
                    var split = DSPSplitComplex(realp: realPtr.baseAddress!, imagp: imagPtr.baseAddress!)
                    vDSP_fft_zrip(setup, &split, 1, spectrumLog2n, FFTDirection(FFT_FORWARD))
                    // Forward transform is unscaled (results ×2): normalize
                    // by 1/2N so a full-scale sine lands ≈0.5 (Hann coherent
                    // gain) on the display ladder. Skip DC (bin 0).
                    for i in 1..<halfN {
                        let re = Double(split.realp[i])
                        let im = Double(split.imagp[i])
                        mags[i] = 2.0 * sqrt(re * re + im * im) / Double(n)
                    }
                }
            }
            let sampleRate = spectrumTap.outputFormat(forBus: 0).sampleRate
            let bands = SpectrumBands.bands(from: mags, binHz: sampleRate / Double(n))
            spectrumLock.lock()
            spectrumSnapshot = bands
            spectrumLock.unlock()
        }
        spectrumLock.lock()
        defer { spectrumLock.unlock() }
        let bands = playing ? spectrumSnapshot : Array(repeating: 0, count: SpectrumBands.bandCount)
        return (bands, playing)
    }

    // MARK: - Queue & playback control

    public func setQueue(tracks: [NativeTrack], activeIndex: Int, loopMode: NativeLoopMode) {
        stopPlayback()
        self.tracks = tracks
        self.loopMode = loopMode
        self.activeIndex = tracks.isEmpty ? 0 : max(0, min(activeIndex, tracks.count - 1))
        lastPreloadEmitted = [:]
        syncPreloadWindow()
        prefetchGeneration += 1
    }

    /// Atomic setQueue+playTrackAt for JS `engage` (fixes N1 — the split
    /// setQueue→playTrackAt left `playTrack.changed` false because setQueue
    /// already moved `activeIndex`, suppressing the `trackChanged` event and
    /// leaving the lock-screen on the previous track while JS showed the new one).
    public func setQueueAndPlay(tracks: [NativeTrack], activeIndex: Int, loopMode: NativeLoopMode, autoPlay: Bool = true) {
        let oldId = currentTrackId
        stopPlayback()
        self.tracks = tracks
        self.loopMode = loopMode
        self.activeIndex = tracks.isEmpty ? 0 : max(0, min(activeIndex, tracks.count - 1))
        lastPreloadEmitted = [:]
        syncPreloadWindow()
        prefetchGeneration += 1
        guard !tracks.isEmpty else { return }
        let clamped = self.activeIndex
        loadAndStart(currentIndex: clamped, autoPlay: autoPlay)
        let newId = tracks.indices.contains(clamped) ? tracks[clamped].trackId : ""
        if autoPlay && newId != oldId && !newId.isEmpty {
            onTrackChanged?(newId)
        }
    }

    /// Who ordered a playTrack — the backward-advance detector only trusts
    /// ENGINE-initiated advances: a user next/previous intentionally lands on
    /// any row (previous() targets the just-played row by design, and loop-all
    /// wraps legitimately re-enter played rows), so those must never log.
    private enum PlayOrigin {
        case userCommand
        case engineAdvance
    }

    public func playTrack(at index: Int, autoPlay: Bool) {
        playTrack(at: index, autoPlay: autoPlay, origin: .userCommand)
    }

    private func playTrack(at index: Int, autoPlay: Bool, origin: PlayOrigin) {
        guard !tracks.isEmpty else { return }
        eventAdd(.info, "engine", "playTrack \(activeIndex)→\(index) autoPlay=\(autoPlay) id=\(tracks.indices.contains(index) ? tracks[index].trackId : "-")")
        let clamped = max(0, min(index, tracks.count - 1))
        let oldTrackId = currentTrackId
        // 2026-09-21 field detector (the "queue jumped BACKWARD 5-10 rows and
        // repeated" report, shape unconfirmed): a NATURAL advance (the engine
        // moving itself forward, loop-none) that lands on a row RECENTLY
        // PLAYED is the signature of an index regression — a stale snapshot
        // re-engaging an old row. Healthy loop-none playback never re-enters
        // a played row; user commands and loop-all wraps are excluded (they
        // land where they aim). Log-only: the next dump either confirms the
        // shape (danger lines clustering at each perceived skip) or acquits
        // it (no danger, bug lies elsewhere).
        if origin == .engineAdvance, loopMode == .none, !recentlyPlayedTrackIds.isEmpty, let oldId = tracks.indices.contains(activeIndex) ? tracks[activeIndex].trackId : nil {
            let targetId = tracks.indices.contains(clamped) ? tracks[clamped].trackId : ""
            if autoPlay, !targetId.isEmpty, targetId != oldId,
               let depth = recentlyPlayedTrackIds.firstIndex(of: targetId) {
                eventAdd(.danger, "queue", "BACKWARD-ADVANCE target=\(targetId) was played \(depth + 1) advance(s) ago (current=\(oldId)) — index regression signature, observe-only")
            }
        }
        // A new track instance starts with clean crossfade automation — a
        // suppression latched by seeking inside the PREVIOUS track's window
        // must not leak (loop-one restarts clear it too; same id, new play).
        seekSuppressedTrackId = nil
        fadeAbortedTrackId = nil
        // The outgoing row's terminal preload state (2026-09-15, the "played
        // songs don't show as preloaded unless you skip around" report): a row
        // that was mid-download when it became current must report its FINAL
        // state before the new row's events land — otherwise its entry freezes
        // at a partial `fetching`, and pass 2 of the sampler (which only diffs
        // WINDOW rows) never corrects a row that just left the window. `done`
        // when bytes are on disk, else `gone`.
        if oldTrackId != tracks[clamped].trackId, !oldTrackId.isEmpty,
           let last = lastPreloadEmitted[oldTrackId], last.state == "fetching" {
            let prefix = oldTrackId + "|"
            let cached = loader.cacheKeys.contains { $0.hasPrefix(prefix) }
            emitPreload(oldTrackId, cached ? "done" : "gone", nil)
        }
        if oldTrackId != tracks[clamped].trackId, !oldTrackId.isEmpty {
            recentlyPlayedTrackIds.removeAll { $0 == oldTrackId }
            recentlyPlayedTrackIds.insert(oldTrackId, at: 0)
            if recentlyPlayedTrackIds.count > 8 {
                recentlyPlayedTrackIds.removeLast(recentlyPlayedTrackIds.count - 8)
            }
        }
        activeIndex = clamped
        syncPreloadWindow()
        loadAndStart(currentIndex: clamped, autoPlay: autoPlay)
        let newTrackId = tracks.indices.contains(clamped) ? tracks[clamped].trackId : ""
        if autoPlay && newTrackId != oldTrackId && !newTrackId.isEmpty {
            onTrackChanged?(newTrackId)
        }
    }

    /// Replaces the queue tail without disturbing the actively playing track.
    /// `tracks[activeIndex].trackId` must match the currently playing track; the
    /// JS side re-sends the full current combined queue after its own promotions.
    public func refreshQueue(tracks: [NativeTrack], activeIndex: Int) {
        guard !tracks.isEmpty else { return }
        let snapshotActiveId = tracks.indices.contains(activeIndex) ? tracks[activeIndex].trackId : ""
        let decision = queueRefreshDecision(
            snapshotActiveId: snapshotActiveId,
            engineCurrentId: currentTrackId,
            requestedIndex: activeIndex,
            trackCount: tracks.count,
            snapshotTrackIds: tracks.map { $0.trackId }
        )
        let synchronizedIndex: Int
        switch decision {
        case .synced(let index):
            synchronizedIndex = index
        case .containsCurrent(let index):
            // 2026-09-21 P0b, the divergence stop-storm: during a natural
            // advance the trackChanged→refreshQueue pair crosses in flight and
            // JS's snapshot arrives naming the JUST-PLAYED row. The old strict
            // compare called that a divergence and STOPPED the live row — the
            // field dump caught three consecutive stops in ~70 ms (rows
            // 159→160→161), each one killing a track that had just started.
            // The live row still exists in the snapshot, so reconcile:
            // re-anchor to where it lives THERE and rebuild the tail. Playback
            // never stops for a lag; only a snapshot that has LOST the live
            // row takes the reset path below.
            eventAdd(.danger, "queue", "refreshQueue lag-tolerated: snapshot activeId=\(snapshotActiveId)@\(activeIndex) is behind engine currentId=\(currentTrackId) — re-anchored to snapshot row \(index), playback preserved")
            synchronizedIndex = index
        case .divergent:
            // Divergent queue — fall back to a full reset and report ENDED (1.4,
            // mirroring handleTrackEnd): the honest signal that JS navigates the
            // stale index. On `ended` JS re-snapshots from its own authoritative
            // queue, so the engine can't sit on a snapshot JS can't navigate.
            // DANGER-level: this stops playback. Reached only when the snapshot
            // has lost the engine's live row entirely (or the engine is idle) —
            // a merely-BEHIND snapshot takes the lag-tolerated path above.
            eventAdd(.danger, "queue", "refreshQueue DIVERGENT: snapshot activeId=\(snapshotActiveId)@\(activeIndex) missing engine currentId=\(currentTrackId) — stopping and reporting ended")
            stopPlayback()
            self.tracks = tracks
            self.activeIndex = max(0, min(activeIndex, tracks.count - 1))
            lastPreloadEmitted = [:]
            syncPreloadWindow()
            prefetchGeneration += 1
            onQueueEnded?()
            return
        }
        let oldTargetId: String? = {
            guard crossfade.isActive,
                  self.tracks.indices.contains(crossfade.targetIndex) else { return nil }
            eventAdd(.info, "crossfade", "queue-refresh preserves fade phase=\(crossfade.phase) target=\(self.tracks[crossfade.targetIndex].trackId)")
            return self.tracks[crossfade.targetIndex].trackId
        }()
        self.tracks = tracks
        // The active track ID stayed the same, but its position may have moved
        // after a queue mutation. Keep the native clock attached to that ID by
        // re-anchoring the index before rebuilding any crossfade tail.
        if synchronizedIndex != activeIndex {
            eventAdd(.info, "queue", "refreshQueue re-anchor \(activeIndex)→\(synchronizedIndex) (\(currentTrackId))")
        }
        self.activeIndex = synchronizedIndex
        lastPreloadEmitted = [:]
        syncPreloadWindow()
        prefetchGeneration += 1
        // Restart the prefetch chain (2026-09-15, the "preload stops after the
        // first few songs" report): the bump above killed any in-flight chain
        // and nothing re-armed it — every natural advance rewrites the JS queue
        // store (trackChanged → advanceTo/replenish), so each advance issued a
        // refreshQueue and preloading only ever finished while the tail stayed
        // quiet. In-flight rows chain onto the loader's existing task (no
        // duplicate download); the fresh generation re-diffs the sampler.
        prefetchUpcoming(from: synchronizedIndex)
        let newTargetIndex: Int? = oldTargetId.flatMap { targetId -> Int? in
            guard let candidate = tracks.firstIndex(where: { $0.trackId == targetId }),
                  self.nextIndex(after: synchronizedIndex) == candidate else { return nil }
            return candidate
        }
        // Preserve an in-flight fade when its audible target survived the queue
        // refresh. Numeric indexes are re-derived by ID; the scheduled standby
        // node and gain ramp remain untouched.
        if crossfade.isInFlight, let newTargetIndex {
            crossfade = CrossfadeState(phase: .inFlight, targetIndex: newTargetIndex)
            return
        }
        // Tear down any armed crossfade targeting the OLD tail; the monitor re-arms
        // from the new list on its next tick. Only invalidate the standby completion
        // while a crossfade is armed/in-flight — after finalizeCrossfadeSwitch the
        // (former standby) node's completion is the active track's natural-end trigger.
        let hadCrossfade = crossfade.isActive
        stopCrossfadeMonitor()
        stopVolumeRamp()
        if hadCrossfade {
            standbyScheduleGeneration += 1
            standbyNode.stop()
            refreshActiveGain()
        }
        standbyGain.outputVolume = 0
        crossfade = .idle
        if isPlaying {
            setupCrossfadeMonitor()
        }
    }

    public func setLoopMode(_ mode: NativeLoopMode) {
        eventAdd(.info, "engine", "setLoopMode \(loopMode.rawValue)→\(mode.rawValue)")
        loopMode = mode
        syncPreloadWindow() // wrap behavior feeds the window walk
        // Switching TO loop-all unwraps the chain's tail (the walk now wraps);
        // an idle tail never restarted, so rows past the old end never filled.
        // Restart only on this edge — the other transitions don't change the
        // walk's reach. Fires paused too: play()'s plain resume only re-arms
        // the PREVIOUS window (2026-09-15 deferred-arm fix).
        if mode == .all, !tracks.isEmpty {
            prefetchUpcoming(from: activeIndex)
        }
        let hadCrossfade = crossfade.isActive
        stopCrossfadeMonitor()
        stopVolumeRamp()
        if hadCrossfade {
            standbyScheduleGeneration += 1
            standbyNode.stop()
            refreshActiveGain()
        }
        standbyGain.outputVolume = 0
        crossfade = .idle
        if isPlaying {
            setupCrossfadeMonitor()
        }
    }

    public func play() {
        eventAdd(.info, "engine", "play() waitingAtTrackEnd=\(waitingAtTrackEnd) hasLiveSchedule=\(hasLiveSchedule) paramsDirty=\(paramsDirty) isPlaying=\(isPlaying)")
        // The start MUST be guarded here: the plain-resume tail below executes
        // activeNode.play() DIRECTLY (no schedule hop), and a player.play()
        // into a stopped engine raises in AVAudioPlayerNodeImpl::StartImpl —
        // the 1.2.14 crash shape. The schedule-based returns below re-guard
        // inside scheduleCurrentTrack; this is the one direct-play path.
        // Degrade honestly: the JS retry machinery re-plays, re-attempting
        // the engine start.
        guard ensureEngineRunning() else {
            if tracks.indices.contains(activeIndex) {
                onError?("Audio engine failed to start for \(tracks[activeIndex].title)")
            }
            return
        }
        guard !tracks.isEmpty else { return }
        // An end-of-track sleep paused us right as the previous track finished;
        // its segment is gone, so resume by advancing like a natural next track.
        // This keeps the engine and the JS play state in lockstep (onTrackChanged
        // fires and the wrapper advances currentTrack/activeIndex).
        if waitingAtTrackEnd {
            waitingAtTrackEnd = false
            advanceFromSleepPause()
            return
        }
        // Nothing scheduled (fresh queue or finished queue): (re)start the current track.
        if !hasLiveSchedule {
            loadAndStart(currentIndex: activeIndex, autoPlay: true)
            return
        }
        // A param change happened while paused — resume via a fresh schedule so
        // the new speed/pitch actually take effect on the (re)started plan.
        if paramsDirty {
            restartForParams()
            return
        }
        // A15 Phase 2: a STAGED schedule sitting in the buffering pause (its
        // old chained schedule already consumed) resumes by re-scheduling
        // from the stalled position — the delivered estimate has grown by
        // now, and scheduleCurrentTrack re-clamps to the fresh end. This is
        // ALSO the user's manual resume after pausing during a stall
        // (userPaused latched) — the auto-resume path never touched audio.
        if var staged = stagedSchedule, staged.isStalled, stagedSourceURL != nil {
            staged.userPaused = false
            stagedSchedule = staged
            let resumeAt = cachedPosition
            eventAdd(.info, "stream", "play() resumes stalled staged schedule at \(String(format: "%.1f", resumeAt))s")
            cancelScheduled()
            scheduleCurrentTrack(from: resumeAt, autoPlay: true)
            return
        }
        // Window-growth changes made while PAUSED deferred their chain arm
        // (guard isPlaying) — a plain resume never re-arms it, so the deferred
        // rows never fill until the next track load. The earlier returns above
        // (loadAndStart / restartForParams → scheduleCurrentTrack) arm the
        // chain themselves; only this plain-resume path needs the explicit
        // arm. Like every other arm site, the walk follows nextIndex (the
        // successor fills even under loop-one — harmless, a skip needs it).
        prefetchUpcoming(from: activeIndex)
        activeNode.play()
        standbyNode.play()
        setPlaying(true)
        setupCrossfadeMonitor()
    }

    public func pause() {
        guard isPlaying else { return }
        eventAdd(.info, "engine", "pause() position=\(String(format: "%.1f", currentPosition)) crossfade=\(crossfade.phase)")
        cachedPosition = currentPosition
        // A user pause during a staged buffering stall must not be overridden
        // by the auto-resume: latch it so the stall-resume path keeps the
        // paused state the user asked for.
        if let staged = stagedSchedule, staged.isStalled {
            stagedSchedule?.userPaused = true
        }
        // Pause both players: during a crossfade the standby node is rendering too.
        activeNode.pause()
        standbyNode.pause()
        // Tear down any armed/in-flight crossfade (1.8): the ramp must not keep
        // mutating gains while paused (a mid-fade pause would resume with wrong
        // volumes and a stale switch), and the standby's pending completion
        // must not fake a natural advance on resume — resume re-arms fresh.
        let hadCrossfade = crossfade.isActive
        stopCrossfadeMonitor()
        stopVolumeRamp()
        if hadCrossfade {
            standbyScheduleGeneration += 1
            standbyNode.stop()
        }
        standbyGain.outputVolume = 0
        crossfade = .idle
        // A mid-fade pause may have ramped the active gain toward 0 — restore
        // the track's full gain so the next arm starts from a clean base.
        refreshActiveGain()
        setPlaying(false)
    }

    public func togglePlayPause() {
        isPlaying ? pause() : play()
    }

    public func seek(to seconds: Double) {
        guard !tracks.isEmpty, tracks.indices.contains(activeIndex) else { return }
        eventAdd(.info, "engine", "seek \(String(format: "%.1f", currentPosition)) → \(String(format: "%.1f", seconds)) crossfade=\(crossfade.phase)")
        let track = tracks[activeIndex]
        let dur = effectiveDuration(of: track)
        let target = max(0, min(seconds, max(0, dur - 0.05)))
        // A user scrub into this track's crossfade window owns the transition:
        // latch the suppression (the re-schedule below re-arms the monitor,
        // which would otherwise insta-fade within 100 ms — one fade per input
        // event while a drag is held). Mid-fade seeks collapse cleanly via
        // cancelScheduled() + the gain reset in scheduleCurrentTrack.
        if isSeekInCrossfadeWindow(position: target, duration: dur, fadeDuration: crossfadeDuration) {
            seekSuppressedTrackId = track.trackId
        }
        cancelScheduled()
        hasLiveSchedule = false
        positionBias = target
        cachedPosition = target
        scheduleCurrentTrack(from: target, autoPlay: isPlaying)
    }

    public func next() {
        guard !tracks.isEmpty else { return }
        eventAdd(.info, "engine", "next() from row \(activeIndex) (\(currentTrackId))")
        if let idx = nextIndex(after: activeIndex) {
            playTrack(at: idx, autoPlay: true)
        } else {
            // End of queue with loopMode none: behave like natural end.
            stopPlayback()
            onQueueEnded?()
        }
    }

    public func previous() {
        guard !tracks.isEmpty else { return }
        eventAdd(.info, "engine", "previous() from row \(activeIndex) (\(currentTrackId))")
        // Restart the current track if we're more than 3 seconds in.
        if currentPosition > 3 {
            seek(to: 0)
            return
        }
        if activeIndex > 0 {
            playTrack(at: activeIndex - 1, autoPlay: true)
        } else if loopMode == .all {
            playTrack(at: tracks.count - 1, autoPlay: true)
        } else {
            seek(to: 0)
        }
    }

    // MARK: - Settings

    /// Speed / pitch / tape-mode are stored as fields and applied to the audio
    /// units ONLY inside `scheduleCurrentTrack`, while the player node is
    /// stopped. Live mutation of `AVAudioUnitTimePitch`/`AVAudioUnitVarispeed`
    /// on a running engine can corrupt the unit (frozen/wrong-pitch output) and
    /// a subsequent `player.play()` then aborts in `AVAudioPlayerNodeImpl::
    /// StartImpl`. While playing, a change triggers a debounced re-schedule at
    /// the current position instead.

    public func setSpeed(_ value: Double) {
        let clamped = max(0.2, min(4.0, value))
        guard clamped != speed else { return }
        speed = clamped
        scheduleParamRestart()
    }

    public func setPitchOctaves(_ octaves: Double) {
        let clamped = max(-2, min(2, octaves))
        let snapped = snapPitchToSemitone(octaves: clamped, toleranceSemitones: snapTolerance)
        guard snapped != pitchOctaves else { return }
        pitchOctaves = snapped
        scheduleParamRestart()
    }

    public func setTapeMode(_ enabled: Bool) {
        guard enabled != tapeMode else { return }
        tapeMode = enabled
        scheduleParamRestart()
    }

    /// Snap tolerance in semitones (0…0.5). Widening the tolerance can pull an
    /// off-grid pitch (set while a tighter/zero tolerance let it through) onto
    /// the grid, so re-snap here; a snapped value stays snapped for any
    /// tolerance, which makes the common case a no-op.
    public func setSnapTolerance(_ semitones: Double) {
        let clamped = max(0, min(0.5, semitones))
        guard clamped != snapTolerance else { return }
        snapTolerance = clamped
        let resnapped = snapPitchToSemitone(octaves: pitchOctaves, toleranceSemitones: snapTolerance)
        guard resnapped != pitchOctaves else { return }
        pitchOctaves = resnapped
        scheduleParamRestart()
    }

    /// Marks the params as needing application and, while playing, debounces a
    /// restart that re-schedules the current track at its current position.
    private func scheduleParamRestart() {
        paramsDirty = true
        guard isPlaying, tracks.indices.contains(activeIndex) else { return }
        paramRestartTimer?.invalidate()
        let timer = Timer(timeInterval: 0.06, repeats: false) { [weak self] _ in
            self?.restartForParams()
        }
        paramRestartTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    /// Applies the pending param change by re-scheduling the current track from
    /// its current position with a fresh render plan.
    private func restartForParams() {
        paramRestartTimer = nil
        guard isPlaying, tracks.indices.contains(activeIndex) else { return }
        let position = currentPosition
        cancelScheduled()
        hasLiveSchedule = false
        scheduleCurrentTrack(from: position, autoPlay: true)
    }

    /// Writes the current speed/pitch/tape fields onto the audio units. Call
    /// ONLY from `scheduleCurrentTrack` while both player nodes are stopped.
    private func refreshPlaybackParams() {
        timePitch.pitch = tapeMode ? 0 : Float(pitchOctaves * 1200.0)
        timePitch.rate = tapeMode ? 1.0 : Float(speed)
        varispeed.rate = tapeMode ? Float(speed) : 1.0
        paramsDirty = false
        paramRestartTimer?.invalidate()
        paramRestartTimer = nil
    }

    public func setReplayGainMode(_ mode: String) {
        replayGainMode = mode
        refreshActiveGain()
    }

    public func setPreampDb(_ db: Double) {
        preampDb = max(-12, min(12, db))
        refreshPreamp()
    }

    public func setMasterVolume(_ volume: Double) {
        masterVolume = max(0, min(2, volume))
        refreshPreamp()
    }

    public func setCrossfade(duration: Double, curve: String, sigmoidSteepness: Double) {
        eventAdd(.info, "crossfade", "setCrossfade duration=\(max(0, min(15, duration))) curve=\(curve) steepness=\(sigmoidSteepness) (was \(crossfadeDuration))")
        crossfadeDuration = max(0, min(15, duration))
        crossfadeCurve = curve
        self.sigmoidSteepness = sigmoidSteepness
        // The window derivation reads crossfadeDuration (the successor
        // reservation) — re-derive so the completion hook's guard matches the
        // chain the toggle just resized. Stale here = the reserved successor
        // downloads but its `done` is dropped (the 1.2.6 nothing-lights class).
        syncPreloadWindow()
        if isPlaying {
            prefetchUpcoming(from: activeIndex)
            setupCrossfadeMonitor()
        } else if crossfadeDuration > 0 {
            // Paused + the successor reservation changed (0 ⇄ >0): the chain
            // length changed while the arm was deferred — arm it now; play()
            // would never cover rows the old window didn't (2026-09-15).
            prefetchUpcoming(from: activeIndex)
            stopCrossfadeMonitor()
        } else {
            stopCrossfadeMonitor()
        }
    }

    /// Rebuilds the visible preload window from the LIVE queue — pure
    /// `preloadWindowIndexes` walks the same chain `prefetchUpcoming` fills
    /// (next-first, wrap under loop-all, never the playing row). Derived at
    /// every queue/index/preload-count mutation so the completion hook's
    /// window guard is always current; no bridge round-trip can desync it.
    private func syncPreloadWindow() {
        // Mirror the chain's own total (the crossfade reservation keeps ONE
        // successor even at preloadCount 0) so the window is exactly the set
        // `prefetchUpcoming` fills.
        let total = crossfadeDuration > 0 ? max(1, preloadCount) : preloadCount
        preloadWindowIds = Set(
            preloadWindowIndexes(
                activeIndex: activeIndex,
                trackCount: tracks.count,
                count: total,
                loopAll: loopMode == .all
            )
            .compactMap { tracks.indices.contains($0) ? tracks[$0].trackId : nil }
        )
    }

    /// Re-derives the window and restarts the chain after a preload-count
    /// change. The window is engine-derived, so no JS round-trip is needed —
    /// the count's only cross-boundary effect is how many rows report.
    public func setPreloadCount(_ count: Int) {
        eventAdd(.info, "preload", "setPreloadCount \(preloadCount)→\(count) (crossfade reservation \(crossfadeDuration > 0 ? "on" : "off"))")
        let clamped = max(0, min(5, count))
        guard clamped != preloadCount else { return }
        let grew = clamped > preloadCount
        preloadCount = clamped
        syncPreloadWindow()
        // A GROWTH made while paused must not wait for the next track load:
        // the plain-resume path in play() only re-arms what the previous
        // window covered, so the deferred arm happens here (2026-09-15).
        if grew || isPlaying {
            prefetchUpcoming(from: activeIndex)
        }
    }

    // MARK: - Preload progress (queue-row tint parity with web)

    /// REMOVED — the JS-pushed window raced every snapshot (the push rode
    /// BEFORE the bridge call; setQueue/setQueueAndPlay/refreshQueue reset
    /// the stored set AFTER), leaving the engine permanently unsynced and
    /// the instant completion hook dropping almost every `done`. The engine
    /// now derives the window itself (`syncPreloadWindow`); see
    /// BackgroundAudioCore/PreloadWindow.swift.

    private func emitPreload(_ trackId: String, _ state: String, _ progress: Double?) {
        // The bridge's event name is "progress"; the diff BASELINE stores the
        // semantic state ("fetching") so PreloadProgress.event's 1 % window
        // actually dedupes steady ticks (a "progress"-vs-"fetching" compare
        // was always different → every in-flight row re-emitted every second)
        // and pass 2's `last?.state == "fetching"` gone-transition can match.
        let baselineState = state == "progress" ? "fetching" : state
        lastPreloadEmitted[trackId] = PreloadProgress(state: baselineState, progress: progress)
        onPreloadProgress?(trackId, state, progress)
    }

    /// 1 s sampler over the loader's in-flight download counters. URLSession
    /// exposes no progress callback, so polling `countOfBytesReceived` is the
    /// only source; the pure PreloadProgress diff keeps the bridge silent
    /// unless a state actually moved. The CURRENT track bypasses the visible-
    /// window guard: its byte progress drives the seek bar's loaded layer
    /// (native §3.4 — the bar renders the whole-file progress the web buffered
    /// layer approximates). Completion/gone transitions are also driven here
    /// so a completion that lands while playback is PAUSED still reaches JS on
    /// the next tick (the sampler runs from engagement until stopPlayback —
    /// downloads keep running while paused, and their tints must not freeze;
    /// the user's "indicator has a brief period of movement then freezes").
    private func tickPreloadProgress() {
        // A15 Phase 1: maturation stage transitions ride the same 1 s tick
        // (events only — no schedule behavior changes until Phase 2).
        loader.tickMaturation()
        let currentId = currentTrackId
        // F4: the streamed track's writer rides the SAME progress channel as
        // the downloadTasks — the seek-bar loaded layer and queue-row tint
        // fill during streaming too (the writer never appears in the
        // in-flight map; without this it was invisible for its whole life).
        let writerRow = loader.writerProgress
        for (key, trackId, received, expected) in loader.inFlightProgress + (writerRow.map { [$0] } ?? []) {
            if trackId != currentId, !preloadWindowIds.contains(trackId) { continue }
            let ratio: Double? = {
                guard let expected = expected, expected > 0 else { return nil }
                return min(max(Double(received) / Double(expected), 0), 1)
            }()
            if let snapshot = PreloadProgress.event(lastEmitted: lastPreloadEmitted[trackId],
                                                    observed: PreloadProgress(state: "fetching", progress: ratio)) {
                emitPreload(trackId, "progress", snapshot.progress)
            }
        }
        // Completions + cached-row announcements. Two blind spots the
        // in-flight pass above can never see (the "preload indicators stay
        // empty" report, 2026-09-14):
        //  1. A download that starts AND finishes between two ticks (fast LAN
        //     server, small file) is absent from `inFlight` at tick time —
        //     its completion must still reach JS.
        //  2. A row served straight from the loader cache (prefetched on an
        //     earlier pass) never appears in `inFlight` at all.
        // Both are diffs against the loader CACHE, not the in-flight map:
        // any visible row that is cached but not announced `done` announces
        // it once; a previously-fetching row that is neither in flight nor
        // cached announces `gone`. Rows with no bytes and no history stay
        // silent (dim = queued — never invent progress).
        var candidates = Set(lastPreloadEmitted.keys)
        candidates.formUnion(preloadWindowIds)
        // The CURRENT track is a candidate too: a cache-served track (played
        // in an earlier session — cache filenames are stable across launches)
        // never downloads, so its completion hook never fires and the seek
        // bar's loaded layer would stay hidden forever. The pass announces
        // its cached state once; rows still downloading are owned by pass 1.
        candidates.insert(currentId)
        // F4: the active writer's track counts as in-flight here too — pass
        // 1 owns its progress; a track served by the writer must never be
        // misread by this pass as "fetching → gone".
        var inFlightIds = Set(loader.inFlightProgress.map { $0.trackId })
        if let writerRow { inFlightIds.insert(writerRow.trackId) }
        for trackId in candidates {
            if trackId != currentId, !preloadWindowIds.contains(trackId) { continue }
            if inFlightIds.contains(trackId) { continue } // pass 1 owns it this tick
            let prefix = trackId + "|"
            let cached = loader.cacheKeys.contains { $0.hasPrefix(prefix) }
            let last = lastPreloadEmitted[trackId]
            if cached {
                if last?.state != "done" { emitPreload(trackId, "done", 1) }
            } else if last?.state == "fetching" {
                emitPreload(trackId, "gone", nil)
            }
        }
        // A15 Phase 2: the staged monitor rides the same tick — the only job
        // left here after the resume decision moved to the writer's progress
        // events is the stall give-up (10 s of zero progress).
        streamMonitorTick()
        // D1 (2026-09-23 field dumps): the dead-air watchdog. The abort path
        // (a standby dying mid-fade) leaves the active node playing its
        // "remaining tail" — which is ~0 s when the fade had run 10 s into
        // the last 15 — and the completion that should advance is gone with
        // the fade teardown. The result: silence with the clock climbing
        // past the scheduled end until a manual skip (the "crossfade then
        // stop" report, twice in one session). A playing, measurable clock
        // more than the grace past the scheduled segment's own end is ALWAYS
        // the wedge — a healthy track advances at its data end via its
        // completion — so the engine advances itself here. This tick runs for
        // the whole engaged session (it survives fade suppression and the
        // staged state), which is why the watchdog lives here and not in the
        // crossfade monitor (suppressed by fadeAbortedTrackId) or the staged
        // monitor (nil without a staged schedule).
        checkDeadAir()
    }

    // MARK: Active-load retry (2026-09-24 dump-2, the 33-minute dead air)

    /// NATIVE-side bounded retry for the ACTIVE track's loader attempts.
    /// "Stream failed before start" delivers to the JS retry machine — which
    /// is suspended while the app is backgrounded, so the retry's single
    /// hung request sat for 33 wall-clock minutes until the user returned
    /// (the dump: two timeouts 33 min apart, no native attempt between).
    /// The engine may not self-advance past a dead row, but it CAN re-attempt
    /// the SAME row: each attempt is bounded (120 s request + 600 s resource
    /// timeout), so audio recovers by itself when connectivity returns.
    /// After the consecutive cap the row yields to the JS retry on the
    /// foreground return — one error, the bounded advance, no dead air.
    /// KEYED BY CACHE KEY: a user skip changes the active row and the
    /// natural loader bookkeeping makes the stale entry irrelevant.
    /// Teardown-owned: `cancelActiveLoadRetries` (stopPlayback) disarms.
    /// The failure detail the engine's captured closures hand back (kind + description).
    struct ActiveLoadFailure {
        enum Kind { case stream, download }
        let kind: Kind
        let detail: String
    }
    /// Generous for a backgrounded stream: six × (timeout-bounded attempt +
    /// 3 s spacing) ≈ 12+ minutes of autonomous recovery per phase.
    private static let activeLoadRetryDelaySeconds: TimeInterval = 3.0
    private static let activeLoadMaxConsecutiveRetries = 6
    /// The long-haul backup: a hung request whose timers were frozen by the
    /// suspension (the dump's 33-minute gap) would wait indefinitely —
    /// this kick re-attempts AFTER `longHaulKickSeconds` of consecutive
    /// silence regardless of the cap, so playback resumes unattended even
    /// if every attempt's error callback was also swallowed.
    private static let longHaulKickSeconds: TimeInterval = 60.0

    private var activeLoadRetryTimer: Timer? = nil
    private var activeLoadLongHaulTimer: Timer? = nil
    private var activeLoadRetryCount: [String: Int] = [:]

    /// The engine calls this at every loadAndStart of a REMOTE track: resets
    /// the consecutive counter for the row being loaded (the JS retry's own
    /// re-engage counts as a fresh phase — the give-up ladder still works
    /// across the native phases, just with native attempts interleaved) and
    /// cancels any pending retry timer for it (the real load is starting).
    func noteActiveLoadStart(trackId: String, variant: TrackVariant) {
        let key = transcodeCacheKey(trackId: trackId, variant: variant)
        if activeLoadRetryTimer != nil || activeLoadLongHaulTimer != nil {
            eventAdd(.info, "loader", "active-load retry state cleared by a new load attempt (\(trackId))")
        }
        activeLoadRetryTimer?.invalidate()
        activeLoadRetryTimer = nil
        activeLoadLongHaulTimer?.invalidate()
        activeLoadLongHaulTimer = nil
        activeLoadRetryCount[key] = 0
    }

    /// Bounded native re-attempt of the SAME active row after a "failed
    /// before start" loader error. Capped: past the cap, the row yields to
    /// the JS retry (one foreground error → the bounded advance) instead of
    /// cycling autonomously forever. Re-arms BOTH timers: the immediate
    /// schedule and the long-haul kick (either may fire; the other
    /// invalidates).
    func scheduleActiveLoadRetry(track: NativeTrack, failure: ActiveLoadFailure) {
        let requested = TrackVariant(url: track.url)
        let key = transcodeCacheKey(trackId: track.trackId, variant: requested)
        let count = (activeLoadRetryCount[key] ?? 0) + 1
        activeLoadRetryCount[key] = count
        // FOREGROUND-AWARE CAP (2026-09-24 design review): silent retries
        // must not out-wait a watching user — in the foreground (2 attempts)
        // the row yields to the JS retry quickly, where its bounded ladder
        // can advance past a dead row; backgrounded (6) the recovery owns
        // the silence the user cannot see.
        let maxAttempts: Int
        if NSClassFromString("UIApplication") != nil,
           UIApplication.shared.applicationState != .background {
            maxAttempts = 2
        } else {
            maxAttempts = Self.activeLoadMaxConsecutiveRetries
        }
        guard count <= maxAttempts else {
            eventAdd(.danger, "loader", "active-load retry exhausted (\(count - 1) native attempts, cap \(maxAttempts)) for \(track.trackId): \(failure.detail) — yielding to the JS retry")
            // THE YIELD REPORTS: the JS retry machine's bounded ladder owns
            // the row from here — without this report the cap would end in
            // an unreported silent stop (the exact dump-2 defect, re-shaped).
            onError?("Stream failed before start: \(failure.detail)")
            return
        }
        activeLoadRetryTimer?.invalidate()
        activeLoadLongHaulTimer?.invalidate()
        let attempt = count
        activeLoadRetryTimer = Timer(timeInterval: Self.activeLoadRetryDelaySeconds, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.activeLoadRetryTimer = nil
            self.retryActiveLoad(track: track, attempt: attempt, failure: failure)
        }
        RunLoop.main.add(activeLoadRetryTimer!, forMode: .common)
        activeLoadLongHaulTimer = Timer(timeInterval: Self.longHaulKickSeconds, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.activeLoadLongHaulTimer = nil
            guard self.activeLoadRetryTimer != nil else { return }
            // No retry fired for a full minute: the scheduled attempt is
            // hanging behind frozen timers — fire NOW (the dump's shape).
            self.activeLoadRetryTimer?.invalidate()
            self.activeLoadRetryTimer = nil
            eventAdd(.info, "loader", "long-haul kick: retrying \(track.trackId) after \(Int(Self.longHaulKickSeconds)) s of retry silence")
            self.retryActiveLoad(track: track, attempt: attempt, failure: failure)
        }
        RunLoop.main.add(activeLoadLongHaulTimer!, forMode: .common)
        eventAdd(.info, "loader", "active-load retry scheduled (\(attempt)/\(Self.activeLoadMaxConsecutiveRetries)) for \(track.trackId) in \(Int(Self.activeLoadRetryDelaySeconds)) s: \(failure.detail)")
    }

    /// The retry body: re-attempt the SAME row through the same loaders the
    /// original load used. Streaming stays preferred (scratch state from the
    /// failed attempt routes the writer's continuation or fresh start);
    /// otherwise the download task Range-resumes the retained prefix.
    private func retryActiveLoad(track: NativeTrack, attempt: Int, failure: ActiveLoadFailure) {
        guard tracks.indices.contains(activeIndex),
              tracks[activeIndex].trackId == track.trackId else { return }
        if loader.hasActiveWriter {
            // A continuation writer is already recovering this key — never
            // race it with a second attempt.
            eventAdd(.info, "loader", "active-load retry \(attempt) skipped — the writer is already live for \(track.trackId)")
            return
        }
        eventAdd(.info, "loader", "active-load retry attempt \(attempt) for \(track.trackId) (failed as \(failure.kind == .stream ? "stream" : "download"))")
        // Route by the SAME gate loadAndStart used: scratch state from the
        // failed attempt makes streamDecision false, so the retry goes down
        // the download path and RANGE-CONTINUES the retained prefix. (A
        // blind re-stream would delete the .part — streamLoad removes any
        // pre-existing scratch — and re-download the whole track.)
        if loader.streamDecision(for: track) {
            startStagedLoadForRetry(track: track, index: activeIndex, autoPlay: true)
        } else {
            let generation = scheduleGeneration
            loader.prefetch(track) { [weak self] url, error in
                guard let self else { return }
                guard generation == self.scheduleGeneration else { return }
                guard self.tracks.indices.contains(self.activeIndex),
                      self.tracks[self.activeIndex].trackId == track.trackId else { return }
                if let url {
                    self.eventAdd(.info, "loader", "active-load retry \(attempt) succeeded for \(track.trackId) — scheduling")
                    self.scheduleCurrentTrack(from: 0, autoPlay: true)
                } else {
                    self.eventAdd(.info, "loader", "active-load retry \(attempt) failed for \(track.trackId): \(error?.localizedDescription ?? "?") — rescheduling")
                    // NO per-attempt onError: a foreground user watching the
                    // row fall would see the JS retry aim its ladder at the
                    // NEXT row (the counter reset bug) — the native retry
                    // owns the loop until the cap yields (one report there).
                    self.scheduleActiveLoadRetry(track: track, failure: failure)
                }
            }
        }
    }

    /// Engine-owned entry so the loader can restart a staged load WITHOUT
    /// the loadAndStart teardown (which would void the live staged state
    /// mid-recovery). Mirrors startStagedLoad's writer arm exactly.
    /// Engine-owned entry so the RETRY can restart a staged load WITHOUT
    /// the loadAndStart teardown (which would void the live staged state
    /// mid-recovery). Mirrors startStagedLoad's writer arm exactly.
    private func startStagedLoadForRetry(track: NativeTrack, index: Int, autoPlay: Bool) {
        if !loader.hasActiveWriter {
            stagedAutoPlay = autoPlay
            eventAdd(.info, "stream", "staged load start row \(index) id=\(track.trackId) autoplay=\(autoPlay) (native retry)")
            let guardedTrackId = track.trackId
            loader.streamLoad(track, onProgress: { [weak self] progress in
                guard let self = self else { return }
                guard self.tracks.indices.contains(self.activeIndex),
                      self.tracks[self.activeIndex].trackId == guardedTrackId else { return }
                self.extendStagedSchedule(progress: progress)
            }, onFinished: { [weak self] progress, error in
                guard let self = self else { return }
                guard self.tracks.indices.contains(self.activeIndex),
                      self.tracks[self.activeIndex].trackId == guardedTrackId else { return }
                if let progress {
                    self.completeStagedSchedule(progress: progress)
                } else if let error = error {
                    // THE RETRY'S OWN attempt failed: silent reschedule (the
                    // cap yields with the single report). A per-attempt
                    // onError would start the JS ladder against a row the
                    // native retry is already recovering — double ownership.
                    let failure = ActiveLoadFailure(kind: .stream, detail: error.localizedDescription)
                    self.teardownStagedState()
                    self.scheduleActiveLoadRetry(track: track, failure: failure)
                }
            }, onArrival: { [weak self] deliveredBytes in
                guard let self = self else { return }
                guard self.tracks.indices.contains(self.activeIndex),
                      self.tracks[self.activeIndex].trackId == guardedTrackId else { return }
                self.recordStreamArrival(deliveredBytes: deliveredBytes)
            })
        } else {
            // A writer is already live for this key (e.g. the continuation
            // path re-armed one): the schedule will grow from its progress.
            eventAdd(.info, "stream", "retry found the writer already live for \(track.trackId) — letting it run")
        }
    }

    /// The failure report is FOREGROUND-GATED (2026-09-24 design review):
    /// backgrounded, the JS retry machine is suspended — a report queues a
    /// retry that can't run and (after a give-up) would later misfire at the
    /// wrong row; the silent native retry owns backgrounded recovery.
    /// Foreground, the user is watching — report immediately (the JS
    /// re-engage then resets the native counter via noteActiveLoadStart).
    /// The cap-yield in scheduleActiveLoadRetry reports UNCONDITIONALLY:
    /// it is the single bounded resolution when every native attempt failed.
    private func reportActiveLoadFailure(track: NativeTrack, failure: ActiveLoadFailure) {
        if NSClassFromString("UIApplication") != nil,
           UIApplication.shared.applicationState != .background {
            onError?("Stream failed before start: \(failure.detail)")
        }
    }

    /// Cancels pending active-load retries (teardown: stopPlayback, sleep
    /// end, queue end). The consecutive counter survives — a fresh
    /// noteActiveLoadStart reset governs it.
    func cancelActiveLoadRetries() {
        activeLoadRetryTimer?.invalidate()
        activeLoadRetryTimer = nil
        activeLoadLongHaulTimer?.invalidate()
        activeLoadLongHaulTimer = nil
    }

    /// D1: the wedge verdict + advance. Re-checked at tick time (1 s) — the
    /// state may have moved since the sampler tick began. Only advances when
    /// the pure verdict says every wedge condition holds; logs the evidence
    /// (elapsed vs scheduled end, the abort flag) so the next dump can
    /// verify the advance instead of a silent stop.
    private func checkDeadAir() {
        // A staged schedule IN FLIGHT owns its own end machinery (the
        // buffering stall / staged advance); its scheduledEndFrames is a
        // moving estimate, not a wedge reference. A COMPLETE staged schedule
        // is the exception: its scheduledEndFrames is FILE TRUTH
        // (completeStagedSchedule chains the tail to file.length), so a
        // clock running past it is the same exhausted-node wedge as any
        // fixed schedule — notably after an abort-keep-active on a
        // staged-complete track's mid-fade premature completion (the
        // 2026-09-21e minimum response leaves ~0 s of tail and NO further
        // completion; without this the watchdog would stand down exactly
        // where dead air begins).
        guard stagedSchedule == nil || stagedSchedule?.isComplete == true,
              hasLiveSchedule, scheduledSegmentSeconds > 0 else { return }
        guard StreamSchedule.deadAirAdvanceEligible(
            isPlaying: isPlaying,
            timeMeasured: isNodeTimeMeasured,
            elapsedSeconds: max(0, currentPosition),
            scheduledEndSeconds: scheduledSegmentSeconds,
            loopOne: loopMode == .one) else { return }
        let elapsedOneDp = String(format: "%.1f", max(0, currentPosition))
        let endOneDp = String(format: "%.1f", scheduledSegmentSeconds)
        let aborted = fadeAbortedTrackId == currentTrackId ? " (fade aborted earlier)" : ""
        eventAdd(.danger, "engine", "dead-air advance: clock \(elapsedOneDp)s ran past the scheduled end \(endOneDp)s\(aborted) with no completion — node exhausted, advancing")
        if sleepAtTrackEnd {
            sleepAtTrackEnd = false
            pause()
            waitingAtTrackEnd = true
            onSleepTimerFired?()
            return
        }
        if let next = nextIndex(after: activeIndex) {
            eventAdd(.info, "engine", "natural advance \(activeIndex)→\(next) (dead-air) (\(tracks.indices.contains(next) ? tracks[next].trackId : "-"))")
            playTrack(at: next, autoPlay: true, origin: .engineAdvance)
        } else {
            handleTrackEnd()
        }
    }

    private func startPreloadProgressTimer() {
        stopPreloadProgressTimer()
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.tickPreloadProgress()
        }
        preloadProgressTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopPreloadProgressTimer() {
        preloadProgressTimer?.invalidate()
        preloadProgressTimer = nil
    }

    /// Sets the native sleep timer. `active=false` cancels any pending timer;
    /// `mode == "endOfTrack"` pauses at the current track's natural end; minutes
    /// mode pauses after `minutes` from now. Works in the background because it
    /// runs on the main run loop like every other timer in this engine.
    public func setSleepTimer(active: Bool, mode: String, minutes: Double) {
        sleepTimer?.invalidate()
        sleepTimer = nil
        sleepAtTrackEnd = false
        guard active else { return }

        if mode == "endOfTrack" {
            sleepAtTrackEnd = true
            // A natural end must be reached cleanly — tear down any armed/in-flight
            // crossfade so the active player's own completion triggers the pause.
            let hadCrossfade = crossfade.isActive
            stopCrossfadeMonitor()
            stopVolumeRamp()
            if hadCrossfade {
                standbyScheduleGeneration += 1
                standbyNode.stop()
                refreshActiveGain()
            }
            standbyGain.outputVolume = 0
            crossfade = .idle
            return
        }

        let interval = max(1, minutes * 60)
        let timer = Timer(timeInterval: interval, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.sleepAtTrackEnd = false
            self.pause()
            self.onSleepTimerFired?()
        }
        sleepTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    public func applyFilters(_ filters: [NativeFilterConfig], bypassed: Bool) {
        let bands = eq.bands
        for band in bands { band.bypass = true }

        let active = filters.filter { $0.enabled && !bypassed }.prefix(bands.count)
        for (i, cfg) in active.enumerated() {
            let band = bands[i]
            band.filterType = Self.mapFilterType(cfg.type)
            band.frequency = Float(max(20, min(20000, cfg.frequency)))
            band.gain = Float(max(-12, min(12, cfg.gain)))
            band.bandwidth = Float(1.0 / max(cfg.q, 0.05))
            band.bypass = false
        }
    }

    // MARK: - State

    public var currentIndex: Int { activeIndex }
    public var isCurrentlyPlaying: Bool { isPlaying }
    public var queueCount: Int { tracks.count }
    public var currentTrackId: String { currentTrack()?.trackId ?? "" }

    public func currentTrack() -> NativeTrack? {
        tracks.indices.contains(activeIndex) ? tracks[activeIndex] : nil
    }

    public func state() -> NativeEngineState {
        let track = tracks.indices.contains(activeIndex) ? tracks[activeIndex] : nil
        return NativeEngineState(
            index: activeIndex,
            trackId: track?.trackId ?? "",
            position: currentPosition,
            duration: track.map(effectiveDuration) ?? 0,
            playing: isPlaying,
            speed: speed
        )
    }

    public func debugState() -> [String: Any] {
        let track = tracks.indices.contains(activeIndex) ? tracks[activeIndex] : nil
        let hasLocal = track.flatMap { loader.localURL(for: $0) != nil } ?? false
        let loaderStats = loader.stats()
        return [
            "isRunning": engine.isRunning,
            "isPlaying": isPlaying,
            "hasLiveSchedule": hasLiveSchedule,
            "activeIndex": activeIndex,
            "queueCount": tracks.count,
            "activeTrackId": track?.trackId ?? "",
            "activeTitle": track?.title ?? "",
            "cachedPosition": cachedPosition,
            "positionBias": positionBias,
            "currentPosition": currentPosition,
            "scheduleGeneration": scheduleGeneration,
            "standbyGeneration": standbyScheduleGeneration,
            "crossfadePhase": "\(crossfade.phase)",
            "crossfadeTarget": crossfade.isActive ? crossfade.targetIndex : -1,
            "activeGain": activeGain.outputVolume,
            "standbyGain": standbyGain.outputVolume,
            "preampVolume": preamp.outputVolume,
            "masterVolume": masterVolume,
            "lastLaunchCrash": lastLaunchCrash ?? "none",
            "preampDb": preampDb,
            "hasLocalURL": hasLocal,
            "computedDurations": computedDurations.count,
            "waitingAtTrackEnd": waitingAtTrackEnd,
            "sleepAtTrackEnd": sleepAtTrackEnd,
            "paramsDirty": paramsDirty,
            "speed": speed,
            "pitchOctaves": pitchOctaves,
            "tapeMode": tapeMode,
            // 2026-09-19 expansion: every state an assumption in the
            // completion/crossfade/advance logic keys on must be dump-visible.
            "duration": track.map(effectiveDuration) ?? 0,
            "scheduledSegmentSeconds": scheduledSegmentSeconds,
            "nodeTimeMeasured": isNodeTimeMeasured,
            "loopMode": loopMode.rawValue,
            "crossfadeDuration": crossfadeDuration,
            "crossfadeCurve": crossfadeCurve,
            "preloadCount": preloadCount,
            "replayGainMode": replayGainMode,
            "prefetchGeneration": prefetchGeneration,
            // Resumable-download scratch state (2026-09-21): dump-visible so
            // a stuck resume is diagnosable from the field.
            "loaderPendingResume": loader.pendingResumeScratchCount,
            // A15 Phase 1: staged-model field evidence (stage per in-flight
            // key; empty until a slow-link session shows maturation).
            "maturationStages": loader.maturationSummary,
            // A15: the live staged schedule's every decision input.
            "streamActive": stagedSchedule != nil,
            "streamComplete": stagedSchedule?.isComplete ?? false,
            "streamStalled": stagedSchedule?.isStalled ?? false,
            "streamDeliveredBytes": stagedSchedule?.deliveredBytes ?? 0,
            "streamAnnouncedBytes": stagedSchedule?.announcedBytes ?? 0,
            "streamScheduledEndFrames": stagedSchedule?.scheduledEndFrames ?? 0,
            "streamHeaderClaimedFrames": stagedSchedule?.headerClaimedFrames ?? 0,
            "streamChainedPending": pendingChainedSegments.values.reduce(0, +),
            "streamRecentRate": loader.recentTransferRate ?? 0,
            "standbyScheduleGeneration": standbyScheduleGeneration,
            "standbyGenerationCaptured": standbyGeneration,
            "seekSuppressed": track.map { $0.trackId == seekSuppressedTrackId } ?? false,
            "fadeSuppressed": track.map { $0.trackId == fadeAbortedTrackId } ?? false,
            "loaderCached": loaderStats.cached,
            "loaderInFlight": loaderStats.inFlight,
            // A15 Phase 2: the staged schedule's live state — a dump must
            // verify every assumption the streaming contract makes.
            "stagedActive": stagedSchedule != nil,
            "stagedComplete": stagedSchedule?.isComplete ?? false,
            "stagedStalled": stagedSchedule?.isStalled ?? false,
            "stagedFadeEligible": stagedSchedule.map { StreamSchedule.fadeEligibility(isScheduleComplete: $0.isComplete) } ?? false,
            "stagedEndSeconds": stagedSchedule.map { $0.scheduledEndSeconds } ?? 0,
            "stagedDeliveredBytes": stagedSchedule?.deliveredBytes ?? 0,
            "stagedAnnouncedBytes": stagedSchedule?.announcedBytes ?? 0,
            "eventLogNextSeq": eventLog.nextSeq,
            "eventLogDropped": eventLog.droppedCount,
            "debugDomains": eventLog.activeDomains.sorted().joined(separator: ","),
        ]
    }

    /// Position within the current track, in seconds.
    public var currentPosition: Double {
        let measured = nodeElapsedSeconds(activeNode)
        if let measured { return max(0, measured + positionBias) }
        return cachedPosition
    }

    /// Whether the active player's clock is currently MEASURABLE. When it is
    /// not (never rendered, or the OS dropped the time after data ran out),
    /// `currentPosition` silently falls back to `cachedPosition` — a stale
    /// value that must never be judged as elapsed audio. The premature-
    /// completion gate in `handleSegmentCompletion` keys on this.
    var isNodeTimeMeasured: Bool {
        nodeElapsedSeconds(activeNode) != nil
    }

    /// The node's OWN consumed-frame position in seconds (1.2.41): the
    /// player-timeline read (`playerTime(forNodeTime: lastRenderTime)`) —
    /// the exact read `currentPosition` has always made, refactored so any
    /// node can be measured. The frame count is what the node itself
    /// reports; bias/bias-bridging is the CALLER's concern (they know
    /// which timeline the node is playing). Nil when the clock is
    /// unreadable at this instant (nil lastRenderTime/playerTime) — the
    /// per-node form of the §3.4 unmeasurable-clock rule.
    private func nodeElapsedSeconds(_ node: AVAudioPlayerNode?) -> Double? {
        guard let node,
              let nodeTime = node.lastRenderTime,
              let playerTime = node.playerTime(forNodeTime: nodeTime) else { return nil }
        return Double(playerTime.sampleTime) / playerTime.sampleRate
    }

    /// Captures the COMPLETING node's own position INSIDE a segment
    /// completion callback — on the render thread, BEFORE the main hop.
    /// By handler time the node may be stopped/retired and its clock gone;
    /// the capture is the only trustworthy node reading. Nil = no node
    /// evidence at handler time (the wall read or `.unmeasured` rules).
    ///
    /// The raw sampleTime is CONVERTED to the schedule's bias-bridged
    /// timeline HERE (bias is schedule state — reading it at handler time
    /// is wrong; `finalizeCrossfadeSwitch` and seeks rewrite it), so the
    /// value rides the hop self-contained. `guard isPlaying` is
    /// deliberately ABSENT: a completing node is about to stop the
    /// engine's playing state, and the point is to read the clock exactly
    /// once, at completion time.
    private func captureNodeElapsed(for node: AVAudioPlayerNode?, bias: Double) -> Double? {
        guard let raw = nodeElapsedSeconds(node) else { return nil }
        return raw + bias
    }

    // MARK: - Scheduling internals

    private func effectiveDuration(of track: NativeTrack) -> Double {
        if track.duration > 0 { return track.duration }
        // Memo hit requires the file to still be in the loader cache: an
        // evicted file (cleanup radius, corrupt re-download) must re-probe once
        // it lands again, or a re-downloaded file with a different length keeps
        // a stale duration forever. `localURL` is a cache lookup (no file I/O),
        // so this guard keeps the memo fresh at ~zero cost.
        if let cached = computedDurations[track.trackId],
           loader.localURL(for: track) != nil {
            return cached
        }
        var duration = 0.0
        if let url = loader.localURL(for: track),
           let file = try? AVAudioFile(forReading: url) {
            duration = Double(file.length) / file.processingFormat.sampleRate
        }
        if duration > 0 { computedDurations[track.trackId] = duration }
        return duration
    }

    private func loadAndStart(currentIndex index: Int, autoPlay: Bool) {
        guard tracks.indices.contains(index) else {
            stopPlayback()
            onQueueEnded?()
            return
        }
        let track = tracks[index]
        cancelScheduled()
        hasLiveSchedule = false
        positionBias = 0
        cachedPosition = 0
        // A new load abandons any staged state (the staged path never spans
        // tracks; the previous track's writer is torn down by evict/cleanup
        // or finishes independently).
        teardownStagedState()

        // A15 PHASE 2: the streaming decision rides BEFORE the prefetch. A
        // direct tap on a slow link (policy mode + loader evidence) starts
        // the staged writer instead of waiting for the full download. Any
        // no (mode off, transcode variant, in-flight downloadTask, scratch
        // state, no Range support, no size/duration evidence, fast link)
        // falls through to the unchanged full-download path below — today's
        // behavior byte-for-byte. A staged load deliberately does NOT arm
        // prefetchUpcoming here: the writer owns the bandwidth, and the
        // chain arms when the writer completes (completeStagedSchedule).
        // ACTIVE-LOAD RETRY arm (2026-09-24 dump-2): this row's remote load
        // starts now — reset its consecutive-retry counter and cancel any
        // pending retry timer a previous failure scheduled. Covers BOTH the
        // staged and the download path.
        if !track.url.isFileURL {
            noteActiveLoadStart(trackId: track.trackId, variant: TrackVariant(url: track.url))
        }
        if loader.streamDecision(for: track) {
            startStagedLoad(track: track, index: index, autoPlay: autoPlay)
            return
        }

        let generation = scheduleGeneration
        loader.prefetch(track) { [weak self] url, error in
            guard let self = self else { return }
            // The user moved on (next-skip, another load) while this file was
            // downloading — leave the newer schedule alone.
            guard generation == self.scheduleGeneration else {
                eventAdd(.info, "engine", "loadAndStart dropped stale generation \(generation) vs \(self.scheduleGeneration) for \(track.trackId)")
                return
            }
            guard let url = url else {
                // ACTIVE-LOAD RETRY arm (dump-2): the same foreground-gated
                // report + silent native retry as the stream path.
                let failure = ActiveLoadFailure(
                    kind: .download,
                    detail: error?.localizedDescription ?? "Failed to load track")
                self.reportActiveLoadFailure(track: track, failure: failure)
                self.scheduleActiveLoadRetry(track: track, failure: failure)
                return
            }
            guard self.tracks.indices.contains(self.activeIndex),
                  self.tracks[self.activeIndex].trackId == track.trackId else {
                let current = self.tracks.indices.contains(self.activeIndex) ? self.tracks[self.activeIndex].trackId : "OOR"
                // 2026-09-19: SILENT drop, not an error. The engine's
                // activeIndex only moves to another track via a NEWER load
                // (playTrack/engage) — which owns the engine and schedules
                // its own audio. Reporting "Track diverged" as an error fed
                // the JS retry machine a systematic failure for a track that
                // was never supposed to load — the amplifier behind the
                // 1.2.28 same-track loop. Same semantics as the stale
                // generation guard above: a newer schedule owns the engine.
                eventAdd(.info, "engine", "loadAndStart dropped divergent track \(track.trackId) vs \(current) gen=\(generation) active=\(self.activeIndex)")
                return
            }
            let currentIndex = self.activeIndex
            self.loader.cleanup(
                currentIndex: currentIndex,
                tracks: self.tracks,
                keepRadius: max(3, self.preloadCount + 1)
            )
            self.prefetchUpcoming(from: currentIndex)
            self.scheduleCurrentTrack(from: 0, autoPlay: autoPlay)
            // NOTE for A15 Phase 2: a staged load (streamDecision said yes in
            // loadAndStart above) never reaches this prefetchUpcoming — its
            // writer owns the bandwidth and the chain arms at the writer's
            // completion instead (completeStagedSchedule).
        }
    }

    /// Prefetches the configured upcoming rows SEQUENTIALLY — queue order is
    /// the priority order (web preloader A14 parity): the immediate successor
    /// downloads first and COMPLETES before the row behind it starts, so a
    /// slow link never leaves the next track waiting behind track 5. The old
    /// all-at-once loop made every download share bandwidth (the user report:
    /// "tracks are preloaded in parallel instead of sequentially"). A failure
    /// logs, clears the row's tint ("gone") and CONTINUES the chain; the row
    /// stays uncached and is re-attempted by the next natural advance's
    /// prefetchUpcoming (continuation, not a strand). Crossfade keeps
    /// reserving the immediate successor even at preloadCount 0. Each
    /// completion re-checks the crossfade monitor so a target that becomes
    /// ready inside the fade window does not wait for the next 100 ms tick.
    /// A chain is generation-guarded: a queue replacement (setQueue/refresh)
    /// bumps `prefetchGeneration` and the surviving completions drop the rest.
    /// Bounded per-row prefetch retries (2026-09-21, the "preload shows nothing"
    /// report): the old chain MOVED PAST a failed row and never came back — on
    /// a flaky cellular link every re-arm died at the same row N+1
    /// (`cannot parse response`, URLSession's response-parse failure), so the
    /// loader stayed at cache=1 with preload=5 for whole sessions. The chain
    /// now re-attempts the failed row up to `prefetchMaxAttempts` times with a
    /// short backoff before moving past it. Generation-guarded throughout:
    /// a queue/track change kills pending backoffs with the rest of the chain.
    private static let prefetchMaxAttempts = 3
    private static let prefetchRetryBackoffNanos: UInt64 = 1_500_000_000

    private func prefetchUpcoming(from index: Int, total: Int? = nil, seen: Set<Int> = [], generation: Int? = nil, attempt: Int = 1) {
        let totalCount = total ?? (crossfadeDuration > 0 ? max(1, preloadCount) : preloadCount)
        guard totalCount > 0, seen.count < totalCount else { return }
        let gen = generation ?? prefetchGeneration
        // Function parameters are constants; the dedupe set mutates per step.
        var seen = seen
        guard let next = nextIndex(after: index),
              tracks.indices.contains(next),
              seen.insert(next).inserted else { return }
        let track = tracks[next]
        let seenSnapshot = seen // Sendable capture: the Task below must not
        // reference the mutating var (Swift 6 concurrency, CI compile).
        eventAdd(.debug, "preload", "chain: prefetch row \(next) (\(track.trackId)) attempt \(attempt)")
        loader.prefetch(track) { [weak self] _, error in
            guard let self = self else { return }
            guard gen == self.prefetchGeneration else { return }
            guard let error else {
                self.crossfadeMonitorTick()
                self.prefetchUpcoming(from: next, total: totalCount, seen: seen, generation: gen)
                return
            }
            // A failed prefetch must not sit "fetching" forever (frozen-tint
            // report): gone clears the row's tint now.
            self.emitPreload(track.trackId, "gone", nil)
            if attempt < Self.prefetchMaxAttempts {
                self.eventAdd(.info, "preload", "prefetch FAILED row \(next) (\(track.trackId)) attempt \(attempt)/\(Self.prefetchMaxAttempts): \(error.localizedDescription) — retrying")
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: Self.prefetchRetryBackoffNanos)
                    guard let self, gen == self.prefetchGeneration else { return }
                    self.prefetchUpcoming(from: index, total: totalCount, seen: seenSnapshot, generation: gen, attempt: attempt + 1)
                }
            } else {
                self.eventAdd(.danger, "preload", "prefetch FAILED row \(next) (\(track.trackId)) after \(attempt) attempts: \(error.localizedDescription) — moving on")
                self.crossfadeMonitorTick()
                self.prefetchUpcoming(from: next, total: totalCount, seen: seen, generation: gen)
            }
        }
    }

    /// Schedules the current track on the active node, ready to play.
    ///
    /// STAGED-AWARE (A15 Phase 2): when `stagedSchedule` is live, the source
    /// is the growing `.part` and the schedule ends at the DELIVERED-END
    /// ESTIMATE (never the header claim) — the schedule contract. Growth is
    /// chained-segment extension; running out of delivered bytes is the
    /// buffering pause, never an advance.
    ///
    /// 1.2.41: the NATURAL path's completion rides `.dataPlayedBack` — it
    /// fires after the last frame RENDERS, so the completion callback can
    /// capture the node's own consumed-frame position AT (not ~1 s before)
    /// the schedule end, eliminating the read-ahead slop the premature gate
    /// previously epsilon-tolerated. The staged path keeps `.dataConsumed`
    /// (chain bookkeeping must not lag one buffer behind).
    private func scheduleCurrentTrack(from seconds: Double, autoPlay: Bool) {
        // Never-judged until this schedule proves its own length: an early
        // return (not-ready, corrupt, zero-frame) must not leave the previous
        // track's segment length behind for the gate to misread.
        scheduledSegmentSeconds = 0
        guard tracks.indices.contains(activeIndex) else { return }
        let track = tracks[activeIndex]

        // ---- Staged path: the growing .part is the source ----------------
        if stagedSchedule != nil, let stagedURL = stagedSourceURL {
            guard var staged = stagedSchedule else { return }
            guard let file = try? AVAudioFile(forReading: stagedURL) else {
                // The .part vanished or became unreadable mid-stream: treat
                // like a stream failure (the scratch may still exist for a
                // Range-continue; the JS retry re-engages).
                teardownStagedState()
                onError?("Stream source unreadable: \(track.title)")
                return
            }
            let sr = file.processingFormat.sampleRate
            staged.headerClaimedFrames = file.length
            staged.sampleRate = sr
            let startFrame = Int64(seconds * sr)
            // COMPLETE → the header claim is FILE TRUTH (gates passed):
            // schedule to the real end. Staged → the delivered-end estimate.
            let endable = staged.isComplete
                ? file.length
                : StreamSchedule.estimatedFramesEndable(
                    headerClaimedFrames: file.length,
                    deliveredBytes: staged.deliveredBytes,
                    announcedBytes: staged.announcedBytes)
            let endFrames = endable
            guard StreamSchedule.canSchedule(startFrame: startFrame, endFrames: endFrames) else {
                // Seek (or stall resume) at/past the delivered end: the
                // buffering pause, not an error. autoPlay=false so the stall
                // resume (or the user's own play tap) restarts audio.
                eventAdd(.info, "stream", "schedule target past delivered end id=\(track.trackId) (seek \(String(format: "%.1f", seconds))s vs endable \(String(format: "%.1f", Double(endFrames) / sr))s) — buffering")
                staged.userPaused = !autoPlay
                staged.isStalled = true
                staged.stalledAtFrames = min(startFrame, endFrames)
                staged.lastProgressAt = Date()
                stagedSchedule = staged
                cachedPosition = seconds
                positionBias = seconds
                setPlaying(false)
                stopCrossfadeMonitor()
                return
            }
            scheduleGeneration += 1
            let generation = scheduleGeneration
            staged.scheduledEndFrames = endFrames
            // A successful schedule REPLACES the stall: isStalled/stalledAt
            // described the PREVIOUS promise, and leaving them set made the
            // resumed track's final completion swallow as "already stalled"
            // (silent queue stall — F6, design review). userPaused too: the
            // schedule only exists because the user (or the auto-resume)
            // asked to play.
            staged.isStalled = false
            staged.userPaused = false
            stagedSchedule = staged
            activeGain.outputVolume = Float(track.replayGainLinear(mode: replayGainMode))
            standbyGain.outputVolume = 0
            standbyNode.stop()
            let player = activeNode
            let scheduledIndex = activeIndex
            let scheduledTrackId = track.trackId
            let scheduledNode = player
            player.stop()
            refreshPlaybackParams()
            // The staged completion must NOT be judged by the natural-end
            // gates (a staged promise ending early is the BUFFERING pause by
            // contract). It rides the isStagedSegment discrimination like a
            // chained segment: if an extension was chained while this base
            // segment renders, its data-consumed completion is a SEGMENT end
            // (silently consumed); with no successor it becomes the staged
            // end (buffering pause, or natural advance once COMPLETE).
            player.scheduleSegment(file, startingFrame: startFrame, frameCount: AVAudioFrameCount(endFrames - startFrame), at: nil, completionCallbackType: .dataConsumed) { [weak self] _ in
                self?.handleSegmentCompletion(index: scheduledIndex, generation: generation, trackId: scheduledTrackId, node: scheduledNode, isStagedSegment: true)
            }
            hasLiveSchedule = true
            positionBias = seconds
            cachedPosition = seconds
            crossfade = .idle
            if autoPlay {
                guard ensureEngineRunning() else {
                    onError?("Audio engine failed to start for \(track.title)")
                    return
                }
                player.play()
                setPlaying(true)
                // Phase 3: fade automation rides the schedule's COMPLETENESS,
                // not its stagedness — a COMPLETE staged track fades like any
                // other; a streaming schedule keeps automation off (the
                // buffering pause would tear a mid-flight fade down).
                if StreamSchedule.fadeEligibility(isScheduleComplete: staged.isComplete) {
                    setupCrossfadeMonitor()
                } else {
                    stopCrossfadeMonitor()
                }
            } else {
                setPlaying(false)
                stopCrossfadeMonitor()
            }
            return
        }
        // ---- Normal path: the completed cache file is the source ---------
        guard let localURL = loader.localURL(for: track) else {
            onError?("Track not ready: \(track.title)")
            return
        }
        guard let file = try? AVAudioFile(forReading: localURL) else {
            // Corrupt or partial download. Evict it so the JS retry loop
            // re-fetches instead of replaying a poisoned file forever.
            // Variant-scoped: the good variants of this track survive.
            loader.evict(track.trackId, variant: TrackVariant(url: track.url))
            onError?("Unsupported audio file: \(track.title)")
            return
        }

        let sr = file.processingFormat.sampleRate
        let totalFrames = file.length
        let startFrame = AVAudioFramePosition(seconds * sr)
        let frames = totalFrames - startFrame
        guard frames > 0 else {
            // 2026-09-17 multi-skip root cause: a ZERO-frame file (truncated
            // download, lying header) used to call handleTrackEnd() here —
            // declaring the WHOLE QUEUE ended over one bad row (the trace:
            // engine paused+ended at row 4 of 55). Evict so the JS retry
            // re-fetches fresh bytes; A5 bounds the retries and the fromError
            // advance moves on if the server keeps poisoning the row.
            if totalFrames <= 0 {
                eventAdd(.danger, "engine", "zero-frame file for \(track.trackId) — evicting for re-fetch")
                loader.evict(track.trackId, variant: TrackVariant(url: track.url))
                onError?("Track file unreadable: \(track.title)")
            } else {
                // Seek/metadata landed past the real end of a DECODABLE file
                // (duration metadata longer than the audio). End THIS track
                // like a natural completion — not the queue.
                eventAdd(.info, "engine", "past-end schedule for \(track.trackId) (frames=\(totalFrames), seek=\(seconds)) — ending just this track")
                handleSegmentCompletion(index: activeIndex, generation: scheduleGeneration, trackId: track.trackId)
            }
            return
        }

        scheduleGeneration += 1
        let generation = scheduleGeneration

        // 2026-09-18 LDM multi-skip: a truncated download's container still
        // reports more audio than the delivered bytes contain (FLAC STREAMINFO
        // / MP4 moov headers; Ogg last-page granule positions), so `frames`
        // can promise audio that was never downloaded. The completion fires
        // when the DATA runs out — the premature-completion gate (plus
        // evict-on-drop) is the defense that catches it. The old byte CLAMP
        // here was removed (2026-09-19): a no-op for real truncations and a
        // false-bound risk for at-floor encodings.
        // The gate reference: what THIS schedule actually promises (file truth).
        scheduledSegmentSeconds = Double(startFrame + frames) / sr

        activeGain.outputVolume = Float(track.replayGainLinear(mode: replayGainMode))
        standbyGain.outputVolume = 0
        standbyNode.stop()

        let player = activeNode
        let scheduledIndex = activeIndex
        // Schedule-time identity rides the completion (2026-09-17): the guard
        // in handleSegmentCompletion compares BOTH the row and the trackId —
        // queue reindexing (refreshQueue re-anchor) invalidates by id, so a
        // reordered tail can never smuggle a stale completion through an
        // accidental index coincidence.
        let scheduledTrackId = track.trackId
        // Node identity rides the completion (2026-09-19): the in-flight
        // crossfade discrimination compares the COMPLETING node with the live
        // standby node. The old schedule-time isStandby flag survived
        // finalizeCrossfadeSwitch, so this node — now the ACTIVE track — had
        // its natural end mislabeled a standby EOF during the NEXT fade: the
        // abort kept an exhausted node "playing" (silence, clock climbing
        // past the track end — the 1.2.28 wedge).
        let scheduledNode = player
        // Schedule-timeline bias rides the capture (1.2.41): the node was
        // stopped (timeline restarts at 0) and plays from `startFrame`, so
        // the node's raw sampleTime is offset by THIS schedule's start
        // position — the `from` seconds, which is exactly what positionBias
        // is set to below. Capture the VALUE, not the variable: reading
        // positionBias at fire time would race a seek/finalize rewrite.
        let scheduledBias = seconds
        player.stop()
        // Both nodes are stopped now: apply speed/pitch/tape fields to the
        // units, which are only ever touched while nothing is rendering.
        refreshPlaybackParams()
        // 1.2.41: the natural path's completion rides .dataPlayedBack — it
        // fires after the last frame RENDERS (not when the data has merely
        // been consumed into the node's read-ahead buffers), so the captured
        // node position sits AT the schedule end. The premature gate's 1 s
        // margin now guards real slop only. The staged/chained paths keep
        // .dataConsumed: their completions are chain bookkeeping and must
        // not wait on render tail (the buffering stall and the post-complete
        // re-arm would lag one buffer behind).
        player.scheduleSegment(file, startingFrame: startFrame, frameCount: AVAudioFrameCount(frames), at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            let nodeElapsed = self?.captureNodeElapsed(for: scheduledNode, bias: scheduledBias)
            self?.handleSegmentCompletion(index: scheduledIndex, generation: generation, trackId: scheduledTrackId, node: scheduledNode, nodeEvidence: nodeElapsed.map { NodeEofEvidence(elapsedSeconds: $0) })
        }

        hasLiveSchedule = true
        positionBias = seconds
        cachedPosition = seconds
        crossfade = .idle

        if autoPlay {
            // Never play() into a stopped engine — that raises (1.2.14 play
            // crash). Degrade to the error event instead; the JS retry
            // machinery re-plays, which re-attempts the engine start.
            guard ensureEngineRunning() else {
                onError?("Audio engine failed to start for \(track.title)")
                return
            }
            player.play()
            setPlaying(true)
            setupCrossfadeMonitor()
        } else {
            setPlaying(false)
            stopCrossfadeMonitor()
        }
    }

    // MARK: - Staged streaming (A15 Phase 2)

    /// The streaming policy mode (mirrored from JS settings; default OFF —
    /// nothing streams until the user or the field data says otherwise).

    /// Live state of the CURRENT staged schedule (nil = no staged track).
    /// The schedule contract lives in `StreamSchedule`; this carries the
    /// per-track instance data the monitor and completion guard read.
    struct StagedSchedule {
        let trackId: String
        var headerClaimedFrames: Int64   // file.length of the PARTIAL file (lies high)
        var sampleRate: Double
        var scheduledEndFrames: Int64    // the current chained schedule's end (the promise)
        var announcedBytes: Int64        // server's exact body length (raw only)
        var deliveredBytes: Int64        // last known delivered byte count
        var isComplete = false           // the writer promoted (gates passed)
        var isStalled = false            // the buffering pause is active
        var stalledAtFrames: Int64 = 0
        var lastProgressAt: Date = Date()
        var userPaused = false           // the user paused during the stall (auto-resume stays paused)
        /// The current promise in seconds (for the buffering-pause event).
        var scheduledEndSeconds: Double { Double(scheduledEndFrames) / max(1, sampleRate) }
    }

    private var stagedSchedule: StagedSchedule? = nil
    /// The autoPlay flag for the pending first staged schedule (captured at
    /// `startStagedLoad` — the tap that asked for the stream).
    private var stagedAutoPlay = false
    /// The file the staged schedule reads from: the growing `.part` while
    /// the writer streams, the promoted destination once COMPLETE. `nil` =
    /// normal cache-served playback (the overwhelmingly common path).
    private var stagedSourceURL: URL? = nil
    /// Chained-segment bookkeeping per NODE (the ONE new invariant): counts
    /// segments scheduled after the currently rendering one, so a data-
    /// consumed completion can be classified segmentEnd (consume silently)
    /// vs trackEnd (natural end). Keyed by node identity, decremented as
    /// completions consume. Cleared on every teardown/cancel.
    private var pendingChainedSegments: [ObjectIdentifier: Int] = [:]

    /// Starts a staged load for the CURRENT track (direct-tap path only —
    /// `streamDecision` already said yes). The writer delivers at the
    /// PLAYABLE crossing; the first delivery opens the partial file and
    /// schedules the honest estimate. A writer failure before any schedule
    /// falls back to the normal `loadAndStart` path via the JS retry.
    private func startStagedLoad(track: NativeTrack, index: Int, autoPlay: Bool) {
        stagedAutoPlay = autoPlay
        eventAdd(.info, "stream", "staged load start row \(index) id=\(track.trackId) autoplay=\(autoPlay)")
        // GUARD BY TRACK IDENTITY, not scheduleGeneration: the resume path
        // (and any seek/param restart) calls cancelScheduled(), which bumps
        // the generation by design — a generation guard here would permanently
        // drop every writer delivery after the FIRST resume, freezing the
        // staged schedule at its initial lead. The track id cannot change
        // while the writer runs (loadAndStart tears down staged state on a
        // new load; evict kills the writer outright).
        let guardedTrackId = track.trackId
        loader.streamLoad(track, onProgress: { [weak self] progress in
            guard let self = self else { return }
            guard self.tracks.indices.contains(self.activeIndex),
                  self.tracks[self.activeIndex].trackId == guardedTrackId else { return }
            self.extendStagedSchedule(progress: progress)
        }, onFinished: { [weak self] progress, error in
            guard let self = self else { return }
            guard self.tracks.indices.contains(self.activeIndex),
                  self.tracks[self.activeIndex].trackId == guardedTrackId else { return }
            if let progress {
                // The writer promoted a COMPLETE file through the gate chain:
                // chain the full-file remainder so the natural end is exact.
                self.completeStagedSchedule(progress: progress)
            } else if let error = error {
                // Hard stream failure. If a staged schedule is live, hand the
                // bounded JS retry a real error (its re-engage Range-continues
                // the retained prefix via the normal prefetch path). Before a
                // schedule exists there is nothing to keep alive — the retry
                // simply re-taps and `streamDecision` falls back (scratch
                // state now present → the resumable download path).
                // BOTH branches arm the native active-load retry (dump-2:
                // backgrounded, the JS machine is suspended and the row sat
                // in dead air for 33 minutes) — foreground-gated reporting
                // keeps the JS ladder as the foreground's fast path.
                let failure = ActiveLoadFailure(kind: .stream, detail: error.localizedDescription)
                if self.stagedSchedule != nil {
                    self.teardownStagedState()
                    self.reportActiveLoadFailure(track: track, failure: failure)
                } else {
                    self.reportActiveLoadFailure(track: track, failure: failure)
                }
                self.scheduleActiveLoadRetry(track: track, failure: failure)
            }
        }, onArrival: { [weak self] deliveredBytes in
            // F2: raw progress ledger — the ONLY keep-alive the stalled
            // schedule and the give-up timer read. Rung-gated deliveries
            // (onProgress) cannot serve this role on a trickle link.
            guard let self = self else { return }
            guard self.tracks.indices.contains(self.activeIndex),
                  self.tracks[self.activeIndex].trackId == guardedTrackId else { return }
            self.recordStreamArrival(deliveredBytes: deliveredBytes)
        })
    }

    /// MAIN, on every byte arrival (F2): update the progress ledger the
    /// stall machinery reads. The schedule resume itself still rides the
    /// rung-gated deliveries (which carry full StreamProgress) — arrivals
    /// only keep the give-up timer honest and unblock resume promptly at
    /// rung cadence (~2-4 s on a trickle link, not ~30-60 s).
    private func recordStreamArrival(deliveredBytes: Int64) {
        guard var staged = stagedSchedule else { return }
        staged.deliveredBytes = deliveredBytes
        staged.lastProgressAt = Date()
        stagedSchedule = staged
    }

    /// MAIN, on each writer delivery: the staged schedule's growth engine.
    /// Not stalled → maybe chain an extension. Stalled → maybe resume.
    /// First delivery → the first honest schedule.
    private func extendStagedSchedule(progress: TrackFileLoader.StreamProgress) {
        guard let current = stagedSchedule, stagedSourceURL != nil else {
            startFirstStagedSchedule(progress: progress)
            return
        }
        var staged = current
        staged.announcedBytes = progress.announcedBytes > 0 ? progress.announcedBytes : staged.announcedBytes
        staged.deliveredBytes = progress.deliveredBytes
        staged.lastProgressAt = Date()
        stagedSchedule = staged
        // Completion arrives via onFinished (writerDidComplete), never as a
        // delivery — deliveries are always staged (.playable).
        if staged.isStalled {
            // Resume decision: ≥ 2 s of NEW audio beyond the stalled position
            // (below the 5 s extension-churn bar: a stall re-schedules
            // everything schedulable, so even a small chunk unblocks).
            let endable = StreamSchedule.estimatedFramesEndable(
                headerClaimedFrames: staged.headerClaimedFrames,
                deliveredBytes: progress.deliveredBytes,
                announcedBytes: staged.announcedBytes)
            if StreamSchedule.shouldResumeAfterStall(
                stalledFrames: staged.stalledAtFrames,
                schedulableEndFrames: endable,
                sampleRate: staged.sampleRate) {
                staged.isStalled = false
                let userPaused = staged.userPaused
                staged.userPaused = false
                stagedSchedule = staged
                let resumeAt = cachedPosition
                eventAdd(.info, "stream", "stall resume at \(String(format: "%.1f", resumeAt))s — re-scheduling from the delivered end (autoPlay=\(!userPaused))")
                // Voids the old chain + chained-segment bookkeeping; the
                // staged state survives (scheduleCurrentTrack reads it) and
                // re-clamps the schedule to the CURRENT delivered estimate.
                cancelScheduled()
                scheduleCurrentTrack(from: resumeAt, autoPlay: !userPaused)
                return
            }
            return
        }
        // Not stalled: maybe chain an extension (≥ 5 s newly schedulable).
        let endable = StreamSchedule.estimatedFramesEndable(
            headerClaimedFrames: staged.headerClaimedFrames,
            deliveredBytes: progress.deliveredBytes,
            announcedBytes: staged.announcedBytes)
        let plan = StreamSchedule.extensionPlan(
            currentEndFrames: staged.scheduledEndFrames,
            schedulableEndFrames: endable,
            sampleRate: staged.sampleRate,
            headerClaimedFrames: staged.headerClaimedFrames)
        if case .extend(let to) = plan {
            chainStagedSegment(staged: &staged, toFrames: to)
        }
        stagedSchedule = staged
    }

    /// Opens the partial file and commits the staged path: the .part becomes
    /// the schedule source and `scheduleCurrentTrack` (staged-aware) makes
    /// the first honest schedule clamped to the delivered-end estimate. The
    /// header must have landed (the file opens); otherwise the delivery is
    /// deferred — the writer keeps rung-delivering and the next one retries.
    private func startFirstStagedSchedule(progress: TrackFileLoader.StreamProgress) {
        guard tracks.indices.contains(activeIndex) else { return }
        let track = tracks[activeIndex]
        guard track.trackId == progress.trackId else { return }
        guard let file = try? AVAudioFile(forReading: progress.url), file.length > 0 else {
            eventAdd(.info, "stream", "partial not openable yet id=\(track.trackId) delivered=\(progress.deliveredBytes)B — deferring first schedule")
            return
        }
        let sr = file.processingFormat.sampleRate
        let endable = StreamSchedule.estimatedFramesEndable(
            headerClaimedFrames: file.length,
            deliveredBytes: progress.deliveredBytes,
            announcedBytes: progress.announcedBytes)
        guard endable > 0 else {
            eventAdd(.info, "stream", "no schedulable evidence yet id=\(track.trackId) — deferring first schedule")
            return
        }
        stagedSourceURL = progress.url
        stagedSchedule = StagedSchedule(
            trackId: track.trackId,
            headerClaimedFrames: file.length,
            sampleRate: sr,
            scheduledEndFrames: 0,
            announcedBytes: progress.announcedBytes,
            deliveredBytes: progress.deliveredBytes)
        eventAdd(.info, "stream", "first staged schedule id=\(track.trackId) endable=\(endable) frames (\(String(format: "%.1f", Double(endable) / sr))s of header claim \(file.length))")
        scheduleCurrentTrack(from: 0, autoPlay: stagedAutoPlay)
    }

    /// The writer promoted a COMPLETE file: the byte gates passed, so the
    /// header claim is now FILE TRUTH. Chain the remaining full-length
    /// segment (the estimate's 2 % slack never truncates the tail) and mark
    /// the schedule complete — its final completion is a REAL natural end.
    private func completeStagedSchedule(progress: TrackFileLoader.StreamProgress) {
        guard var staged = stagedSchedule, !staged.isComplete else { return }
        staged.isComplete = true
        staged.announcedBytes = progress.announcedBytes > 0 ? progress.announcedBytes : staged.announcedBytes
        staged.deliveredBytes = progress.deliveredBytes
        staged.lastProgressAt = Date()
        stagedSourceURL = progress.url
        stagedSchedule = staged
        // Re-open the COMPLETE file: the header claim is now honest, and the
        // chained tail must reach the real end (the estimate under-promised
        // by the 2 % slack).
        if let file = try? AVAudioFile(forReading: progress.url) {
            staged.headerClaimedFrames = file.length
            let endable = StreamSchedule.schedulableEndFrames(
                deliveredEndFrames: file.length,
                headerClaimedFrames: file.length)
            // The COMPLETION tail (F3, design review): no 5 s churn bar —
            // this is the last extension ever, so any remainder must be
            // chained or the estimate's 2 % slack is silence at the end of
            // every streamed track.
            if let tail = StreamSchedule.completionTailPlan(
                currentEndFrames: staged.scheduledEndFrames,
                schedulableEndFrames: endable,
                sampleRate: staged.sampleRate,
                headerClaimedFrames: staged.headerClaimedFrames) {
                chainStagedSegment(staged: &staged, toFrames: tail)
            }
        }
        stagedSchedule = staged
        eventAdd(.info, "stream", "staged schedule complete id=\(staged.trackId) — natural end restored")
        // Phase 3: the schedule just became file truth — fades arm now (if
        // the transition point is ahead) even though they never armed while
        // the track was streaming. Deferred one runloop turn like every
        // post-switch re-arm (the 1.2.31 re-entrancy lesson). If a fade is
        // somehow already in flight the monitor stays hands-off until it
        // resolves (the setup guard reads crossfade state).
        if staged.isStalled == false {
            let rearmGeneration = scheduleGeneration
            DispatchQueue.main.async { [weak self] in
                guard let self, rearmGeneration == self.scheduleGeneration else { return }
                if self.isPlaying, self.crossfade.isInFlight == false {
                    self.setupCrossfadeMonitor()
                }
            }
        }
        // The stream owned the bandwidth while it ran; now that the file is
        // COMPLETE the preload chain arms for the upcoming rows (a staged
        // load deliberately skips the arm in loadAndStart so the user's
        // stream never competes with the chain).
        prefetchUpcoming(from: activeIndex)
        // A stalled schedule is unblocked the moment the full file lands.
        resumeStalledAfterComplete()
    }

    /// Chains ONE more segment on the ACTIVE node: from the currently
    /// promised end to `toFrames`. The completion is registered as a chained
    /// segment (segmentEnd while successors exist). Nodes are stopped-free:
    /// `scheduleSegment` on a playing node queues the segment — it renders
    /// back-to-back with the running one.
    private func chainStagedSegment(staged: inout StagedSchedule, toFrames: Int64) {
        guard stagedSourceURL != nil,
              let file = try? AVAudioFile(forReading: stagedSourceURL!) else { return }
        let start = staged.scheduledEndFrames
        let frames = toFrames - start
        guard StreamSchedule.canSchedule(startFrame: start, endFrames: toFrames), frames > 0 else { return }
        let sr = staged.sampleRate
        let player = activeNode
        let nodeId = ObjectIdentifier(player)
        let chainedIndex = activeIndex
        let chainedTrackId = staged.trackId
        let generation = scheduleGeneration
        let chainedNode = player
        pendingChainedSegments[nodeId, default: 0] += 1
        player.scheduleSegment(file, startingFrame: start, frameCount: AVAudioFrameCount(frames), at: nil, completionCallbackType: .dataConsumed) { [weak self] _ in
            self?.handleSegmentCompletion(index: chainedIndex, generation: generation, trackId: chainedTrackId, node: chainedNode, standbyGenerationAtStart: nil, isStagedSegment: true)
        }
        staged.scheduledEndFrames = toFrames
        scheduledSegmentSeconds = Double(toFrames) / sr
        eventAdd(.debug, "stream", "chained segment \(start)→\(toFrames) frames (\(String(format: "%.1f", Double(frames) / sr))s) id=\(staged.trackId)")
    }

    /// The buffering pause: the playhead reached the delivered end while the
    /// file is still growing. NEVER an advance (the header claims more audio
    /// — cutting the track short here would be the truncation bug reborn);
    /// NEVER an evict (the bytes are a valid prefix, not poison). Pause and
    /// let the writer's progress events resume (≥ 2 s of new audio) or the
    /// monitor give up after 10 s.
    private func enterBufferingStall(atSeconds target: Double) {
        guard var staged = stagedSchedule, !staged.isStalled else { return }
        staged.isStalled = true
        staged.stalledAtFrames = Int64(target * staged.sampleRate)
        staged.lastProgressAt = Date()
        stagedSchedule = staged
        cachedPosition = target
        eventAdd(.danger, "stream", "buffering stall at \(String(format: "%.1f", target))s (delivered \(staged.deliveredBytes) of \(staged.announcedBytes)B) — paused, auto-resumes when ≥2 s of new audio lands")
        stopCrossfadeMonitor()
        activeNode.pause()
        standbyNode.pause()
        setPlaying(false)
    }

    /// The writer promoted a COMPLETE file while the staged schedule was
    /// STALLED: the real end is now on disk — resume immediately if the user
    /// has not paused (play the remaining tail, which the full-length
    /// schedule below covers).
    private func resumeStalledAfterComplete() {
        guard var staged = stagedSchedule, staged.isStalled, !staged.userPaused else { return }
        staged.isStalled = false
        stagedSchedule = staged
        let resumeAt = cachedPosition
        eventAdd(.info, "stream", "stall cleared by completion — resuming at \(String(format: "%.1f", resumeAt))s with the full-length schedule")
        // Voids the old chain; scheduleCurrentTrack reads isComplete and
        // schedules the REAL end.
        cancelScheduled()
        scheduleCurrentTrack(from: resumeAt, autoPlay: true)
    }

    /// All staged state gone: fresh cache-served playback rules apply.
    private func teardownStagedState() {
        stagedSchedule = nil
        stagedSourceURL = nil
        pendingChainedSegments.removeAll()
    }

    /// 1 s monitor (rides the preload sampler): the stalled schedule's GIVE-UP
    /// timer. The resume decision rides the writer's progress events; this
    /// tick only fires when NO bytes arrived for `stallGiveUpSeconds`.
    private func streamMonitorTick() {
        guard let staged = stagedSchedule, staged.isStalled else { return }
        // F3 rescue (2026-09-22 field dump): delivered == announced while
        // stalled is a LOST COMPLETION (the F1 class), not slow bandwidth —
        // a live writer would have promoted the file and un-stalled the
        // schedule. Complete from the on-disk file immediately instead of
        // burning the give-up timer plus a JS retry on a fully-downloaded
        // track. No announced evidence (0) never rescues.
        if StreamSchedule.stallRescueEligible(deliveredBytes: staged.deliveredBytes,
                                              announcedBytes: staged.announcedBytes) {
            eventAdd(.info, "stream", "stall rescue: delivered \(staged.deliveredBytes) == announced — completion was lost, completing from disk")
            let url = stagedSourceURL
            if let url, FileManager.default.fileExists(atPath: url.path) {
                let final = TrackFileLoader.StreamProgress(
                    trackId: staged.trackId,
                    url: url,
                    stage: .complete,
                    deliveredBytes: staged.deliveredBytes,
                    announcedBytes: staged.announcedBytes)
                let rescuedTrackId = staged.trackId
                // The completion path (completeStagedSchedule) cancels and
                // re-schedules — defer one runloop turn so this tick unwinds
                // first (the 1.2.31 re-entrancy lesson).
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.stagedSchedule?.trackId == rescuedTrackId else { return }
                    self.completeStagedSchedule(progress: final)
                }
            } else {
                // The .part vanished under us — no substrate to complete
                // from; the give-up path (retry + Range-continue) owns it.
                eventAdd(.danger, "stream", "stall rescue skipped: scratch missing at delivered==announced")
                doGiveUpAfterRescueSkip()
            }
            return
        }
        if Date().timeIntervalSince(staged.lastProgressAt) >= StreamSchedule.stallGiveUpSeconds {
            doGiveUpAfterRescueSkip()
        }
    }

    /// The give-up body (shared by the genuine timeout and the rescue's
    /// scratch-missing fall-through): cancel the writer FIRST — its
    /// cancel-triggered completion path records the delivered prefix into
    /// pendingParts (the Range substrate the retry continues) — but with the
    /// engine legs nil'd, so the onError below is the ONLY report (no double
    /// engage) and no later rung can resurrect the staged schedule.
    private func doGiveUpAfterRescueSkip() {
        let title = tracks.indices.contains(activeIndex) ? tracks[activeIndex].title : "track"
        eventAdd(.danger, "stream", "stall give-up after \(Int(StreamSchedule.stallGiveUpSeconds)) s of no progress at \(String(format: "%.1f", cachedPosition))s — handing to JS retry (Range-continues the prefix)")
        loader.cancelActiveWriterRetainingScratch()
        teardownStagedState()
        onError?("Stream stalled: \(title)")
    }

    private func nextIndex(after index: Int) -> Int? {
        let next = index + 1
        if next < tracks.count { return next }
        if loopMode == .all { return 0 }
        return nil
    }

    private func handleTrackEnd() {
        eventAdd(.info, "engine", "queue ended at row \(activeIndex) (\(currentTrackId)) loopMode=\(loopMode.rawValue)")
        stopPlayback()
        onQueueEnded?()
    }

    /// Continues playback after an end-of-track sleep paused us at the natural
    /// end of a track. Mirrors the natural-end logic in `handleSegmentCompletion`.
    private func advanceFromSleepPause() {
        if loopMode == .one {
            playTrack(at: activeIndex, autoPlay: true)
            return
        }
        if let next = nextIndex(after: activeIndex) {
            playTrack(at: next, autoPlay: true, origin: .engineAdvance)
        } else {
            handleTrackEnd()
        }
    }

    /// Node-truth evidence captured at the completion boundary (1.2.41):
    /// the completing node's own player-timeline position read INSIDE the
    /// completion callback, on the render thread, BEFORE the main hop —
    /// by handler time the node may be stopped/retired and its clock gone.
    /// This is the "consumed frames" truth: under `.dataPlayedBack` the
    /// callback fires after the last frame RENDERS, so the reading sits at
    /// the schedule's true end with no read-ahead-buffer slop (the exact
    /// 1.0–1.1 s the 2026-09-25 dumps rode). Nil when the node's clock was
    /// already unreadable at completion time — the wall read then decides.
    private struct NodeEofEvidence {
        /// Bias-bridged seconds on the schedule's own timeline
        /// (sampleTime/sampleRate + the schedule's positionBias, captured
        /// together so the value rides the hop self-contained).
        let elapsedSeconds: Double
    }

    private func handleSegmentCompletion(index completedIndex: Int, generation: Int, trackId: String? = nil, node: AVAudioPlayerNode? = nil, nodeEvidence: NodeEofEvidence? = nil, standbyGenerationAtStart: Int? = nil, isStagedSegment: Bool = false) {
        // The wall-clock read is taken NOW (main, handler entry): it is the
        // fallback evidence, valid only while the clock is measurable.
        let wallEvidence: (elapsed: Double, measured: Bool) = (max(0, currentPosition), isNodeTimeMeasured)
        // ONE resolution for every gate and danger line below: node truth
        // first, measured wall read second, .unmeasured otherwise. The
        // completing node's own capture wins even when the wall read
        // disagrees — the wall read reads the ACTIVE node (a mid-fade
        // completing STANDBY is invisible to it) and rides positionBias,
        // while the node capture is the completing node's own frames.
        let evidence = DownloadSanity.completionEvidence(
            nodeElapsedSeconds: nodeEvidence?.elapsedSeconds,
            wallElapsedSeconds: wallEvidence.measured ? wallEvidence.elapsed : nil,
            wallTimeMeasured: wallEvidence.measured,
            totalSeconds: scheduledSegmentSeconds)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // STAGED chained-segment completions are classified FIRST (the
            // ONE new invariant, A15 Phase 2): a data-consumed completion on
            // a node with another segment queued behind it is a SEGMENT end
            // — consumed silently, no advance, no gates. Only a completion
            // with no chained successor reaches the staged end handler.
            // The GENERATION guard rides FIRST here too: cancelScheduled
            // (resume, seek, param restart) bumps the generation AND clears
            // the counter map, so a stale completion from the torn-down
            // schedule must be dropped before it can eat the NEW schedule's
            // counter slot and misclassify its real end.
            if isStagedSegment, let node {
                guard generation == self.scheduleGeneration else {
                    eventAdd(.debug, "stream", "staged completion dropped: stale generation \(generation) vs \(self.scheduleGeneration) row \(completedIndex)")
                    return
                }
                let nodeId = ObjectIdentifier(node)
                let remaining = self.pendingChainedSegments[nodeId] ?? 0
                if remaining > 0 {
                    self.pendingChainedSegments[nodeId] = remaining - 1
                    eventAdd(.debug, "stream", "staged segment completion consumed silently (\(remaining - 1) chained successors left)")
                    return
                }
                // Last segment on the node: the staged end handler decides
                // (buffering pause while staged; natural advance once
                // COMPLETE).
                self.handleStagedCompletion(index: completedIndex, generation: generation, trackId: trackId, node: node)
                return
            }
            guard generation == self.scheduleGeneration else {
                // Routine: every stop() fires its completions (2 per track
                // change) — verbose domain only, this is expected churn.
                eventAdd(.debug, "engine", "completion dropped: stale scheduleGeneration gen=\(generation) vs \(self.scheduleGeneration) row \(completedIndex) id=\(trackId ?? "-")")
                return
            }
            // Standby-schedule completions are validated against the standby
            // timeline CAPTURED at fade start (2026-09-19). The old live-pair
            // compare let a stale completion from a torn-down fade — re-armed
            // into a NEW fade on the same node before the async hop processed
            // it — pass as the new fade's own and abort it. Every teardown
            // bumps a generation (cancelScheduled → scheduleGeneration;
            // pause/refreshQueue/setLoopMode → standbyScheduleGeneration), so
            // the captured-value compare drops every stale shape.
            let completingStandby = node != nil && node === self.standbyNode
            if completingStandby {
                guard let captured = standbyGenerationAtStart,
                      captured == self.standbyScheduleGeneration else {
                    eventAdd(.debug, "engine", "standby completion dropped: captured standby gen \(standbyGenerationAtStart.map(String.init) ?? "nil") vs live \(self.standbyScheduleGeneration) row \(completedIndex)")
                    return
                }
            }

            // The active player finishing while a crossfade is in progress is
            // the switch point. Discriminate by NODE IDENTITY at handler time
            // (2026-09-19, replacing the schedule-time isStandby flag): the
            // flag survived finalizeCrossfadeSwitch, so the former standby —
            // now the ACTIVE track — had its natural end during the NEXT fade
            // mislabeled a standby EOF; the abort kept an EXHAUSTED node
            // "playing" (silence, clock climbing past the track end — the
            // 1.2.28 wedge: fade starts, never switches, position climbs).
            // Mid-fade, the completing node is the CURRENT standby node only
            // when the fade TARGET itself died before the ramp finished.
            if self.crossfade.isInFlight {
                if completingStandby {
                    // The fade target's bytes ran out mid-ramp (a truncated
                    // target's early EOF — the LDM signature — or a
                    // pathological length tie). Finalizing here would switch
                    // to an EXHAUSTED node whose only pending completion just
                    // fired: the queue would stall silently. Abort instead:
                    // stop the dead standby and suppress further fades for
                    // this track instance, letting the outgoing track's real
                    // end drive the advance. The TARGET row's file is the
                    // poison — evict it so the next fade re-downloads.
                    let targetTrack = tracks.indices.contains(crossfade.targetIndex) ? tracks[crossfade.targetIndex] : nil
                    // D2: numbers on the standby-death abort (elapsed vs end —
                    // elapsed ≈ end means the active tail was already gone; that
                    // shape dead-ends in the D1 watchdog, logged there). The
                    // evidence SOURCE rides the line (1.2.41): node truth vs
                    // the wall fallback is the first thing a residual-gap dump
                    // must be able to tell apart.
                    eventAdd(.danger, "engine", "abort-keep-active (standby died) current=\(currentTrackId) elapsed=\(String(format: "%.1f", max(0, currentPosition))) of \(String(format: "%.1f", scheduledSegmentSeconds)) nodeElapsed=\(evidence.source == .nodeTimeline ? String(format: "%.1f", evidence.elapsedSeconds) : "nil") evidence=\(evidence.source) target=\(targetTrack?.trackId ?? "-") — fades suppressed for this instance")
                    self.abortCrossfadeKeepActive()
                    if let targetTrack {
                        loader.evict(targetTrack.trackId, variant: TrackVariant(url: targetTrack.url))
                    }
                    return
                }
                // 2026-09-21 dump, P0a: the ACTIVE node's EOF during a fade
                // is the switch point ONLY when it is a real end. A truncated
                // active file EOFs early and previously finalized UNGATED —
                // the switch put the mid-ramp standby live with the outgoing
                // track's tail missing: the audible "plays ~10 s, then the
                // next track starts ~10 s in" signature (EVERY track boundary
                // rides this path when crossfade is on). The same
                // DownloadSanity verdict the natural path applies must judge
                // this completion first. On a premature verdict the response
                // is the standby-EOF shape — keep the outgoing track, pause
                // for the JS bounded retry — plus eviction of the ACTIVE
                // row's poison so the retry re-downloads fresh bytes.
                // 2026-09-21c: the finalize itself can re-enter this handler
                // (the deferred-less prefetch chain's SYNCHRONOUS cache-hit
                // completion ran crossfadeMonitorTick inside finalize; the
                // tick armed a fade; its torn-down node's completion landed
                // here) — the crossed state made the healthy freshly-switched
                // file read as "premature" (elapsed 0.0 of 155.2) and EVICTED
                // it. With the finalize re-entry closed (chain deferred) and
                // the stale-clock tick guard, this branch only fires on real
                // truncations again — but the eviction is now held one beat
                // while a finalize is in progress (reentrancyGuard) to make
                // the state crossing impossible rather than merely unlikely.
                let elapsed = max(0, currentPosition)
                // 2026-09-25 (the two "caught a play halfway then restart" /
                // "song plays a little and gets skipped" dumps): verdict and
                // response are now separated. The 2026-09-21e abort premise —
                // "the outgoing track plays out its real remaining tail and
                // its genuine natural end advances the queue" — is IMPOSSIBLE
                // for this completion: `dataConsumed` completions are
                // ONE-SHOT, so an aborted node has no future end trigger.
                // Both dumps show the result: abort at 1.0-1.1 s short of the
                // segment end (on byte-COMPLETE streams — delivered ==
                // announced, clean promotes, no early closes) → the lost
                // completion → the D1 dead-air watchdog advancing ~3 s late.
                // 1.2.41: the slop the epsilon absorbed is GONE — the standby
                // completion now rides .dataPlayedBack (fires after the last
                // frame RENDERS, no read-ahead slop) and the verdict judges
                // the completing node's OWN consumed-frame position (captured
                // in the callback before the main hop), so a genuine end
                // reads remaining < 1.0 → the plain .finalize. The epsilon
                // stays as defense-in-depth for the WALL-CLOCK fallback (node
                // capture nil — e.g. a retired node), where buffer-depth slop
                // is still real. Genuinely SHORT bytes (remaining > epsilon)
                // keep the 2026-09-21e abort-keep-active, with the D1
                // watchdog as the KNOWN owner of the lost end trigger.
                let eofAction = DownloadSanity.midFadeActiveEofAction(evidence: evidence)
                if reentrancyGuard > 0, eofAction != .finalize {
                    // The completion fired DURING a finalize — the crossed
                    // half-swapped state, not file evidence (the 09:55 dump
                    // evicted a healthy file exactly this way: elapsed 0.0
                    // of 155.2 seconds after a healthy switch). Drop the
                    // completion WITHOUT the eviction/pause/retry storm;
                    // the finalize's own teardown handles the nodes.
                    eventAdd(.info, "engine", "dropped completion during finalize re-entry row \(completedIndex) id=\(currentTrackId) — crossed state, no eviction")
                    return
                }
                let elapsedOneDp = String(format: "%.1f", elapsed)
                let segmentOneDp = String(format: "%.1f", scheduledSegmentSeconds)
                let evidenceStr = String(describing: evidence.source)
                let nodeElapsedStr = evidence.source == .nodeTimeline ? String(format: "%.1f", evidence.elapsedSeconds) : "nil"
                if eofAction == .abortKeepActive {
                    // 2026-09-21e (the 03:59 dump, the "went back to the
                    // previous song" report): the old response PAUSED +
                    // EVICTED + errored. The pause silenced the app; the JS
                    // retry re-engaged the SAME row, whose re-load restarted
                    // the fade machinery while the queue store was still
                    // catching up — the observable result was the queue
                    // stepping BACKWARD into the row the user had just heard.
                    // Stopping playback mid-fade was the whole failure: the
                    // retry machine was invented for DEAD bytes, and this file
                    // is not dead — the gate proved only that it is SHORT. The
                    // response stays the minimum: keep playing, drop only the
                    // crossfade automation. Nothing evicted, nothing pauses,
                    // no retry, no storm. (2026-09-25 correction: a one-shot
                    // completion never refires — the D1 watchdog, not a
                    // "genuine natural end", owns the advance from here.)
                    eventAdd(.danger, "engine", "dropped premature completion of ACTIVE node mid-fade row \(completedIndex) id=\(currentTrackId) elapsed=\(elapsedOneDp) of \(segmentOneDp) nodeElapsed=\(nodeElapsedStr) evidence=\(evidenceStr) — fade automation dropped, tail continues unattended (D1 watchdog owns a lost end past \(segmentOneDp)s)")
                    self.abortCrossfadeKeepActive()
                    return
                }
                if eofAction == .finalizeNearEnd {
                    // The node is DONE (its one-shot completion just fired)
                    // and the shortfall is slop — finalize is what the healthy
                    // path does, moved ~1 s earlier. The standby is already
                    // mid-ramp with full audio; a direct advance would race it
                    // (the 1.2.28 wedge's shape), so finalize is the switch.
                    eventAdd(.info, "engine", "near-end active EOF mid-fade row \(completedIndex) id=\(currentTrackId) elapsed=\(elapsedOneDp) of \(segmentOneDp) nodeElapsed=\(nodeElapsedStr) evidence=\(evidenceStr) — within epsilon: finalizing switch (abort would strand the one-shot completion into the D1 dead-air advance)")
                }
                self.finalizeCrossfadeSwitch()
                return
            }

            // 2026-09-17 completion anti-cascade: outside a crossfade, a
            // completion whose scheduled identity no longer matches the live
            // active row is STALE (the trace showed rows 2→3→4 completing
            // ~10-20 ms apart — each poison-fast row fired its completion
            // while the NEXT row was already active, and every stale arrival
            // chained another advance). The generation guard cannot see
            // these: the cascade never cancelled anything, so the generation
            // never bumped.
            // 2026-09-19: the TRACKID is the identity. A mid-track
            // refreshQueue re-anchor can move the playing row's INDEX (same
            // id) — the old index-mismatch drop orphaned the track's natural
            // end: the node kept rendering silence with its clock climbing
            // past the track end and nothing advanced (the 1.2.28 stall).
            // The id still closes the 2026-09-17 reindex hole — the cascade's
            // completions came from DIFFERENT tracks, whose ids mismatch the
            // live row. A nil trackId (never registered with an id) falls
            // back to the index compare.
            let idMismatch = trackId != nil && trackId != self.currentTrackId
            let indexMismatch = trackId == nil && completedIndex != self.activeIndex
            if idMismatch || indexMismatch {
                // D2: numbers on the drop — if the ACTIVE track's own end
                // completion is ever eaten here (the 2026-09-23 wedge: silence
                // past the end until a manual skip), this line carries the
                // elapsed evidence that identifies it.
                eventAdd(.danger, "engine", "dropped stale completion for row \(completedIndex) id=\(trackId ?? "-") (active row \(self.activeIndex) id \(self.currentTrackId)) elapsed=\(String(format: "%.1f", max(0, currentPosition))) of \(String(format: "%.1f", scheduledSegmentSeconds)) nodeElapsed=\(evidence.source == .nodeTimeline ? String(format: "%.1f", evidence.elapsedSeconds) : "nil") evidence=\(evidence.source)")
                return
            }

            // 2026-09-18 LDM multi-skip, final gate: elapsed-time sanity. If
            // the measured position sits >= 1 s before the SCHEDULED SEGMENT's
            // own length, this completion cannot be a real end-of-track: a
            // truncated download's container reports more audio than the
            // delivered bytes contain (FLAC/MP4 duration headers → a bogus
            // EOF minutes early; Ogg last-page granule positions → a stop AT
            // the cut when the header page arrived) — either shape used to
            // chain the advance. The
            // reference is the segment the file was scheduled for (file
            // truth), NOT the metadata duration (a mis-tagged track must not
            // false-drop). Judged only when a clock is measurable (1.2.41:
            // the completing node's OWN consumed-frame capture first — under
            // .dataPlayedBack it reads AT the schedule end with no buffer
            // slop; the §3.4 wall read second) — an unmeasurable wall read
            // fell back to the stale `cachedPosition`, which is not evidence.
            // Drop the
            // completion, report the error so JS's bounded retry re-fetches,
            // and silence the dead node (loop-one restarts otherwise loop a
            // half-audible file).
            let elapsed = max(0, currentPosition)
            if DownloadSanity.isPrematureCompletion(evidence: evidence) {
                let elapsedOneDp = String(format: "%.1f", elapsed)
                let segmentOneDp = String(format: "%.1f", scheduledSegmentSeconds)
                eventAdd(.danger, "engine", "dropped premature completion for row \(completedIndex) id=\(currentTrackId) elapsed=\(elapsedOneDp) of \(segmentOneDp) nodeElapsed=\(evidence.source == .nodeTimeline ? String(format: "%.1f", evidence.elapsedSeconds) : "nil") evidence=\(evidence.source) — evicted for re-fetch")
                // The gate required a measurable clock, so the pause is safe.
                activeNode.pause()
                setPlaying(false)
                // 2026-09-19, the fix for the 1.2.28 same-track loop: the old
                // drop left the poisoned file CACHED, so the JS retry's
                // re-engage hit the loader cache and replayed the same
                // truncation forever. Evict — the retry re-DOWNLOADS fresh
                // bytes, and a healthy re-download heals the row instead of
                // looping it. Persistently-truncating rows are bounded by the
                // retry give-up (nativeTransport) and advance fromError.
                loader.evict(tracks[activeIndex].trackId, variant: TrackVariant(url: tracks[activeIndex].url))
                onError?("Track ended early (partial download evicted): \(tracks[activeIndex].title)")
                return
            }

            // Natural end with an end-of-track sleep timer pending: pause here rather
            // than advancing (loop-one also defers — "end of track" wins).
            if self.sleepAtTrackEnd {
                self.sleepAtTrackEnd = false
                eventAdd(.info, "engine", "sleep park at track end row \(activeIndex) (\(currentTrackId))")
                self.pause()
                self.waitingAtTrackEnd = true
                self.onSleepTimerFired?()
                return
            }

            if self.loopMode == .one {
                eventAdd(.info, "engine", "loop-one restart row \(activeIndex) (\(currentTrackId))")
                self.playTrack(at: self.activeIndex, autoPlay: true, origin: .engineAdvance)
                return
            }

            // Advance from the LIVE activeIndex, never the schedule-time
            // index (2026-09-12): a queue refresh (drag-reorder, promotion,
            // fill) re-anchors activeIndex by id mid-flight, while
            // `completedIndex` still holds the position captured when the
            // segment was scheduled — advancing from it played the row that
            // sat at the OLD next slot (the previously preloaded track) after
            // the user moved the playing row. The live index is the same
            // value in the undisturbed case, so nothing else changes.
            if let next = self.nextIndex(after: self.activeIndex) {
                eventAdd(.info, "engine", "natural advance \(self.activeIndex)→\(next) (\(tracks.indices.contains(next) ? tracks[next].trackId : "-"))")
                self.playTrack(at: next, autoPlay: true, origin: .engineAdvance)
            } else {
                self.handleTrackEnd()
            }
        }
    }

    private func setPlaying(_ playing: Bool) {
        if isPlaying == playing { return }
        isPlaying = playing
        // Preload-progress sampling rides the ENGAGED session, not the playing
        // state: while paused, downloads still run (the preload window and a
        // resumed track's own bytes) and their tints must not freeze. The
        // timer is stopped explicitly by `stopPlayback` (session teardown).
        if playing {
            startPreloadProgressTimer()
        }
        onPlaybackStateChanged?(playing)
    }

    private func refreshActiveGain() {
        guard tracks.indices.contains(activeIndex) else { return }
        activeGain.outputVolume = Float(tracks[activeIndex].replayGainLinear(mode: replayGainMode))
    }

    private func refreshPreamp() {
        let linear = pow(10.0, preampDb / 20.0)
        preamp.outputVolume = Float(linear * masterVolume)
    }

    private func stopPlayback() {
        eventAdd(.info, "engine", "stopPlayback position=\(String(format: "%.1f", currentPosition)) row \(activeIndex) (\(currentTrackId))")
        // ACTIVE-LOAD RETRY (2026-09-24 dump-2): any teardown — stop, sleep
        // end, queue end — must also disarm the loader's retry timer.
        cancelActiveLoadRetries()
        paramRestartTimer?.invalidate()
        paramRestartTimer = nil
        sleepTimer?.invalidate()
        sleepTimer = nil
        sleepAtTrackEnd = false
        cancelScheduled()
        hasLiveSchedule = false
        // A session teardown also ends the staged state (the writer itself
        // keeps running — its completion is dropped by the generation guard
        // or finishes into cache, both harmless).
        teardownStagedState()
        if engine.isRunning {
            engine.pause()
        }
        cachedPosition = 0
        positionBias = 0
        setPlaying(false)
        // The preload sampler runs for the whole ENGAGED session (tints must
        // not freeze while paused) — it stops only here, at session teardown.
        stopPreloadProgressTimer()
    }

    /// The STAGED completion handler (Phase 2): the contract makes this
    /// completion's meaning unambiguous. The scheduled end sat INSIDE the
    /// delivered bytes when it was made, so data running out here is one of
    /// exactly two things:
    ///
    /// 1. The delivered end was reached while the file still grows (or the
    ///    estimate undershot the real end) → the BUFFERING PAUSE: never an
    ///    advance, never an evict — the writer's progress events resume
    ///    playback (≥ 2 s of new audio), the monitor gives up after 10 s.
    /// 2. The file is COMPLETE (the writer promoted; `isComplete` latched)
    ///    → a REAL natural end: the full advance chain runs unchanged.
    private func handleStagedCompletion(index completedIndex: Int, generation: Int, trackId: String?, node: AVAudioPlayerNode?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard generation == self.scheduleGeneration else {
                eventAdd(.debug, "stream", "staged completion dropped: stale generation \(generation) vs \(self.scheduleGeneration) row \(completedIndex)")
                return
            }
            guard let staged = self.stagedSchedule, staged.trackId == trackId else {
                eventAdd(.info, "stream", "staged completion dropped: state moved on (row \(completedIndex) id \(trackId ?? "-"))")
                return
            }
            let consumeQuietly: (String) -> Void = { reason in
                self.eventAdd(.debug, "stream", "staged segment completion consumed silently: \(reason)")
            }
            if staged.isComplete {
                // The file passed the gates; this is a REAL end. Phase 3:
                // with a fade in flight this completion IS the switch point —
                // finalize (the standby is already mid-ramp; a direct advance
                // would race it — the 1.2.28 wedge's shape). No premature
                // gate here: the byte gates proved this file, and
                // abort-keep-active would strand it (a complete staged
                // schedule has no remaining tail to "keep playing").
                if self.crossfade.isInFlight {
                    eventAdd(.info, "stream", "staged end during fade — finalizing switch to row \(String(describing: self.crossfade.targetIndex))")
                    self.finalizeCrossfadeSwitch()
                    return
                }
                if self.sleepAtTrackEnd {
                    self.sleepAtTrackEnd = false
                    self.pause()
                    self.waitingAtTrackEnd = true
                    self.onSleepTimerFired?()
                    return
                }
                if self.loopMode == .one {
                    self.playTrack(at: self.activeIndex, autoPlay: true, origin: .engineAdvance)
                    return
                }
                if let next = self.nextIndex(after: self.activeIndex) {
                    eventAdd(.info, "engine", "natural advance \(self.activeIndex)→\(next) (staged complete)")
                    self.playTrack(at: next, autoPlay: true, origin: .engineAdvance)
                } else {
                    self.handleTrackEnd()
                }
                return
            }
            // Staged + not complete: the playhead reached the promised end.
            // That is the buffering pause — regardless of whether the user
            // hears a gap (the estimate under-promised) or not (the data
            // genuinely ran out). Phase 3 defense in depth (the core's
            // .abortFadeThenPause verdict): a fade should NEVER be in flight
            // here (fades arm only on complete schedules) — but if the
            // contract is ever violated, dropping the automation before the
            // pause is strictly safer than pausing under a live ramp.
            if staged.isStalled {
                consumeQuietly("already stalled")
                return
            }
            if self.crossfade.isInFlight {
                eventAdd(.danger, "stream", "staged buffering during fade (contract violation) — aborting fade automation, then pausing")
                self.abortCrossfadeKeepActive()
            }
            self.enterBufferingStall(atSeconds: staged.scheduledEndSeconds)
        }
    }

    private func cancelScheduled() {
        eventAdd(.debug, "engine", "cancelScheduled → scheduleGeneration \(scheduleGeneration + 1) (all pending completions void)")
        scheduleGeneration += 1
        waitingAtTrackEnd = false
        crossfade = .idle
        stopCrossfadeMonitor()
        stopVolumeRamp()
        playerA.stop()
        playerB.stop()
        // Staged chained-segment bookkeeping is generation-scoped: every
        // cancel voids the outstanding chain counts. A stale chained
        // completion can no longer misclassify a later schedule.
        pendingChainedSegments.removeAll()
    }

    // MARK: - Crossfade

    private func setupCrossfadeMonitor() {
        stopCrossfadeMonitor()
        guard crossfadeDuration > 0, isPlaying, loopMode != .one, !sleepAtTrackEnd, tracks.indices.contains(activeIndex) else { return }
        // 1.2.41: the standby's end-of-fade completion rides .dataPlayedBack
        // and the node's own captured position — the mid-fade gate's evidence
        // is the completing node's consumed-frame truth, not the epsilon-
        // tolerated wall read. A staged schedule's own chained completions
        // stay .dataConsumed (chain bookkeeping, not gate evidence).
        // A15: a STAGED schedule's fade automation keys on its COMPLETENESS
        // (Phase 3 — `StreamSchedule.fadeEligibility`): while streaming, the
        // estimate under-promises (the fade window cannot cover the ramp and
        // the buffering pause would tear the fade down mid-flight), so no
        // monitor. Once COMPLETE the schedule is file truth — fades exactly
        // like a full-download track. The monitor's arming sites are many
        // (play() plain-resume, setLoopMode, setCrossfade, finalize), so the
        // rule is enforced here at the ONE choke point rather than at each
        // caller: a fade racing the staged completion chain would finalize
        // against a schedule the staged advance already tore down.
        if let staged = stagedSchedule {
            guard StreamSchedule.fadeEligibility(isScheduleComplete: staged.isComplete) else { return }
        }
        // A seek-suppressed track gets no monitor at all — automation is off
        // for the remainder of this track instance.
        guard tracks[activeIndex].trackId != seekSuppressedTrackId,
              tracks[activeIndex].trackId != fadeAbortedTrackId else { return }

        let current = tracks[activeIndex]
        let nextIdx = nextIndex(after: activeIndex)
        let nextDuration = nextIdx.flatMap { tracks.indices.contains($0) ? tracks[$0].duration : nil }
        let readiness = crossfadeReadiness(
            isPlaying: isPlaying,
            loopOne: loopMode == .one,
            fadeDuration: crossfadeDuration,
            currentDuration: current.duration,
            nextDuration: nextDuration,
            targetReady: nextIdx.flatMap { tracks.indices.contains($0) ? loader.localURL(for: tracks[$0]) != nil : nil } ?? false
        )
        reportCrossfadeReadiness(readiness)
        guard readiness == .ready || readiness == .targetNotReady else { return }

        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.crossfadeMonitorTick()
        }
        crossfadeMonitor = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopCrossfadeMonitor() {
        crossfadeMonitor?.invalidate()
        crossfadeMonitor = nil
        lastCrossfadeReadiness = nil
        // An armed-but-not-started fade without a live monitor is meaningless;
        // an in-flight fade keeps running (the ramp owns it until finalize).
        if crossfade.phase == .armed {
            crossfade = .idle
        }
    }

    private func crossfadeMonitorTick() {
        guard isPlaying, !crossfade.isActive else { return }
        guard crossfadeDuration > 0, tracks.indices.contains(activeIndex) else { return }
        // Defense in depth: the setup guard normally keeps this monitor from
        // existing at all while suppressed.
        guard tracks[activeIndex].trackId != seekSuppressedTrackId,
              tracks[activeIndex].trackId != fadeAbortedTrackId else { return }

        let current = tracks[activeIndex]
        let transitionPoint = current.duration - crossfadeDuration
        // Stale-clock defense (2026-09-21, the "next track restarts after the
        // crossfade" dump): a measured position PAST this track's duration
        // cannot be this track's clock — it is a previous track's node still
        // rendering through a re-entrant call. seq 14 of the field dump:
        // position=295.27 judged against a 155 s track (the outgoing 296 s
        // track's clock read mid-finalize). Arming a fade on that clock
        // destroyed the freshly-switched track. A healthy clock never exceeds
        // its own segment; +1 s slack for float/rounding edge.
        if currentPosition > current.duration + 1 {
            eventAdd(.danger, "crossfade", "tick SKIPPED — position \(String(format: "%.2f", currentPosition)) exceeds current \(current.trackId) duration \(String(format: "%.1f", current.duration)) — stale clock, observe-only")
            return
        }
        guard currentPosition >= transitionPoint else { return }
        guard let nextIdx = nextIndex(after: activeIndex), tracks.indices.contains(nextIdx) else { return }
        let next = tracks[nextIdx]
        let readiness = crossfadeReadiness(
            isPlaying: isPlaying,
            loopOne: loopMode == .one,
            fadeDuration: crossfadeDuration,
            currentDuration: current.duration,
            nextDuration: next.duration,
            targetReady: loader.localURL(for: next) != nil
        )
        reportCrossfadeReadiness(readiness)
        guard readiness == .ready else { return }

        crossfade = crossfade.arming(targetIndex: nextIdx)
        startCrossfade(to: nextIdx)
    }

    private func startCrossfade(to nextIdx: Int) {
        // Third direct-play path (standbyNode.play() below): the monitor timer
        // keeps ticking on the main run loop even after iOS tears the engine
        // down (interruption / background death), so the next due fade can
        // arrive with a stopped engine. Re-start it; a failed start idles the
        // fade (the monitor re-evaluates next tick) instead of raising in
        // AVAudioPlayerNodeImpl::StartImpl.
        guard ensureEngineRunning() else {
            crossfade = .idle
            return
        }
        let nextTrack = tracks[nextIdx]
        guard let localURL = loader.localURL(for: nextTrack) else {
            reportCrossfadeReadiness(.targetNotReady)
            crossfade = .idle
            return
        }
        guard let file = try? AVAudioFile(forReading: localURL) else {
            // A cached path can still be corrupt. Evict and restart its fetch;
            // the completion will re-check the active window on the main thread.
            eventAdd(.danger, "crossfade", "target file could not be opened: \(nextTrack.trackId) — evicting and re-fetching")
            loader.evict(nextTrack.trackId, variant: TrackVariant(url: nextTrack.url))
            loader.prefetch(nextTrack) { [weak self] _, _ in
                self?.crossfadeMonitorTick()
            }
            crossfade = .idle
            return
        }

        crossfade = crossfade.starting(targetIndex: nextIdx)
        let formattedPosition = String(format: "%.2f", currentPosition)
        eventAdd(.info, "crossfade", "fade start current=\(currentTrackId) target=\(nextTrack.trackId) position=\(formattedPosition)")
        let targetGain = Float(nextTrack.replayGainLinear(mode: replayGainMode))
        let startGain = activeGain.outputVolume
        let duration = Float(crossfadeDuration)

        // Keep the current generation: we must NOT invalidate the active player's
        // pending completion, which is what finalizes the crossfade at its natural end.
        let generation = scheduleGeneration

        standbyNode.stop()
        standbyGain.outputVolume = 0
        standbyGeneration = standbyScheduleGeneration
        // Captured identities ride the completion (2026-09-19): the NODE (for
        // the in-flight discrimination) and the standby generation at fade
        // start (a torn-down-and-re-armed fade's stale completion must not
        // abort the NEW fade). The target's trackId rides too so its
        // post-finalize natural end survives a mid-track index re-anchor.
        let standbyPlayer = standbyNode
        let standbyGenAtStart = standbyScheduleGeneration
        // Bias rides the capture (1.2.41): the standby was stopped (its
        // timeline restarts at 0) and plays the TARGET from frame 0, so the
        // node's raw sampleTime IS the target-timeline position — bias 0.
        // `positionBias` describes the OUTGOING track's timeline (and is
        // zeroed by finalize); using it would corrupt the conversion and
        // could false-finalize a truncated target.
        let fadeBias = 0.0
        // 1.2.41: .dataPlayedBack + the node's own captured position — the
        // mid-fade gate judges the completing node's consumed-frame truth
        // (≈ the schedule end, no read-ahead slop) instead of an
        // epsilon-tolerated wall read.
        standbyNode.scheduleSegment(file, startingFrame: 0, frameCount: AVAudioFrameCount(file.length), at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            let nodeElapsed = self?.captureNodeElapsed(for: standbyPlayer, bias: fadeBias)
            self?.handleSegmentCompletion(index: nextIdx, generation: generation, trackId: nextTrack.trackId, node: standbyPlayer, nodeEvidence: nodeElapsed.map { NodeEofEvidence(elapsedSeconds: $0) }, standbyGenerationAtStart: standbyGenAtStart)
        }
        standbyNode.play()

        // ONE 40-step timer ramping BOTH gains in lockstep (1.1) — the old code
        // called rampVolume twice, and the second call invalidated the shared
        // timer before its first tick, so the fade-out never ran.
        rampCrossfade(RampPlan(
            activeStart: startGain,
            standbyEnd: targetGain,
            duration: duration,
            curve: RampCurve(raw: crossfadeCurve, steepness: Float(sigmoidSteepness))
        ))
    }

    /// Runs ONE timer driving both sides of a crossfade from a pure RampPlan
    /// (1.1). Replaces the per-node `rampVolume`, whose second call invalidated
    /// the shared timer before its first tick — the fade-out never ran.
    private func rampCrossfade(_ plan: RampPlan) {
        stopVolumeRamp()
        rampStepCount = 0
        guard plan.duration > 0 else {
            activeGain.outputVolume = 0
            standbyGain.outputVolume = plan.standbyEnd
            return
        }
        let timer = Timer(timeInterval: Double(plan.stepTime), repeats: true) { [weak self] timer in
            guard let self = self, timer === self.volumeRampTimer else {
                timer.invalidate()
                return
            }
            self.rampStepCount += 1
            self.activeGain.outputVolume = plan.activeGain(atStep: self.rampStepCount)
            self.standbyGain.outputVolume = plan.standbyGain(atStep: self.rampStepCount)
            if self.rampStepCount >= RampPlan.stepCount {
                timer.invalidate()
                self.volumeRampTimer = nil
            }
        }
        volumeRampTimer = timer
        eventAdd(.debug, "crossfade", "ramp-start duration=\(plan.duration) steps=\(RampPlan.stepCount)")
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopVolumeRamp() {
        volumeRampTimer?.invalidate()
        volumeRampTimer = nil
        rampStepCount = 0
    }

    private func reportCrossfadeReadiness(_ readiness: CrossfadeReadiness) {
        guard readiness != lastCrossfadeReadiness else { return }
        lastCrossfadeReadiness = readiness
        let formattedPosition = String(format: "%.2f", currentPosition)
        eventAdd(.info, "crossfade", "readiness=\(readiness) track=\(currentTrackId) position=\(formattedPosition) fade=\(crossfadeDuration)")
    }

    /// Cancels an in-flight crossfade whose TARGET side died mid-render,
    /// keeping the outgoing track in control. 2026-09-19 hardening after the
    /// 1.2.28 field reports:
    ///  - STOP the standby: its segment is consumed; leaving it rendering
    ///    silence lets its clock run away invisibly.
    ///  - EVICT the target: the standby consumed its segment before the ramp
    ///    finished — evidence-based poison (bytes ran out mid-fade). The old
    ///    "no evict" stance let the cached truncation come straight back: the
    ///    monitor re-armed the SAME fade within 100 ms (position is already
    ///    past the transition point), the target EOF'd again, abort again —
    ///    the audible fade-in/fade-out churn ("crossfades the next song but
    ///    doesn't switch"), and after the track advanced, the retry loop
    ///    replayed the same poison from cache forever.
    ///  - SUPPRESS further fades for this track instance (fadeAbortedTrackId,
    ///    cleared in playTrack): the outgoing track plays out its tail
    ///    without automation and its real completion advances normally.
    /// Stops the in-flight fade, keeps the outgoing track live, and suppresses
    /// further fades for this track instance. Does NOT evict: the caller owns
    /// the eviction evidence — a standby-EOF abort poisons the TARGET row; the
    /// active-EOF premature drop (2026-09-21e) evicts NOTHING — a short file
    /// keeps playing its delivered tail, so the P0a eviction/removal is gone.
    /// A blind target-evict here would discard the HEALTHY standby download in
    /// the active-EOF case (that file is the next track playback will need
    /// seconds later).
    private func abortCrossfadeKeepActive() {
        standbyNode.stop()
        stopVolumeRamp()
        stopCrossfadeMonitor()
        crossfade = .idle
        standbyGain.outputVolume = 0
        // The ramp may have already faded the active side partway down.
        refreshActiveGain()
        fadeAbortedTrackId = currentTrackId
        if isPlaying {
            setupCrossfadeMonitor()
        }
        // D2 (2026-09-23 dumps): the abort verdicts carried no numbers —
        // three dumps were needed to see the active tail was already ~0 s
        // when the standby died. Elapsed vs scheduled end on the abort line
        // makes each future dump self-describing: elapsed ≈ end ⇒ the wedge
        // the D1 watchdog now rescues; elapsed ≪ end ⇒ a genuine mid-track
        // standby death worth a separate hunt.
        eventAdd(.danger, "crossfade", "abort-keep-active current=\(currentTrackId) elapsed=\(String(format: "%.1f", max(0, currentPosition))) of \(String(format: "%.1f", scheduledSegmentSeconds)) (completing node died mid-fade) — fades suppressed for this instance")
    }

    private func finalizeCrossfadeSwitch() {
        reentrancyGuard += 1
        defer { reentrancyGuard -= 1 }
        stopVolumeRamp()
        stopCrossfadeMonitor()
        let targetIndex = crossfade.targetIndex
        crossfade = .idle

        activeIndex = targetIndex
        // The former standby's completion is this track's natural-end trigger
        // and flows through the premature-completion gate (1.2.41: judged on
        // the .dataPlayedBack node capture this finalize itself is riding) —
        // recompute the
        // segment reference for the NEW track (scheduleCurrentTrack never ran
        // for it; the outgoing track's value would misjudge the end).
        if let url = loader.localURL(for: tracks[activeIndex]),
           let file = try? AVAudioFile(forReading: url) {
            // File truth for the new track (the byte clamp is gone — 2026-09-19).
            scheduledSegmentSeconds = Double(file.length) / file.processingFormat.sampleRate
        } else {
            scheduledSegmentSeconds = 0
        }
        isActiveB.toggle()
        standbyNode.stop()
        standbyGain.outputVolume = 0
        positionBias = 0
        cachedPosition = 0
        // Phase 3: the staged schedule belongs to the OUTGOING track. If its
        // end drove this finalize (the staged→fade switch), the state must go
        // BEFORE the new track's bookkeeping — a surviving stagedSchedule
        // would send scheduleCurrentTrack down the staged branch with the old
        // track's .part, and its pending chained counts would corrupt the new
        // track's end discrimination. cancelScheduled already cleared the
        // counters; the snapshot reference goes here. The writer is NOT
        // touched: a promote-complete writer has already delivered its
        // cache entry (localURL serves the next track); there is nothing to
        // cancel.
        teardownStagedState()
        activeGain.outputVolume = Float(tracks[activeIndex].replayGainLinear(mode: replayGainMode))
        let formattedPosition = String(format: "%.2f", currentPosition)
        eventAdd(.info, "crossfade", "fade complete track=\(tracks[activeIndex].trackId) position=\(formattedPosition)")

        onTrackChanged?(tracks[activeIndex].trackId)
        setupCrossfadeMonitor()
        // The chain re-arm runs LAST and DEFERRED one runloop turn (2026-09-21,
        // the "next track restarts after the crossfade" root cause): the
        // loader's cache-hit path delivers SYNCHRONOUSLY on main, so a fully-
        // cached window re-entered crossfadeMonitorTick FROM INSIDE finalize
        // while the engine was half-swapped — activeIndex already on the new
        // track, node roles not yet toggled. The re-entrant tick read the OLD
        // node's clock (position 295.27 on a 155 s track), armed a fade against
        // the half-swapped engine, and startCrossfade tore down the node about
        // to become active — the freshly-switched track restarted from 0 via
        // the premature-drop retry. The old position (before the toggle) is
        // also why the arm MUST NOT run before the swap. The generation guard
        // preserves the re-arm contract (a queue change in the interim kills
        // the deferred chain like any other stale arm).
        let deferredGeneration = prefetchGeneration
        let deferredFrom = activeIndex
        DispatchQueue.main.async { [weak self] in
            guard let self, deferredGeneration == self.prefetchGeneration else { return }
            self.prefetchUpcoming(from: deferredFrom)
        }
    }

    private static func mapFilterType(_ type: String) -> AVAudioUnitEQFilterType {
        switch type {
        case "lowshelf": return .lowShelf
        case "highshelf": return .highShelf
        case "lowpass": return .lowPass
        case "highpass": return .highPass
        case "bandpass": return .bandPass
        case "notch": return .bandStop
        default: return .parametric
        }
    }
}
