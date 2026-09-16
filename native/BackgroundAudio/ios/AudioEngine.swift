import Foundation
import AVFoundation
import Accelerate
import BackgroundAudioCore

// MARK: - Shared models

public struct NativeTrack {
    public let index: Int
    public let trackId: String
    public let title: String
    public let artist: String
    public let album: String
    public let duration: Double
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
            deliver(url, nil)
            return
        }
        let cacheKey = transcodeCacheKey(trackId: track.trackId, variant: requested)
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
        let task = session.downloadTask(with: track.url) { [weak self] tempURL, _, error in
            // The temp file is only valid until this handler returns. Move it
            // synchronously on the delegate queue before hopping to main — an
            // async hop would let the system delete the temp file first, which
            // is exactly the "couldn't be opened because there is no such file"
            // seen in the HUD. State bookkeeping (isCurrent/complete/store) still
            // happens on main.
            var movedURL: URL? = nil
            var moveError: Error? = nil
            if let temp = tempURL, error == nil {
                do {
                    let parent = destination.deletingLastPathComponent()
                    try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
                    if FileManager.default.fileExists(atPath: destination.path) {
                        try FileManager.default.removeItem(at: destination)
                    }
                    do {
                        try FileManager.default.moveItem(at: temp, to: destination)
                    } catch {
                        print("[native] moveItem failed for \(track.trackId) \(error.localizedDescription) — trying copy")
                        try FileManager.default.copyItem(at: temp, to: destination)
                        try? FileManager.default.removeItem(at: temp)
                    }
                    movedURL = destination
                } catch {
                    moveError = error
                    print("[native] final store failed for \(track.trackId) dir=\(destination.deletingLastPathComponent().path) err=\(error.localizedDescription) tempExists=\(FileManager.default.fileExists(atPath: temp.path)) destParentExists=\(FileManager.default.fileExists(atPath: destination.deletingLastPathComponent().path))")
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
                    self.state.store(moved, for: cacheKey)
                    self.variantOf[cacheKey] = requested
                    deliver(moved, nil)
                    pendings.forEach { $0(moved, nil) }
                    self.onDownloadFinished?(track.trackId, true)
                } else {
                    let err = moveError ?? error
                    // If we moved but became stale, the file was already cleaned above.
                    // Otherwise report the download/move error to trigger retry.
                    deliver(nil, err)
                    pendings.forEach { $0(nil, err) }
                    self.onDownloadFinished?(track.trackId, false)
                }
            }
        }
        if state.claim(cacheKey, task: task, requestID: requestID) {
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
            if let url = url {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    /// The trackId fragment of a composite cache key ("trackId|variant").
    private func trackId(of cacheKey: String) -> String {
        guard let idx = cacheKey.firstIndex(of: "|") else { return cacheKey }
        return String(cacheKey[cacheKey.startIndex..<idx])
    }

    /// Cached composite keys — read by the engine's preload-progress sampler
    /// to distinguish "download finished" (key present) from "evicted/gone".
    var cacheKeys: Set<String> { Set(state.cache.keys) }

    /// Deletes cached files for tracks that are no longer within `keepRadius` of `currentIndex`.
    func cleanup(currentIndex: Int, tracks: [NativeTrack], keepRadius: Int = 3) {
        let minIndex = currentIndex - keepRadius
        let maxIndex = currentIndex + keepRadius
        for track in tracks where track.index < minIndex || track.index > maxIndex {
            evict(track.trackId)
        }
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

    public override init() {
        super.init()
        // The real fix for the 1.2.13 launch crash is in setupGraph(): every
        // node is attached before it is connected (the crash was an
        // unattached spectrumTap). Kept simple on purpose — AVFoundation
        // raises ObjC NSExceptions that Swift's do/catch cannot intercept,
        // and a wrong-graph-silently-playing app is worse than a loud
        // developer-visible crash in a build the store never shipped.
        // Defense = the attach/connect audit in the docs + this comment.
        setupGraph()
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
    @discardableResult
    private func ensureEngineRunning() -> Bool {
        guard !engine.isRunning else { return true }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: SessionController.categoryOptions(for: audioMixingMode))
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Non-fatal: engine.start may still succeed if session already active.
            print("[native] ensureEngineRunning session activate failed: \(error.localizedDescription)")
        }
        installSpectrumTapIfNeeded()
        engine.prepare()
        do {
            try engine.start()
            return true
        } catch {
            print("[native] engine start failed: \(error.localizedDescription)")
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

    public func playTrack(at index: Int, autoPlay: Bool) {
        guard !tracks.isEmpty else { return }
        let clamped = max(0, min(index, tracks.count - 1))
        let oldTrackId = currentTrackId
        // A new track instance starts with clean crossfade automation — a
        // suppression latched by seeking inside the PREVIOUS track's window
        // must not leak (loop-one restarts clear it too; same id, new play).
        seekSuppressedTrackId = nil
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
        guard let synchronizedIndex = synchronizedQueueActiveIndex(
            snapshotActiveId: snapshotActiveId,
            engineCurrentId: currentTrackId,
            requestedIndex: activeIndex,
            trackCount: tracks.count
        ) else {
            // Divergent queue — fall back to a full reset and report ENDED (1.4,
            // mirroring handleTrackEnd): the honest signal that JS navigates the
            // stale index. On `ended` JS re-snapshots from its own authoritative
            // queue, so the engine can't sit on a snapshot JS can't navigate.
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
            print("[native-crossfade] queue-refresh phase=\(crossfade.phase) target=\(self.tracks[crossfade.targetIndex].trackId)")
            return self.tracks[crossfade.targetIndex].trackId
        }()
        self.tracks = tracks
        // The active track ID stayed the same, but its position may have moved
        // after a queue mutation. Keep the native clock attached to that ID by
        // re-anchoring the index before rebuilding any crossfade tail.
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
        ensureEngineRunning()
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
        cachedPosition = currentPosition
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
        crossfadeDuration = max(0, min(15, duration))
        crossfadeCurve = curve
        self.sigmoidSteepness = sigmoidSteepness
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
        let currentId = currentTrackId
        for (key, trackId, received, expected) in loader.inFlightProgress {
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
        let inFlightIds = Set(loader.inFlightProgress.map { $0.trackId })
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
            "preampDb": preampDb,
            "hasLocalURL": hasLocal,
            "computedDurations": computedDurations.count,
            "waitingAtTrackEnd": waitingAtTrackEnd,
            "sleepAtTrackEnd": sleepAtTrackEnd,
            "paramsDirty": paramsDirty,
            "speed": speed,
            "pitchOctaves": pitchOctaves,
            "tapeMode": tapeMode,
        ]
    }

    /// Position within the current track, in seconds.
    public var currentPosition: Double {
        guard isPlaying,
              let nodeTime = activeNode.lastRenderTime,
              let playerTime = activeNode.playerTime(forNodeTime: nodeTime) else {
            return cachedPosition
        }
        let raw = Double(playerTime.sampleTime) / playerTime.sampleRate
        return max(0, raw + positionBias)
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

        let generation = scheduleGeneration
        loader.prefetch(track) { [weak self] url, error in
            guard let self = self else { return }
            // The user moved on (next-skip, another load) while this file was
            // downloading — leave the newer schedule alone.
            guard generation == self.scheduleGeneration else {
                print("[native] loadAndStart dropped stale generation \(generation) vs \(self.scheduleGeneration) for \(track.trackId)")
                return
            }
            guard let url = url else {
                self.onError?(error?.localizedDescription ?? "Failed to load track")
                return
            }
            guard self.tracks.indices.contains(self.activeIndex),
                  self.tracks[self.activeIndex].trackId == track.trackId else {
                let current = self.tracks.indices.contains(self.activeIndex) ? self.tracks[self.activeIndex].trackId : "OOR"
                print("[native] loadAndStart dropped divergent track \(track.trackId) vs \(current) gen=\(generation) active=\(self.activeIndex)")
                self.onError?("Track diverged: \(track.title)")
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
    private func prefetchUpcoming(from index: Int, total: Int? = nil, seen: Set<Int> = [], generation: Int? = nil) {
        let totalCount = total ?? (crossfadeDuration > 0 ? max(1, preloadCount) : preloadCount)
        guard totalCount > 0, seen.count < totalCount else { return }
        let gen = generation ?? prefetchGeneration
        // Function parameters are constants; the dedupe set mutates per step.
        var seen = seen
        guard let next = nextIndex(after: index),
              tracks.indices.contains(next),
              seen.insert(next).inserted else { return }
        let track = tracks[next]
        loader.prefetch(track) { [weak self] _, error in
            guard let self = self else { return }
            guard gen == self.prefetchGeneration else { return }
            if error != nil {
                // A failed prefetch must not sit "fetching" forever (frozen-
                // tint report): gone clears the row's tint now.
                self.emitPreload(track.trackId, "gone", nil)
            }
            self.crossfadeMonitorTick()
            self.prefetchUpcoming(from: next, total: totalCount, seen: seen, generation: gen)
        }
    }

    /// Schedules the current track on the active node, ready to play.
    private func scheduleCurrentTrack(from seconds: Double, autoPlay: Bool) {
        guard tracks.indices.contains(activeIndex) else { return }
        let track = tracks[activeIndex]
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
            handleTrackEnd()
            return
        }

        scheduleGeneration += 1
        let generation = scheduleGeneration

        activeGain.outputVolume = Float(track.replayGainLinear(mode: replayGainMode))
        standbyGain.outputVolume = 0
        standbyNode.stop()

        let player = activeNode
        let scheduledIndex = activeIndex
        player.stop()
        // Both nodes are stopped now: apply speed/pitch/tape fields to the
        // units, which are only ever touched while nothing is rendering.
        refreshPlaybackParams()
        player.scheduleSegment(file, startingFrame: startFrame, frameCount: AVAudioFrameCount(frames), at: nil, completionCallbackType: .dataConsumed) { [weak self] _ in
            self?.handleSegmentCompletion(index: scheduledIndex, generation: generation)
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

    private func nextIndex(after index: Int) -> Int? {
        let next = index + 1
        if next < tracks.count { return next }
        if loopMode == .all { return 0 }
        return nil
    }

    private func handleTrackEnd() {
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
            playTrack(at: next, autoPlay: true)
        } else {
            handleTrackEnd()
        }
    }

    private func handleSegmentCompletion(index completedIndex: Int, generation: Int, isStandby: Bool = false) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard generation == self.scheduleGeneration else { return }
            if isStandby {
                guard self.standbyGeneration == self.standbyScheduleGeneration else { return }
            }

            // The active player finishing while a crossfade is in progress is the switch point.
            if self.crossfade.isInFlight {
                self.finalizeCrossfadeSwitch()
                return
            }

            // Natural end with an end-of-track sleep timer pending: pause here rather
            // than advancing (loop-one also defers — "end of track" wins).
            if self.sleepAtTrackEnd {
                self.sleepAtTrackEnd = false
                self.pause()
                self.waitingAtTrackEnd = true
                self.onSleepTimerFired?()
                return
            }

            if self.loopMode == .one {
                self.playTrack(at: self.activeIndex, autoPlay: true)
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
                self.playTrack(at: next, autoPlay: true)
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
        paramRestartTimer?.invalidate()
        paramRestartTimer = nil
        sleepTimer?.invalidate()
        sleepTimer = nil
        sleepAtTrackEnd = false
        cancelScheduled()
        hasLiveSchedule = false
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

    /// Stops both players and invalidates all pending schedules/completions.
    private func cancelScheduled() {
        scheduleGeneration += 1
        waitingAtTrackEnd = false
        crossfade = .idle
        stopCrossfadeMonitor()
        stopVolumeRamp()
        playerA.stop()
        playerB.stop()
    }

    // MARK: - Crossfade

    private func setupCrossfadeMonitor() {
        stopCrossfadeMonitor()
        guard crossfadeDuration > 0, isPlaying, loopMode != .one, !sleepAtTrackEnd, tracks.indices.contains(activeIndex) else { return }
        // A seek-suppressed track gets no monitor at all — automation is off
        // for the remainder of this track instance.
        guard tracks[activeIndex].trackId != seekSuppressedTrackId else { return }

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
        guard tracks[activeIndex].trackId != seekSuppressedTrackId else { return }

        let current = tracks[activeIndex]
        let transitionPoint = current.duration - crossfadeDuration
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
        let nextTrack = tracks[nextIdx]
        guard let localURL = loader.localURL(for: nextTrack) else {
            reportCrossfadeReadiness(.targetNotReady)
            crossfade = .idle
            return
        }
        guard let file = try? AVAudioFile(forReading: localURL) else {
            // A cached path can still be corrupt. Evict and restart its fetch;
            // the completion will re-check the active window on the main thread.
            print("[native-crossfade] target file could not be opened: \(nextTrack.trackId)")
            loader.evict(nextTrack.trackId, variant: TrackVariant(url: nextTrack.url))
            loader.prefetch(nextTrack) { [weak self] _, _ in
                self?.crossfadeMonitorTick()
            }
            crossfade = .idle
            return
        }

        crossfade = crossfade.starting(targetIndex: nextIdx)
        let formattedPosition = String(format: "%.2f", currentPosition)
        print("[native-crossfade] start current=\(currentTrackId) target=\(nextTrack.trackId) position=\(formattedPosition)")
        let targetGain = Float(nextTrack.replayGainLinear(mode: replayGainMode))
        let startGain = activeGain.outputVolume
        let duration = Float(crossfadeDuration)

        // Keep the current generation: we must NOT invalidate the active player's
        // pending completion, which is what finalizes the crossfade at its natural end.
        let generation = scheduleGeneration

        standbyNode.stop()
        standbyGain.outputVolume = 0
        standbyGeneration = standbyScheduleGeneration
        standbyNode.scheduleSegment(file, startingFrame: 0, frameCount: AVAudioFrameCount(file.length), at: nil, completionCallbackType: .dataConsumed) { [weak self] _ in
            self?.handleSegmentCompletion(index: nextIdx, generation: generation, isStandby: true)
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
        print("[native-crossfade] ramp-start duration=\(plan.duration) steps=\(RampPlan.stepCount)")
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
        print("[native-crossfade] readiness=\(readiness) track=\(currentTrackId) position=\(formattedPosition) fade=\(crossfadeDuration)")
    }

    private func finalizeCrossfadeSwitch() {
        stopVolumeRamp()
        stopCrossfadeMonitor()
        let targetIndex = crossfade.targetIndex
        crossfade = .idle

        activeIndex = targetIndex
        syncPreloadWindow()
        // A crossfade switched WITHOUT playTrack: a refreshQueue during the
        // fade killed the in-flight chain (generation bump) and the old chain
        // was sized for the PREVIOUS position anyway. Restart from the new
        // current index so the window keeps filling (2026-09-15).
        prefetchUpcoming(from: targetIndex)
        isActiveB.toggle()
        standbyNode.stop()
        standbyGain.outputVolume = 0
        positionBias = 0
        cachedPosition = 0
        activeGain.outputVolume = Float(tracks[activeIndex].replayGainLinear(mode: replayGainMode))
        let formattedPosition = String(format: "%.2f", currentPosition)
        print("[native-crossfade] complete track=\(tracks[activeIndex].trackId) position=\(formattedPosition)")

        onTrackChanged?(tracks[activeIndex].trackId)
        setupCrossfadeMonitor()
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
