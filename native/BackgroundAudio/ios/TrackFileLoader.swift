import Foundation
import AVFoundation
import Accelerate
import BackgroundAudioCore

// The native loader subsystem: downloading and staged-streaming remote tracks
// into the caches directory so AVAudioFile can schedule them.
//
// BOUNDARY (2026-10-03, restated 2026-10-03b to match the contents). This file
// owns `TrackFileLoader` — everything defined by the loader's OWN byte and
// cache state — plus its `StreamWriterDelegate`:
//
//   • cache state + the downloadTask path (`prefetch`, serving, evict)
//   • the streaming writer (StreamWriter/StreamProgress, `streamLoad`)
//   • Range resume/continuation bookkeeping (pendingParts, the writer
//     continuation, `writerDidComplete`'s verdicts)
//   • maturation staging (`tickMaturation`): it is fed BY the loader's byte
//     ledgers (accumulatedBytes, maturationByteFloor, pendingParts) and runs
//     on the loader's tick — it belongs with the bytes it observes, not in the
//     engine. The pure `Maturation` policy lives in BackgroundAudioCore.
//
// Deliberately NOT here (2026-10-03b): the native codec probe moved to
// `DecodeProbeRunner.swift` — it shares the loader's URLSession habits but
// NONE of its state, so keeping it here contradicted the boundary.
//
// It has NO dependency on the engine: the engine (`NativeAudioEngine`, still in
// AudioEngine.swift) owns this loader and talks to it through `prefetch` /
// `streamLoad` / `streamDecision` / `evict` and the progress/verdict
// callbacks. The shared models (`NativeTrack`, `NativeEngineState`, …) stay in
// AudioEngine.swift; the pure resume/verify decisions stay in
// BackgroundAudioCore. Keep it that way — do not let engine state leak in.

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
    /// Monotonic-second provider for the last reported network PATH
    /// transition (2026-10-02e). Injected by the engine so a loader failure
    /// line carries the SAME churn-vs-stable-path attribution the engine's
    /// lines do. Nil (tests/previews) is honest: no transition observed.
    var networkChangeStampProvider: (() -> Double?)?
    /// One evidence tail for a transport failure: the stable error identity
    /// (`TransferFailureTaxonomy`) plus the churn-vs-keep-alive attribution
    /// (`TransferCutCorrelation`). Appended to every failure line that takes
    /// a raw URLSession error, so a field dump can discriminate interface
    /// churn from a reverse-proxy race with no guessing. See AGENTS.md
    /// 2026-10-02e for the discriminator's limit (it only sees transitions
    /// the OS REPORTS).
    func transferEvidence(_ error: Error) -> String {
        let info = TransferFailureInfo.classify(error)
        let correlation = TransferCutCorrelation.evidenceLine(
            failure: info,
            lastNetworkChangeAt: networkChangeStampProvider?(),
            cutAt: ProcessInfo.processInfo.systemUptime)
        return "[\(info.evidenceLine) \(correlation)]"
    }

    // MARK: Fresh-connection retry sessions (2026-10-02f)

    /// One-shot demand set by the engine when the retry ladder decided a cut
    /// was attributed to a stable local path (`churnUnlikely`): the suspect
    /// pooled keep-alive socket must not be reused. Consumed by the next
    /// attempt the loader issues; every ordinary path is untouched.
    private var freshConnectionPending = false

    /// Called by the engine (main thread) before a fresh-connection retry.
    func requestFreshConnectionForNextAttempt() {
        freshConnectionPending = true
    }

    /// Consume the one-shot demand. Main-thread-only, like all loader state.
    private func consumeFreshConnection() -> Bool {
        defer { freshConnectionPending = false }
        return freshConnectionPending
    }

    /// WHY a separate SESSION is the mechanism: a URLSession's connection pool
    /// is per-session, so a session that has never issued a request provably
    /// has no pooled socket to inherit. A request-level `Connection: close` is
    /// deliberately NOT the guarantee — CFNetwork's honoring of it is not a
    /// documented contract. The pool is ROTATED per fresh retry; the retired
    /// session drains with `finishTasksAndInvalidate` so an attempt still
    /// running is never cancelled.
    private var retrySession: URLSession? = nil
    private var retiredRetrySessions: [URLSession] = []

    private static func makeTransferSession() -> URLSession {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        return URLSession(configuration: config)
    }

    /// (2026-10-02g) How many attempts actually ran on a ROTATED pool — the
    /// ENACTMENT half of the retry-branch counters (the engine counts the
    /// decisions). Incremented only where a rotation really happens, so the
    /// design gap is visible: a fresh decision whose attempt takes the
    /// opaque-resumeData shape keeps the shared session and is NOT counted.
    private(set) var freshConnectionAttempts = 0

    /// Start a fresh observation window for the ENACTMENT half of the retry
    /// counters (2026-10-02h). The engine resets the decision half and calls
    /// this beside it, so the HUD's summary line never mixes two windows.
    func resetFreshConnectionAttempts() {
        freshConnectionAttempts = 0
    }

    /// A pool that cannot inherit any previous socket.
    private func rotateRetrySession() -> URLSession {
        freshConnectionAttempts += 1
        retrySession?.finishTasksAndInvalidate()
        if let old = retrySession { retiredRetrySessions.append(old) }
        if retiredRetrySessions.count > 4 { retiredRetrySessions.removeFirst() }
        let fresh = TrackFileLoader.makeTransferSession()
        retrySession = fresh
        return fresh
    }

    /// The stream path's equivalent: a fresh pool AND a fresh delegate (the
    /// delegate is per-session state — see `streamSession`).
    private var retryStreamSession: URLSession? = nil
    private var retryStreamDelegate: StreamWriterDelegate? = nil
    private var retiredFreshStreamSessions: [URLSession] = []

    private func rotateStreamSessionForFreshConnection() -> (URLSession, StreamWriterDelegate) {
        freshConnectionAttempts += 1
        retryStreamSession?.finishTasksAndInvalidate()
        if let old = retryStreamSession { retiredFreshStreamSessions.append(old) }
        if retiredFreshStreamSessions.count > 4 { retiredFreshStreamSessions.removeFirst() }
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        let delegate = StreamWriterDelegate()
        delegate.owner = self
        retryStreamDelegate = delegate
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        retryStreamSession = session
        return (session, delegate)
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
    /// The cacheKey of a writer the engine DELIBERATELY cancelled (stall
    /// give-up). Set at the cancel site, read by the continuation veto, so the
    /// queued-error race (the task already completed with a non-cancel error
    /// when cancel() ran) cannot resurrect a stream the engine gave up on.
    /// Cleared when a writer verdict clears or a new attempt begins.
    private var deliberatelyCancelledWriterKey: String? = nil
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
        // TRANSCODES STREAM TOO (2026-10-02): the old raw-only guard existed
        // because the byte-exact promotion verdict could not anchor an
        // estimate Content-Length — that reason is gone (a transcode writer
        // now ends through `writerCompleteVerdict(transcode:) → nil`, the
        // decodability + duration-corroboration path) and the staged estimate
        // is container-shape-honest (`StreamSchedule.stagedEndFramesEstimate`).
        // The transfer's own total arrives in the response; a chunked
        // response with no total cannot be estimated and is withheld by
        // `StreamPolicy.mayDeliverProgress` (the load then completes and
        // promotes — today's full-download behavior).
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
        // A fresh attempt begins: any cancel flag from a prior writer for this
        // key must not veto THIS writer's future failure.
        deliberatelyCancelledWriterKey = nil
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
        // FRESH CONNECTION (2026-10-02f): an attempt the retry ladder
        // attributed to a stable local path must not inherit the suspect
        // pooled keep-alive socket — a rotated pool (and its delegate)
        // replace this attempt's session. Everything else is unchanged.
        let attemptSession: URLSession
        let attemptDelegate: StreamWriterDelegate?
        if consumeFreshConnection() {
            let rotated = rotateStreamSessionForFreshConnection()
            attemptSession = rotated.0
            attemptDelegate = rotated.1
            event(.info, "stream: fresh connection for this attempt (stable-path cut)")
        } else {
            attemptSession = streamSession
            attemptDelegate = streamWriterDelegate
        }
        let task = attemptSession.dataTask(with: request)
        attemptDelegate?.attach(handle)
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
    func writerDidReceiveResponse(announced: Int64, statusCode: Int, contentRangeStart: Int64?) {
        guard var writer = streamWriter else { return }
        // A continuation must be answered by an ALIGNED 206. Two shapes are
        // not appendable: a non-206 (a plain 200 = the WHOLE file from byte
        // 0) and a 206 whose Content-Range start does not equal the requested
        // offset (a misaligned body — appending splices bytes from the wrong
        // position mid-file). The download path has always validated the
        // start (`parseContentRangeStart`); the writer path checked only the
        // status, so the 2026-10-03 hard-error route (which moves transport
        // cuts off the download path and onto this one) would have widened
        // that gap. One shared predicate answers both transports identically.
        if writer.resumeOffset > 0,
           !DownloadResume.rangeResponseIsAppendable(
               statusCode: statusCode,
               contentRangeStart: contentRangeStart,
               requestedOffset: writer.resumeOffset) {
            // The continuation's request was answered with a NON-range body
            // (a plain 200 = the WHOLE file from byte 0) or a MISALIGNED 206.
            // Appending it
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
            event(.danger, "stream: continuation answered \(statusCode) (range start \(contentRangeStart.map { String($0) } ?? "nil") ≠ requested \(writer.resumeOffset); not appendable) for \(writer.track.trackId) — scratch destroyed, fresh download (no in-writer overwrite)")
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
        let transcode = TrackVariant(url: track.url) != .raw
        let lead = StreamPolicy.effectiveLeadSeconds(trackDuration: track.duration)
        // BYTE↔LEAD rate (2026-10-02, transcode streaming): a transcode's
        // snapshot `size` is the SOURCE file's bytes — sizing the lead from it
        // would demand ~85 % of the output before PLAYABLE. The response's own
        // Content-Length is the transfer's total where the server announces
        // one; raw keeps the snapshot total unchanged.
        let leadTotal = StreamPolicy.effectiveTotalBytes(
            snapshotBytes: Int64(track.size), announcedBytes: writer.announcedBytes)
        let leadBytes = MaturationStageSupport.bytesForLeadWithFallback(
            fileBytes: leadTotal, duration: track.duration, leadSeconds: lead)
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
        // A TRANSCODE with no announced total (chunked response) has no honest
        // schedule end — delivering a PLAYABLE source would cycle the
        // stall/give-up/retry machine. Withhold the delivery; the transfer
        // completes and promotes through the duration gate, which is exactly
        // today's full-download behavior (2026-10-02, transcode streaming).
        guard StreamPolicy.mayDeliverProgress(announcedBytes: writer.announcedBytes, transcode: transcode) else { return }
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
    /// THE single continuation-eligibility derivation. Both `writerDidComplete`
    /// verdicts — the clean `.earlyClose` and the hard-error transport cut —
    /// ask this one question, so they cannot drift in what they check or in
    /// how they derive it (the 2026-10-03 hard-error route was added precisely
    /// because the two branches had drifted). The caller supplies the
    /// hard-error-only veto (a deliberate cancel has no meaning on a clean
    /// close, which carries no error at all).
    private func continuationEligible(writer: StreamWriter, deliberateCancel: Bool = false) -> Bool {
        DownloadResume.writerErrorContinuationEligible(
            offset: writer.accumulatedBytes,
            hasRetainedPart: FileManager.default.fileExists(atPath: writer.part.path),
            continuationAttempt: writer.continuationAttempt,
            rangeUnsupported: rangeUnsupportedKeys.contains(writer.cacheKey),
            deliberateCancel: deliberateCancel)
    }

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
            deliberatelyCancelledWriterKey = nil
        }
        if let error {
            // NEAR-COMPLETE RECOVERY (2026-10-02b): a late transient failure
            // can leave a body that already carries the whole track — judge it
            // through the same transcode gate the clean close uses before
            // retaining a scratch the server may be unable to continue.
            if let promotedBytes = promotePartialTranscodeOnWriterError(writer) {
                event(.info, "stream: promoted \(writer.track.trackId) (\(promotedBytes)B) despite writer error (\(error.localizedDescription)) — duration-corroborated partial")
                let final = StreamProgress(
                    trackId: writer.track.trackId,
                    url: writer.destination,
                    stage: .complete,
                    deliveredBytes: promotedBytes,
                    announcedBytes: writer.announcedBytes)
                flushWriterChains(key: writer.cacheKey, url: writer.destination, error: nil)
                clearWriterState()
                onFinished?(final, nil)
                onDownloadFinished?(writer.track.trackId, true)
                return
            }
            // IN-LOADER CONTINUATION FOR A HARD TRANSPORT CUT (2026-10-03,
            // the 1.2.50 restart-from-0:00 field report). The `.earlyClose`
            // branch below has owned its own recovery since 2026-09-24, but
            // THIS branch — the `cannot parse response` / connection-lost
            // shape — handed every cut to the JS retry. The field log is the
            // proof: a -1017 cut at 3,349,014 of 3,431,872 B (97.6 %) retained
            // the scratch, then a `stopPlayback` + reload ~1 s later
            // re-engaged from 0:00 with the bar full. The eligibility is the
            // SAME pure decision the clean early close uses
            // (`writerErrorContinuationEligible`) so the two verdicts can
            // never drift. Continuing re-requests the remainder with
            // `Range: bytes=<delivered>-` into the SAME .part the staged
            // schedule reads: audio never stops, the staged schedule stays
            // live, and no JS retry round trip runs.
            // `deliberateCancel`: the stall give-up cancels the task on
            // purpose (`cancelActiveWriterRetainingScratch` nils the engine
            // legs but leaves `streamWriter` set), and that cancellation
            // surfaces here as -999. Continuing it would resurrect the stream
            // the engine just gave up on — only a genuine transport cut may
            // continue. The veto lives in the pure predicate so it is
            // test-pinned, not re-decided at the call site.
            // The veto is the EXPLICIT cancel-site flag (authoritative through
            // the queued-error race) OR the error's own -999 classification (a
            // system cancel). Pinned in DownloadResumeTests.
            let deliberateCancel = DownloadResume.deliberateWriterCancel(
                explicitFlag: deliberatelyCancelledWriterKey == writer.cacheKey,
                classifiedCancelled: TransferFailureInfo.classify(error).kind == .cancelled)
            if writer.accumulatedBytes >= TrackFileLoader.minimumAudioBytes,
               continuationEligible(writer: writer, deliberateCancel: deliberateCancel) {
                // Retention substrate parity with `.earlyClose`: if the
                // continuation itself aborts (reopen failure), the retained
                // prefix still lets the JS retry Range-continue rather than
                // re-download from zero.
                pendingParts[writer.cacheKey] = DownloadResume.Pending(
                    parts: [writer.accumulatedBytes],
                    announcedTotal: writer.announcedBytes)
                maturationByteFloor[writer.cacheKey] = writer.accumulatedBytes
                let chains = streamWriterChains.removeValue(forKey: writer.cacheKey) ?? []
                startWriterContinuation(writer: writer, chained: chains)
                return
            }
            clearWriterState()
            event(.danger, "stream: writer failed for \(writer.track.trackId): \(error.localizedDescription) — scratch retained (\(writer.accumulatedBytes)B) \(transferEvidence(error))")
            // ^ the trailing [] is the failure IDENTITY + churn-vs-keep-alive
            // attribution (2026-10-02e). This was the field's `cannot parse
            // response` line; it now says which -1017-class failure it was and
            // whether a network transition could explain it.
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
            announcedBytes: writer.announcedBytes,
            // A transcode's announced length is an estimate: the verdict is
            // deliberately nil, routing the completion through the
            // decodability + duration-corroboration path below (2026-10-02).
            transcode: TrackVariant(url: writer.track.url) != .raw)
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
                if continuationEligible(writer: writer) {
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
                // Same bookkeeping the byte-exact `.promote` branch runs: the
                // decodability path is now the NORMAL completion for every
                // transcode, so a retained scratch / stale resume offer must
                // not survive a successful promote (2026-10-02).
                let elapsed = max(0.05, Date().timeIntervalSince(writer.claimedAt))
                recentTransferRate = Double(size) / elapsed
                resumeDataByCacheKey[writer.cacheKey] = nil
                rangeUnsupportedKeys.remove(writer.cacheKey)
                maturationByteFloor[writer.cacheKey] = nil
                dropPending(cacheKey: writer.cacheKey, destination: writer.destination)
                let announcedForProgress = writer.announcedBytes
                event(.info, "stream: promoted \(writer.track.trackId) (\(size)B, announced \(announcedForProgress) — decodability+duration-gated)")
                flushWriterChains(key: writer.cacheKey, url: writer.destination, error: nil)
                let final = StreamProgress(
                    trackId: writer.track.trackId,
                    url: writer.destination,
                    stage: .complete,
                    deliveredBytes: size,
                    announcedBytes: announcedForProgress)
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
            event(.danger, "stream: continuation reopen failed for \(track.trackId): \(error.localizedDescription) — handing to the JS retry \(transferEvidence(error))")
            abortContinuation(writer: writer, chained: chained)
            return
        }
        // Every failure path above returns; reaching here means the reopen
        // and the append-seek both succeeded.
        guard let handle = reopenedHandle else { return }
        var request = URLRequest(url: track.url)
        request.timeoutInterval = 120
        request.setValue(DownloadResume.rangeHeader(offset: continueFrom), forHTTPHeaderField: "Range")
        // FRESH CONNECTION (2026-10-02f): same one-shot demand as `streamLoad` —
        // a continuation the ladder attributed to a stable local path (the
        // dominant field shape: scratch retained after a mid-body cut) must
        // Range-resume on a pool that cannot inherit the suspect socket.
        let attemptSession: URLSession
        let attemptDelegate: StreamWriterDelegate?
        if consumeFreshConnection() {
            let rotated = rotateStreamSessionForFreshConnection()
            attemptSession = rotated.0
            attemptDelegate = rotated.1
            event(.info, "stream: fresh connection for this continuation (stable-path cut)")
        } else {
            attemptSession = streamSession
            attemptDelegate = streamWriterDelegate
        }
        let task = attemptSession.dataTask(with: request)
        // Reset the delegate's counter: this task delivers the REMAINDER.
        attemptDelegate?.attach(handle)
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

    /// NEAR-COMPLETE RECOVERY ON WRITER ERROR (2026-10-02b field report).
    ///
    /// A writer error is NOT evidence that the delivered bytes are unusable.
    /// The field report's `cannot parse response` (NSURLError-
    /// CannotParseResponse) killed the writer at 2,803,498 of 2,813,296
    /// announced bytes — 99.65 % — and the retention path then kept a scratch
    /// that a Range-IGNORING live transcode server can never continue (the
    /// request was answered 200, not 206), so the row re-downloaded the whole
    /// transcode to gain 9,798 bytes.
    ///
    /// The trust boundary is what is on disk, and the SAME gate the clean
    /// close already uses for a transcode (`writerCompleteVerdict(transcode:)`
    /// → nil → decodability + `DownloadSanity.transcodeDurationCorroborated`)
    /// answers exactly the right question here: does the partial body already
    /// carry the track's full audio? Run it before falling back to retention.
    /// A genuinely cut body fails the same gate the clean-close path would
    /// fail it with, so this widens RECOVERY, never the completeness bar.
    ///
    /// Returns the promoted byte count, or nil when the body is not
    /// promotable — in which case the .part is restored byte-for-byte so the
    /// caller's retention path runs unchanged.
    private func promotePartialTranscodeOnWriterError(_ writer: StreamWriter) -> Int64? {
        // RAW streams keep the byte-exact verdict: an error means the transfer
        // is short, and the byte gate — not duration — is their honesty test.
        guard TrackVariant(url: writer.track.url) != .raw else { return nil }
        guard FileManager.default.fileExists(atPath: writer.part.path) else { return nil }
        let onDisk = (try? FileManager.default.attributesOfItem(atPath: writer.part.path)[.size] as? Int64) ?? 0
        guard onDisk >= TrackFileLoader.minimumAudioBytes else { return nil }
        do {
            if FileManager.default.fileExists(atPath: writer.destination.path) {
                try FileManager.default.removeItem(at: writer.destination)
            }
            try FileManager.default.moveItem(at: writer.part, to: writer.destination)
            let probeFile = try? AVAudioFile(forReading: writer.destination)
            let probeFrames = probeFile?.length ?? 0
            let probeSampleRate = probeFile?.fileFormat.sampleRate ?? 0
            // Undecodable, or the container's own claim is short of the
            // metadata duration → NOT complete: restore the scratch exactly
            // where the retention path expects it.
            guard probeFrames > 0,
                  !DownloadSanity.transcodeDurationCorroborated(
                    probeFrames: probeFrames,
                    sampleRate: probeSampleRate,
                    metadataDuration: writer.track.duration,
                    transcode: true) else {
                try? FileManager.default.moveItem(at: writer.destination, to: writer.part)
                return nil
            }
            let size = onDisk
            let elapsed = max(0.05, Date().timeIntervalSince(writer.claimedAt))
            recentTransferRate = Double(size) / elapsed
            resumeDataByCacheKey[writer.cacheKey] = nil
            rangeUnsupportedKeys.remove(writer.cacheKey)
            maturationByteFloor[writer.cacheKey] = nil
            dropPending(cacheKey: writer.cacheKey, destination: writer.destination)
            state.store(writer.destination, for: writer.cacheKey, bytes: Int(size))
            variantOf[writer.cacheKey] = TrackVariant(url: writer.track.url)
            return size
        } catch {
            return nil
        }
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
        // EXPLICIT deliberate-cancel flag (2026-10-03b): set BEFORE the cancel
        // so the veto holds even if the task had already completed with a
        // non-cancel error (the queued-error race — cancel() is then a no-op
        // and the surfaced error is not -999).
        deliberatelyCancelledWriterKey = streamWriter?.cacheKey
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
        // FRESH CONNECTION (2026-10-02f): consume the ladder's one-shot demand
        // HERE, where an attempt is actually about to be issued. The returns
        // ABOVE (cache serve, in-flight chain, live writer) are not attempts —
        // spending the demand on one would silently waste it and the retry's
        // real attempt would land on the same pooled socket it must avoid.
        let freshTransferRequested = consumeFreshConnection()
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
                // ONE range-append decision for this attempt, the SAME rule
                // the writer path uses (`rangeResponseIsAppendable(statusCode:
                // contentRangeStart:requestedOffset:)`): a Range answer is
                // appendable iff it is an ALIGNED 206. A non-206 (server
                // ignored the Range, body = the WHOLE file) and a 206 whose
                // Content-Range start is not the requested offset both mean
                // the body REPLACES the prefix — never appends.
                let rangeReqOffset: Int64?
                let rangeAppendable: Bool
                if case .rangeAppend(let reqOffset) = continuation {
                    rangeReqOffset = reqOffset
                    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                    let rangeStart = DownloadResume.parseContentRangeStart(
                        (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Range"))
                    rangeAppendable = DownloadResume.rangeResponseIsAppendable(
                        statusCode: statusCode,
                        contentRangeStart: rangeStart,
                        requestedOffset: reqOffset)
                    if !rangeAppendable {
                        self?.event(.info, "resume: server answered \(statusCode) (start \(rangeStart.map(String.init) ?? "nil"), wanted \(reqOffset)) — not appendable, body REPLACES prefix for \(track.trackId)")
                    }
                } else {
                    rangeReqOffset = nil
                    rangeAppendable = false
                }
                var effectiveSize = 0
                if let reqOffset = rangeReqOffset, let temp = tempURL, rangeAppendable {
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
                        self?.event(.danger, "resume append failed for \(track.trackId): \(error.localizedDescription) — falling back to fresh \(self?.transferEvidence(error) ?? "")")
                        try? FileManager.default.removeItem(at: part)
                        effectiveSize = -1 // force the fresh path below
                    }
                } else if rangeReqOffset != nil, !rangeAppendable {
                    // Not appendable: discard the retained prefix (its bytes
                    // cannot be separated from a whole or misaligned body)
                    // and remember the server as range-unsupported.
                    try? FileManager.default.removeItem(at: part)
                    self?.rangeUnsupportedKeys.insert(cacheKey)
                }
                // A range-appended attempt reads its merged bytes from the
                // .part file; fresh/not-appendable attempts move `temp` into
                // the validation pipeline below. `mergeSource` is the file
                // the gates judge.
                var mergeSource: URL? = temp
                if rangeReqOffset != nil, rangeAppendable,
                   effectiveSize >= 0, FileManager.default.fileExists(atPath: part.path) {
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
        // A fresh-connection retry runs on a rotated pool (2026-10-02f): the
        // ordinary prefetch/download paths keep the shared session exactly as
        // before, so no in-flight chain is disturbed by the rotation.
        // Only the REQUEST-based shapes rotate: URLSession's opaque resumeData
        // is bound to the session that produced it, so that continuation keeps
        // the shared session. The Range-append shape — the field's actual
        // recovery path after a mid-body cut — is request-based and rotates.
        let transferSession = (freshTransferRequested && resumeData == nil)
            ? rotateRetrySession()
            : session
        let task: URLSessionDownloadTask = resumeData != nil
            ? transferSession.downloadTask(withResumeData: resumeData!, completionHandler: completionBody)
            : transferSession.downloadTask(with: request!, completionHandler: completionBody)
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
        // The continuation's alignment evidence: a 206 must name the
        // requested start — a mismatched (or missing) Content-Range is the
        // splice poison class, converted to a fresh download on main.
        let contentRangeStart = (response as? HTTPURLResponse)
            .flatMap { DownloadResume.parseContentRangeStart($0.value(forHTTPHeaderField: "Content-Range")) }
        DispatchQueue.main.async { [weak self] in
            self?.owner?.writerDidReceiveResponse(announced: announced, statusCode: status, contentRangeStart: contentRangeStart)
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
