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
    /// Phase 0/2 (2026-10-07): the seek-capability declaration for this row,
    /// derived by JS from the SAME transcode decision that built `url`. Nil
    /// (absent or malformed) = the engine takes the Phase-1 wait path.
    public let seekCapability: SeekCapability?

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
        if let cap = dict["seekCapability"] as? [String: Any] {
            self.seekCapability = SeekCapability(dict: cap)
        } else {
            self.seekCapability = nil
        }
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
    /// Fired when the recovery ladder gives up (bounded retries + one rebuild
    /// all failed). JS surfaces a persistent "restart audio" affordance and
    /// STOPS advancing the queue — the 2026-10-04 dump showed the old code
    /// silently skipping row after row into a dead engine.
    public var onEngineUnavailable: (() -> Void)?
    /// Fired when the engine starts successfully after having surfaced.
    public var onEngineRecovered: (() -> Void)?
    /// Fired when the engine proved an interruption flag was STALE and cleared
    /// it (2026-10-08): a start succeeded, or a failure only a usable session
    /// can produce, while `interruptionActive` still read true. The plugin
    /// mirrors the clear onto `SessionController` so its edge guard cannot
    /// swallow the NEXT genuine `.began`.
    public var onStaleInterruptionCleared: (() -> Void)?
    // (loader hook wired in setup, below)

    // MARK: - Nodes

    // NOTE: these are `var`, not `let`, because the whole stack is rebuilt on
    // a session invalidation (`rebuildAudioStack()`) — the 2026-10-04 field
    // bug was a graph built ONCE at init that could never recover. Recreating
    // every node avoids re-attaching a node that a dead engine may still
    // reference. Do NOT turn these back into `let`.
    private var engine = AVAudioEngine()
    private var playerA = AVAudioPlayerNode()
    private var playerB = AVAudioPlayerNode()
    private var gainA = AVAudioMixerNode()
    private var gainB = AVAudioMixerNode()
    private var mixer = AVAudioMixerNode()
    private var timePitch = AVAudioUnitTimePitch()
    private var varispeed = AVAudioUnitVarispeed()
    private var eq = AVAudioUnitEQ(numberOfBands: 24)
    private var preamp = AVAudioMixerNode()

    // ── Spectrum tap (2026-09-15) ────────────────────────────────────────
    // A TAP node connected FROM the preamp in parallel with the main path
    // (preamp → mainMixerNode stays untouched); the tap's own output is
    // left unconnected — AVAudioEngine renders any tapped node, so the
    // engine copies frames into `spectrumTapBuffer` on the realtime thread
    // (preallocated, no locks/no allocation in the callback — a torn frame
    // is acceptable for a visualization). The FFT + band aggregation run
    // on the MAIN thread at read time (`spectrum()`), publishing the
    // per-band snapshot under `spectrumLock`.
    private var spectrumTap = AVAudioMixerNode()
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
    /// Monotonic seconds of the last reported network PATH transition
    /// (2026-10-02e). Stamped by the plugin's NWPathMonitor handler the
    /// INSTANT a transition is seen — deliberately NOT at the debounced
    /// prefetch re-arm, which fires 2.5 s later and would smear the window
    /// the churn-vs-keep-alive discriminator compares against.
    private var lastNetworkChangeAt: Double?
    /// Rolling counter of the retry ladder's branch decisions (2026-10-02g),
    /// exposed through `getDebugState.retryBranch` for the HUD + Copy dump.
    private var retryBranchStats = TransferRetryBranchStats()

    // MARK: - Engine recovery (2026-10-04)

    /// Mirrors `SessionController.isInterrupted`. While true the recovery
    /// policy waits ONLY for a `sessionNotActive` activation failure — the one
    /// shape a genuine interruption produces. Any other failure proves the
    /// session was activatable and clears the flag as stale (2026-10-08).
    public var interruptionActive = false
    /// Interruption EDGE counters (2026-10-08): the cheapest field evidence.
    /// `begins > ends` in a dump means iOS skipped an `.ended` — the shape
    /// that used to leave the flag stale-true for the rest of the session.
    private var interruptionBeginCount = 0
    private var interruptionEndCount = 0
    /// How many times a start proved the flag stale and it was cleared.
    private var staleInterruptionClears = 0
    /// 1-based count of consecutive failed start attempts, fed to the pure
    /// `EngineRecoveryPolicy`. Reset by any successful start, by an
    /// interruption ending, and by an explicit user restart.
    private var consecutiveEngineStartFailures = 0
    /// True once the ladder surfaced. Until an explicit restart (or an
    /// interruption ending) clears it, `ensureEngineRunning` short-circuits so
    /// the app stops thrashing and the JS side stops skipping the queue.
    private var engineUnavailable = false
    /// Re-entrancy guard: a rebuild's own start attempt must not trigger a
    /// second rebuild from inside itself.
    private var isRebuildingAudioStack = false
    /// Set when a start failure interrupted an intended play (the guarded
    /// play()/schedule sites only fail AFTER the user asked to play). On a
    /// successful recovery the current track resumes from `cachedPosition` —
    /// without this a recovered engine would start silent, since `isPlaying`
    /// was never allowed to flip true. 2026-10-04.
    private var resumeAfterEngineRecovery = false
    /// The ladder's deferred retry (`retryLater` rung).
    private var engineRecoveryTimer: Timer?
    /// `.AVAudioEngineConfigurationChange` observer for the CURRENT engine
    /// instance (object identity changes on every rebuild, so it is
    /// re-registered by `setupGraph`).
    private var configurationChangeObserver: NSObjectProtocol?
    /// Called by the plugin on a network path change (main thread).
    public func noteNetworkChangeOccurred() {
        lastNetworkChangeAt = ProcessInfo.processInfo.systemUptime
    }
    /// Restart the retry-branch observation window (2026-10-02h). Called by
    /// the HUD's Clear all button so a field session can measure the branch
    /// from zero WITHOUT relaunching the app. Both halves are reset together:
    /// the decisions here and the loader's enacted-rotation count — resetting
    /// one leaves the summary line describing two different windows. Logged so
    /// the event ring records the boundary (a dump can tell a genuine zero
    /// from a pre-reset count).
    public func resetRetryBranchStats() {
        retryBranchStats.reset()
        loader.resetFreshConnectionAttempts()
        eventAdd(.info, "loader", "retry counters reset (fresh observation window)")
    }
    /// Classify AND attribute one transport failure, once (2026-10-02e/f).
    /// The evidence string and the retry ladder BOTH read this, so a log line
    /// and the action taken on it can never disagree. A single `cutAt` is
    /// sampled for both, so the printed offset and the bucket are consistent
    /// even at the window boundary.
    internal func transferFailure(
        _ error: Error,
        cutAt: Double = ProcessInfo.processInfo.systemUptime
    ) -> (info: TransferFailureInfo, cut: CutAttribution, evidence: String) {
        let info = TransferFailureInfo.classify(error)
        let cut = TransferCutCorrelation.attribute(
            failure: info, lastNetworkChangeAt: lastNetworkChangeAt, cutAt: cutAt)
        let correlation = TransferCutCorrelation.evidenceLine(
            failure: info, lastNetworkChangeAt: lastNetworkChangeAt, cutAt: cutAt)
        return (info, cut, "[\(info.evidenceLine) \(correlation)]")
    }

    /// The evidence tail for a transport failure (2026-10-02e): the stable
    /// error identity plus the churn-vs-stable-path attribution. Appended to
    /// every engine failure line that takes a raw URLSession error, so a
    /// field dump can discriminate interface churn from a reverse-proxy
    /// keep-alive race. Limit is documented on `TransferCutCorrelation`.
    internal func transferEvidence(_ error: Error) -> String {
        transferFailure(error).evidence
    }

    /// Build the retry ladder's failure record with the attribution attached
    /// (2026-10-02f): the strategy branch (`TransferCutRetryPolicy`) reads
    /// `cut`, and the detail carries the greppable bracket so a retry log line
    /// is as diagnosable as the original cut.
    internal func activeLoadFailure(kind: ActiveLoadFailure.Kind, error: Error) -> ActiveLoadFailure {
        let classified = transferFailure(error)
        return ActiveLoadFailure(
            kind: kind,
            detail: "\(error.localizedDescription) \(classified.evidence)",
            cut: classified.cut)
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
            // The SAME monotonic base the event `t` values use (seconds since
            // process start). JS cannot derive this from a wall clock — the
            // 1.2.48 self-test cut its look-back at Date.now() and matched
            // nothing. A reader can now window the ring on a consistent clock.
            "now": ProcessInfo.processInfo.systemUptime,
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
    /// Phase 1 (2026-10-07, seek-intent plan): a seek that landed before any
    /// schedule could be made for the row — the first staged schedule has not
    /// formed, or the normal download is still in flight. The position is an
    /// INTENT: it is applied by the first schedule that CAN be made
    /// (`startFirstStagedSchedule`, the prefetch completion,
    /// `scheduleStagedFileWhole`) instead of being dropped to 0 or reported as
    /// "Track not ready" → JS retry → reload from 0. Row-scoped: a load for a
    /// DIFFERENT row clears it; a same-row restart keeps it.
    private var pendingSeekSeconds: Double? = nil
    private var pendingSeekTrackId: String? = nil

    // MARK: - Seek epochs (Phase 2, 2026-10-07)

    /// The GLOBAL kill switch (plan §8). `auto` (default) lets a far forward
    /// seek open a server-offset epoch; `off` reproduces Phase-1 behavior
    /// EXACTLY — the position-preserving wait, no extra request — so the
    /// epoch machinery can be disabled in the field without a release.
    /// Pushed by the manager (boot + settings change); persisted in the JS
    /// settings store, so it survives a reload.
    private var seekEpochMode: SeekEpochMode = .auto

    /// The states a server-offset epoch can be in. The epoch's source is an
    /// ephemeral offset transfer (`TrackFileLoader.EpochTransfer`); the engine
    /// owns every AVAudioFile open over it.
    private struct SeekEpochState {
        let trackId: String
        /// The INTEGER second offset actually requested (`timeOffset` is an
        /// integer parameter) — also the timeline base once the verdict says
        /// the offset was honored.
        let baseSeconds: Int
        /// The user's exact intent (>= base): the first schedule starts at
        /// `target - base` INSIDE the epoch, so the sub-second part is not
        /// lost to the integer parameter.
        let targetSeconds: Double
        let transfer: TrackFileLoader.EpochTransfer
        /// The container verdict, evaluated at the first open (nil until a
        /// delivery is openable).
        var verdict: SeekEpochVerdict? = nil
    }

    private var seekEpoch: SeekEpochState? = nil
    private var seekEpochCounter = 0

    // MARK: - Transfer ladder (2026-10-07, Phase 2 follow-up)

    /// The current hold reason, or nil when the walk is free. Transition-only
    /// logging: the hold is re-evaluated on every walk entry (queue edges, the
    /// walk's own recursion, the settle re-arms), and only a CHANGE records an
    /// event — a churn of calls must not flood the ring.
    private var prefetchHoldReason: TransferLadder.Hold? = nil
    private var prefetchHoldCount = 0

    /// The user-transfer state the ladder holds on. ONE derivation for the
    /// walk's hold AND the network re-arm's skip: an epoch counts explicitly
    /// through `epochOpen`, never through `hasActiveWriter` incidentally
    /// including ephemeral epoch writers (pinned by TransferLadderTests).
    private func currentUserTransfer() -> TransferLadder.UserTransfer {
        let activeTrack = tracks.indices.contains(activeIndex) ? tracks[activeIndex] : nil
        let downloading = activeTrack.map { track in
            loader.inFlightProgress.contains { $0.trackId == track.trackId }
        } ?? false
        // A COMPLETE staged file is no longer a bandwidth owner: its writer has
        // settled and the schedule plays from disk — that is exactly why
        // `completeStagedSchedule` arms the walk at its own end (holding here
        // would have silently cancelled that arm).
        return TransferLadder.UserTransfer(
            stagedActive: stagedSchedule != nil && !(stagedSchedule?.isComplete ?? true),
            writerLive: loader.hasActiveWriter,
            epochOpen: seekEpoch != nil,
            activeLoadInFlight: downloading)
    }

    /// The ladder's SETTLE edge: a user transfer just ended, so the speculative
    /// walk may resume. Safe to call more than once — the loader chains a
    /// duplicate request for the same key onto the in-flight task.
    private func rearmPrefetchIfIdle(reason: String) {
        let userTransfer = currentUserTransfer()
        guard TransferLadder.mayIssueNextPrefetch(userTransfer) else {
            // ANOTHER user transfer still owns the link, so this edge stays
            // quiet: it records no hold/resume transition and increments no
            // counter (the walk's own entry records the hold once, and the
            // remaining transfer's settle edge is what finally arms it).
            eventAdd(.debug, "preload", "\(reason) held (\(TransferLadder.hold(userTransfer).rawValue)) — user transfer owns the link")
            return
        }
        armPrefetchWalk(reason: reason)
    }

    /// ONE arm edge for the re-arms that fire OUTSIDE a queue edge — the
    /// network re-arm and the ladder's settle edges. It BUMPS the generation
    /// first: without the bump a re-arm that lands while an older chain is
    /// still walking runs a SECOND concurrent chain, double-walking the window
    /// and amplifying event/tick churn (the discipline
    /// `rearmPrefetchAfterNetworkChange` has documented since 2026-10-02). The
    /// bump does NOT cancel the loader's in-flight downloads, so an already-
    /// fetching row is a no-op rather than a duplicate.
    private func armPrefetchWalk(reason: String) {
        guard !tracks.isEmpty else { return }
        prefetchGeneration += 1
        eventAdd(.info, "preload", "\(reason): prefetchUpcoming from row \(activeIndex) (gen \(prefetchGeneration))")
        prefetchUpcoming(from: activeIndex)
    }

    // MARK: - Seek latency (2026-10-07, plan Phase 4 item 3)

    /// The ONE open latency probe: opened by `seek(to:)`, closed by the leg
    /// that gets audio actually playing, dropped by supersession or expiry.
    /// The pure accounting lives in `SeekLatency`; this is only the adapter.
    private var seekProbe: SeekLatency.Probe? = nil
    private var seekLatencyLine: String? = nil
    private var seekLatencyReports = 0

    /// Monotonic clock for the legs — the same source
    /// `lastFirstScheduleAttemptAt` uses. A wall-clock jump must not author a
    /// negative or a fantastically long leg.
    private var nowUptime: TimeInterval { ProcessInfo.processInfo.systemUptime }

    /// Opens the probe for a new seek, reporting the abandoned one at debug
    /// level (a superseded probe is not an outcome; the completed lines are).
    private func beginSeekProbe(trackId: String, target: Double) {
        if let open = seekProbe {
            eventAdd(.debug, "stream", "seek latency abandoned (superseded): " + SeekLatency.line(open.report()))
        }
        seekProbe = SeekLatency.Probe(trackId: trackId, targetSeconds: target, requestedAt: nowUptime)
    }

    private func noteSeekStrategy(_ strategy: String) {
        seekProbe?.note(strategy: strategy)
    }

    /// Marks a leg on the OPEN probe, when the mark provably belongs to it (its
    /// own row, inside its lifetime). The fourth leg logs the ONE line and
    /// closes the probe, so a later play of the same row cannot be attributed
    /// to this seek. First mark wins: a retry must not inflate a leg.
    private func markSeekLeg(_ leg: SeekLatencyLeg) {
        guard var probe = seekProbe else { return }
        let now = nowUptime
        guard probe.accepts(trackId: currentTrackId, at: now) else {
            seekProbe = nil
            eventAdd(.debug, "stream", "seek latency abandoned (not attributable): " + SeekLatency.line(probe.report()))
            return
        }
        guard probe.mark(leg, at: now) else { return }
        guard probe.isComplete else {
            seekProbe = probe
            return
        }
        let line = SeekLatency.line(probe.report())
        seekProbe = nil
        seekLatencyReports += 1
        seekLatencyLine = line
        eventAdd(.info, "stream", line)
    }

    /// Epoch lifecycle report for the JS bridge trail (plan Phase 2): an
    /// epoch is a POSITIONING actor, so a future multi-skip dump must be able
    /// to blame it rather than `engage`/`refreshQueue`.
    public var onStreamEpoch: (([String: Any]) -> Void)?

    /// The kill-switch setter (persisted setting, pushed by the manager).
    /// Logged so a dump proves which mode was in effect.
    public func setSeekEpochsMode(_ mode: SeekEpochMode) {
        guard mode != seekEpochMode else { return }
        seekEpochMode = mode
        eventAdd(.info, "stream", "seekEpochs → \(mode.rawValue)")
        if mode == .off { discardSeekEpoch() }
    }

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
    /// The last EQ config pushed from JS, replayed after a rebuild (fresh
    /// AVAudioUnitEQ bands start flat). 2026-10-04.
    private var lastFilters: [NativeFilterConfig] = []
    private var lastFiltersBypassed = false
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
        // (2026-10-02e) The loader's transport-failure lines read the SAME
        // network-transition stamp the engine's do, so a churn-attributed cut
        // is attributed identically whichever layer reported it.
        loader.networkChangeStampProvider = { [weak self] in self?.lastNetworkChangeAt }
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

        // Watch for the engine's configuration changing underneath us (route /
        // format change, media-services churn). Registered per engine
        // INSTANCE — the object identity changes on rebuild, so setupGraph
        // (re-)registers it and the old one is removed first.
        if let existing = configurationChangeObserver {
            NotificationCenter.default.removeObserver(existing)
        }
        configurationChangeObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            self?.handleEngineConfigurationChanged()
        }
    }

    /// Starts the engine if needed, driving the bounded recovery ladder.
    /// Returns whether the engine IS RUNNING afterward. Callers MUST check the
    /// result before `player.play()` — playing into a stopped engine raises an
    /// NSException (SIGABRT; the 1.2.14 play crash). Deliberately NOT
    /// `@discardableResult` (the bare call in play() was the 1.2.14 crash
    /// shape): an ignored Bool result warns at compile time, so a future
    /// direct-play site can't silently skip the guard.
    ///
    /// 2026-10-04: the old version swallowed the session-activation error and
    /// re-attempted `engine.start()` on a dead session forever — once the
    /// AVAudioSession went inactive (interruption / media-services reset),
    /// every start failed with -50 until a full relaunch. Every failure now
    /// goes through `EngineRecoveryPolicy` (retry → one rebuild → surface),
    /// and a surfaced engine short-circuits so the app stops thrashing.
    private func ensureEngineRunning() -> Bool {
        guard !engine.isRunning else { return true }
        if engineUnavailable { return false }
        guard let failure = activateSessionAndStart() else {
            noteEngineStartSucceeded()
            return true
        }
        return handleEngineStartFailure(failure)
    }

    /// ONE attempt to activate the session and start the engine. Returns the
    /// failure kind, or nil on success. Logs the raw error identity (NSError
    /// domain + numeric code / OSStatus) — the old `localizedDescription`
    /// printed "The operation couldn't be completed", which told a field dump
    /// nothing and cost a full diagnosis round trip.
    private func activateSessionAndStart() -> EngineFailureKind? {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: SessionController.categoryOptions(for: audioMixingMode))
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            let ns = error as NSError
            eventAdd(.danger, "engine", "session activate failed \(errorEvidence(ns))")
            return EngineRecoveryPolicy.classifySessionError(ns)
        }
        installSpectrumTapIfNeeded()
        engine.prepare()
        do {
            try engine.start()
            return nil
        } catch {
            let ns = error as NSError
            eventAdd(.danger, "engine", "engine start failed \(errorEvidence(ns))")
            return .startFailed
        }
    }

    /// The greppable identity of an audio error: the raw NSError domain+code
    /// and, for OSStatus errors, the numeric status.
    private func errorEvidence(_ error: NSError) -> String {
        if error.domain == NSOSStatusErrorDomain {
            return "[domain=\(error.domain) code=\(error.code) osstatus=0x\(String(error.code, radix: 16))]"
        }
        return "[domain=\(error.domain) code=\(error.code)]"
    }

    /// Any successful start clears the ladder's run and the surfaced state.
    private func noteEngineStartSucceeded() {
        engineRecoveryTimer?.invalidate()
        engineRecoveryTimer = nil
        consecutiveEngineStartFailures = 0
        // A start that SUCCEEDED while the flag reads true is itself proof the
        // interruption is over (2026-10-08 stale-flag fix).
        clearStaleInterruptionFlag(reason: "engine start succeeded")
        if engineUnavailable {
            engineUnavailable = false
            eventAdd(.info, "engine", "engine recovered — clearing engineUnavailable")
            onEngineRecovered?()
        }
    }

    /// Feed one failure to the pure policy and enact its decision.
    private func handleEngineStartFailure(_ failure: EngineFailureKind) -> Bool {
        // The failing call is always a play/schedule site, so a play was
        // intended: remember to resume once recovery succeeds.
        resumeAfterEngineRecovery = true
        consecutiveEngineStartFailures += 1
        // Only `sessionNotActive` is consistent with a genuinely active
        // interruption; any other kind proves the session was activatable, so
        // a still-true flag is STALE and must not disarm the ladder
        // (2026-10-08). Clear it before deciding.
        if !EngineRecoveryPolicy.interruptionBlocksRecovery(
            failure: failure, interruptionActive: interruptionActive) {
            clearStaleInterruptionFlag(reason: "failure=\(failure.rawValue) proves the session was activatable")
        }
        let action = EngineRecoveryPolicy.decide(
            failure: failure,
            interruptionActive: interruptionActive,
            consecutiveFailures: consecutiveEngineStartFailures)
        eventAdd(
            .danger, "engine",
            "recovery: failure=\(failure.rawValue) attempt=\(consecutiveEngineStartFailures) interrupted=\(interruptionActive) → \(recoveryActionName(action))")
        switch action {
        case .retryLater(let delaySeconds):
            scheduleEngineRecovery(after: delaySeconds)
            return false
        case .rebuild:
            // A rebuild's own start attempt also increments the run; never let
            // it recurse into a second rebuild from inside itself.
            guard !isRebuildingAudioStack else { return false }
            rebuildAudioStack()
            return engine.isRunning
        case .surfaceUnavailable:
            surfaceEngineUnavailable()
            return false
        }
    }

    /// Schedule the ladder's next automatic attempt.
    private func scheduleEngineRecovery(after delaySeconds: TimeInterval) {
        guard !engineUnavailable else { return }
        engineRecoveryTimer?.invalidate()
        let timer = Timer(timeInterval: delaySeconds, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.engineRecoveryTimer = nil
            if self.ensureEngineRunning() {
                self.resumeCurrentAfterRecovery()
            }
        }
        engineRecoveryTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    /// Bounded recovery exhausted: stop thrashing and surface to JS.
    private func surfaceEngineUnavailable() {
        engineRecoveryTimer?.invalidate()
        engineRecoveryTimer = nil
        guard !engineUnavailable else { return }
        engineUnavailable = true
        eventAdd(
            .danger, "engine",
            "audio engine unavailable after \(consecutiveEngineStartFailures) consecutive start failures — surfacing for a user restart")
        onEngineUnavailable?()
    }

    private func recoveryActionName(_ action: EngineRecoveryAction) -> String {
        switch action {
        case .retryLater(let delaySeconds): return "retryLater(\(delaySeconds)s)"
        case .rebuild: return "rebuild"
        case .surfaceUnavailable: return "surfaceUnavailable"
        }
    }

    // MARK: - Session / interruption recovery

    /// The interruption flag can go STALE (2026-10-08 field dump: 9 `.began`
    /// edges, 0 `.ended`, while playback provably continued for ~1 h — iOS
    /// never delivered the end edge). A successful start, or a failure only a
    /// usable session can produce, is positive proof the interruption is over:
    /// clear the flag, leave a named trail, and tell the session controller so
    /// its own copy cannot diverge (a later genuine `.began` must still emit).
    private func clearStaleInterruptionFlag(reason: String) {
        guard interruptionActive else { return }
        interruptionActive = false
        staleInterruptionClears += 1
        eventAdd(.info, "engine", "interruption flag cleared as STALE — \(reason); no ended edge was delivered")
        onStaleInterruptionCleared?()
    }

    /// Mirrors the session controller's interruption state (main thread). On
    /// the falling edge the session may be usable again, so the ladder gets a
    /// fresh run and a surfaced engine is un-surfaced (the recovery timer, or
    /// the next play, retries).
    public func setInterruptionActive(_ active: Bool) {
        guard interruptionActive != active else { return }
        interruptionActive = active
        if active {
            interruptionBeginCount += 1
        } else {
            interruptionEndCount += 1
        }
        guard !active else { return }
        eventAdd(.info, "engine", "interruption ended — resetting recovery ladder")
        engineRecoveryTimer?.invalidate()
        engineRecoveryTimer = nil
        consecutiveEngineStartFailures = 0
        // The interruption released the session, so a surfaced engine gets a
        // fresh chance; tell JS so the restart banner clears while we retry
        // (if the retry fails, the ladder re-surfaces and it returns).
        if engineUnavailable {
            engineUnavailable = false
            onEngineRecovered?()
        }
        if !engine.isRunning {
            scheduleEngineRecovery(after: EngineRecoveryPolicy.firstRetryDelaySeconds)
        }
    }

    /// Explicit user-requested restart (bridge `restartAudioEngine`): clears
    /// the surfaced state and forces a full rebuild regardless of the ladder.
    public func restartAudioEngine() {
        eventAdd(.info, "engine", "explicit engine restart requested")
        consecutiveEngineStartFailures = 0
        // NOTE: `engineUnavailable` is deliberately left set here — a
        // successful rebuild clears it via noteEngineStartSucceeded (which
        // also notifies JS), so the banner only disappears on a REAL recovery.
        // A user-requested restart means "make it play again".
        resumeAfterEngineRecovery = true
        engineRecoveryTimer?.invalidate()
        engineRecoveryTimer = nil
        rebuildAudioStack()
    }

    /// After a successful non-rebuild recovery, restart the interrupted play.
    private func resumeCurrentAfterRecovery() {
        guard resumeAfterEngineRecovery else { return }
        resumeAfterEngineRecovery = false
        guard tracks.indices.contains(activeIndex) else { return }
        eventAdd(.info, "engine", "resuming current track after engine recovery")
        play()
    }

    /// The `.AVAudioEngineConfigurationChange` handler: the graph's config
    /// changed underneath us and the engine stopped. Hand it to the ladder.
    private func handleEngineConfigurationChanged() {
        guard !isRebuildingAudioStack else { return }
        guard !engine.isRunning else { return }
        eventAdd(.danger, "engine", "AVAudioEngineConfigurationChange with the engine stopped — attempting recovery")
        _ = ensureEngineRunning()
    }

    /// Tear the whole audio stack down and rebuild it (2026-10-04). Recreates
    /// the AVAudioEngine + every node, re-runs `setupGraph` (the attach/connect
    /// audit), reinstalls the spectrum tap, and preserves the current track,
    /// position and playing state.
    ///
    /// The start is attempted exactly ONCE here — the CALLER owns the recovery
    /// ladder, so a failed rebuild cannot recurse into itself.
    public func rebuildAudioStack() {
        guard !isRebuildingAudioStack else { return }
        isRebuildingAudioStack = true
        defer { isRebuildingAudioStack = false }

        // A failed play() never let `isPlaying` flip true, so the interrupted
        // intent is carried separately (resumeAfterEngineRecovery).
        let resumePlaying = isPlaying || resumeAfterEngineRecovery
        let resumeIndex = activeIndex
        let resumePosition = max(0, currentPosition)
        let hadTrack = tracks.indices.contains(resumeIndex)
        eventAdd(
            .danger, "engine",
            "rebuilding audio stack (wasPlaying=\(resumePlaying) position=\(String(format: "%.2f", resumePosition)))")

        // Stop every timer + node BEFORE dropping the engine so no closure
        // touches a torn-down graph. cancelScheduled() also bumps the schedule
        // generation, voiding this graph's pending completions.
        engineRecoveryTimer?.invalidate()
        engineRecoveryTimer = nil
        paramRestartTimer?.invalidate()
        paramRestartTimer = nil
        cancelScheduled()
        hasLiveSchedule = false
        cachedPosition = resumePosition
        positionBias = 0
        teardownStagedState()

        if let observer = configurationChangeObserver {
            NotificationCenter.default.removeObserver(observer)
            configurationChangeObserver = nil
        }
        engine.stop()
        // Detach only what is actually attached (`attachedNodes` is the
        // authoritative set) — and stop first, so no node is detached while it
        // is still rendering. `mainMixerNode` is engine-owned and not detached.
        let attached = engine.attachedNodes
        let nodes: [AVAudioNode] = [playerA, playerB, gainA, gainB, mixer, timePitch, varispeed, eq, preamp, spectrumTap]
        for node in nodes where attached.contains(node) {
            engine.detach(node)
        }

        // Fresh engine + nodes — never re-use a node from a dead engine.
        engine = AVAudioEngine()
        playerA = AVAudioPlayerNode()
        playerB = AVAudioPlayerNode()
        gainA = AVAudioMixerNode()
        gainB = AVAudioMixerNode()
        mixer = AVAudioMixerNode()
        timePitch = AVAudioUnitTimePitch()
        varispeed = AVAudioUnitVarispeed()
        eq = AVAudioUnitEQ(numberOfBands: 24)
        preamp = AVAudioMixerNode()
        spectrumTap = AVAudioMixerNode()
        // The tap lived on the old node; force a reinstall on the new one.
        spectrumTapInstalled = false
        spectrumTapBuffer = []
        spectrumHasNewFrame = false

        setupGraph()
        // The new units start neutral; restore the live session-level state.
        refreshPreamp()
        refreshPlaybackParams()
        refreshActiveGain()
        applyFilters(lastFilters, bypassed: lastFiltersBypassed)

        guard activateSessionAndStart() == nil else {
            eventAdd(.danger, "engine", "rebuild start failed — the ladder owns the next attempt")
            return
        }
        noteEngineStartSucceeded()
        eventAdd(.info, "engine", "audio stack rebuilt and started")

        if hadTrack {
            scheduleCurrentTrack(from: cachedPosition, autoPlay: resumePlaying)
        }
        resumeAfterEngineRecovery = false
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
        // Degrade honestly into the bounded recovery ladder (2026-10-04),
        // which retries/rebuilds and resumes the play itself — NOT via the JS
        // retry ladder, which would advance the queue into the same failure.
        guard ensureEngineRunning() else {
            // The recovery ladder owns this failure: it retries, rebuilds, and
            // resumes the play itself on success. Deliberately NO onError —
            // the JS retry ladder gives up after 2 tries and advances to the
            // next row, which is exactly the 2026-10-04 "playback stopped and
            // the following songs didn't work either" cascade. A definitively
            // failed engine reports through onEngineUnavailable instead.
            return
        }
        guard !tracks.isEmpty else { return }
        // An end-of-track sleep paused us right as the previous track finished;
        // its segment is gone, so resume by advancing like a natural next track.
        // This keeps the engine and the JS play state in lockstep (onTrackChanged
        // fires and the wrapper advances currentTrack/activeIndex).
        // Phase 1 (2026-10-07): the resume decision is the pure `PlayIntent`
        // core. ORDER IS THE FIX: a STAGED schedule sitting in the buffering
        // pause (its old chained schedule already consumed) is tested BEFORE
        // the no-schedule restart. A seek-induced stall clears
        // `hasLiveSchedule`, so the old `!hasLiveSchedule → loadAndStart`
        // order restarted the row at 0:00 — the reported bug. The stalled
        // position resumes by re-scheduling from it: the delivered estimate
        // has grown by now and scheduleCurrentTrack re-clamps to the fresh
        // end. This is ALSO the user's manual resume after pausing during a
        // stall (userPaused latched) — the auto-resume path never touched
        // audio.
        let action = PlayIntent.decide(PlayIntent.State(
            waitingAtTrackEnd: waitingAtTrackEnd,
            // A live EPOCH counts as a resumable position holder (Phase 2):
            // the row's position lives in the epoch until its first schedule
            // exists, so a play tap must never restart the row.
            stagedStallResumable: (stagedSchedule?.isStalled == true && stagedSourceURL != nil) || seekEpoch != nil,
            hasLiveSchedule: hasLiveSchedule,
            paramsDirty: paramsDirty))
        switch action {
        case .advanceAfterSleepPause:
            waitingAtTrackEnd = false
            advanceFromSleepPause()
            return
        case .resumeStagedStall:
            if var staged = stagedSchedule {
                staged.userPaused = false
                stagedSchedule = staged
                let resumeAt = cachedPosition
                eventAdd(.info, "stream", "play() resumes stalled staged schedule at \(String(format: "%.1f", resumeAt))s")
                cancelScheduled()
                scheduleCurrentTrack(from: resumeAt, autoPlay: true)
            } else if seekEpoch != nil {
                // The epoch has no schedule YET (its header has not landed):
                // the first epoch schedule carries this autoPlay, so a play
                // tap asks for audio and the position is already parked.
                stagedAutoPlay = true
                eventAdd(.info, "stream", "play() during epoch open — the first epoch schedule plays")
            }
            return
        case .restartTrack:
            // Nothing scheduled (fresh queue or finished queue): (re)start the
            // current track. `loadAndStart` itself guards a same-row restart
            // with live staged state.
            loadAndStart(currentIndex: activeIndex, autoPlay: true)
            return
        case .restartForParams:
            // A param change happened while paused — resume via a fresh
            // schedule so the new speed/pitch take effect on the plan.
            restartForParams()
            return
        case .plainResume:
            break
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
        // A seek made while PAUSED reaches its playback leg here (the user's
        // own resume) — inside the probe's lifetime it is still that seek.
        markSeekLeg(.firstPlayback)
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
        // Phase 1 (2026-10-07): the position is an INTENT. When the row has no
        // schedulable source yet, PARK it — the first schedule that can be
        // made starts here. The old shape fell into the normal path, found no
        // local file, and reported "Track not ready" → JS retry → the reload
        // restarted the row at 0 (fact 6 of the seek-intent plan).
        pendingSeekSeconds = nil
        pendingSeekTrackId = nil
        // Phase 4 (2026-10-07): the latency probe opens BEFORE the schedule
        // attempt — a seek served straight from a local file reaches its
        // schedule and playback legs INSIDE this call, and they must land on
        // this seek's probe rather than on nothing.
        beginSeekProbe(trackId: track.trackId, target: target)
        let handled = scheduleCurrentTrack(from: target, autoPlay: isPlaying)
        if !handled {
            pendingSeekSeconds = target
            pendingSeekTrackId = track.trackId
            eventAdd(.info, "stream", "seek parked at \(String(format: "%.1f", target))s id=\(track.trackId) — no source yet, the first schedule honors it")
        }
        // Phase 2 (2026-10-07): a FAR forward seek — one the current source
        // cannot deliver (`!handled`), or one that parked the staged schedule
        // in the BUFFERING stall (the target is past the delivered end) —
        // opens a server-offset EPOCH when the server will re-encode from an
        // offset. The wait then tracks the lead instead of the whole prefix.
        // Every guard (kill switch, capability, URL shape, trivial-scrub
        // floor) lives in the helper; a refusal costs only the Phase-1 wait.
        let epochWanted = !handled || stagedSchedule?.isStalled == true
        var strategy = handled ? "local" : "parked"
        if stagedSchedule?.isStalled == true { strategy = handled ? "staged-stall" : "parked-stalled" }
        if epochWanted {
            if openSeekEpochIfWorthwhile(track: track, target: target, autoPlay: isPlaying) {
                strategy += "+epoch"
            }
        }
        // The decision leg CLOSES the probe's opening: from here the seek's
        // fate is in the transfer/schedule pipeline (firstByte → firstSchedule
        // → firstPlayback), and a park that never resolves still leaves a
        // partial line for the dump.
        noteSeekStrategy(strategy)
        markSeekLeg(.decision)
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
        /// (2026-10-02f) The churn-vs-stable-path attribution captured when
        /// the failure was classified. Drives the retry STRATEGY
        /// (`TransferCutRetryPolicy`): `churnUnlikely` retries quickly on a
        /// fresh connection (the suspect pool must not be reused), while
        /// `churnSuspected` keeps the ladder's standard resume timing. Nil
        /// (a non-transport failure, or a record built from a bare string)
        /// leaves the ladder's behavior unchanged.
        var cut: CutAttribution? = nil
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
        let maxAttempts = isApplicationBackground ? Self.activeLoadMaxConsecutiveRetries : 2
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
        // STRATEGY BRANCH (2026-10-02f): a cut attributed to a stable local
        // path (`churnUnlikely`) is the reverse-proxy keep-alive shape — the
        // retry must not inherit the suspect pooled connection, and there is
        // no path to wait for, so it goes promptly. A `churnSuspected` cut
        // keeps the ladder's standard spacing and its resume substrate (the
        // path was the variable and the delivered bytes are on disk).
        // `standard`/nil preserves the previous behavior exactly.
        let retryStrategy = TransferCutRetryPolicy.strategy(for: failure.cut)
        let retryDelay = TransferCutRetryPolicy.delaySeconds(
            for: failure.cut, standardDelaySeconds: Self.activeLoadRetryDelaySeconds)
        // Observed, not assumed (2026-10-02g): the HUD's retry counters are fed
        // here, at the decision, so a dump can show the branch firing.
        retryBranchStats.record(strategy: retryStrategy)
        activeLoadRetryTimer = Timer(timeInterval: retryDelay, repeats: false) { [weak self] _ in
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
        eventAdd(.info, "loader", "active-load retry scheduled (\(attempt)/\(Self.activeLoadMaxConsecutiveRetries)) for \(track.trackId) in \(String(format: "%.1f", retryDelay)) s (strategy \(retryStrategy.rawValue)): \(failure.detail)")
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
        // FRESH CONNECTION (2026-10-02f): a `churnUnlikely` cut points at the
        // pooled keep-alive socket, so the retry asks the loader to issue its
        // request on a session whose pool cannot inherit it. The decision is
        // the SAME pure predicate that chose the delay; the loader enacts it.
        let wantsFreshConnection = TransferCutRetryPolicy.requiresFreshConnection(for: failure.cut)
        if wantsFreshConnection { loader.requestFreshConnectionForNextAttempt() }
        eventAdd(.info, "loader", "active-load retry attempt \(attempt) for \(track.trackId) (failed as \(failure.kind == .stream ? "stream" : "download")\(wantsFreshConnection ? ", fresh connection" : ""))")
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
                    self.eventAdd(.info, "loader", "active-load retry \(attempt) failed for \(track.trackId): \(error?.localizedDescription ?? "?") — rescheduling \(error.map { self.transferEvidence($0) } ?? "")")
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
                    let failure = self.activeLoadFailure(kind: .stream, error: error)
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

    /// True only while the app is BACKGROUNDED. `.inactive` is deliberately
    /// NOT background — the webview still runs there, so the JS ladder still
    /// owns the yield. A missing `UIApplication` (the macOS host in
    /// `swift test`) reads as foreground. One definition so the retry-cap
    /// check and the ownership decision can never disagree about "background".
    private var isApplicationBackground: Bool {
        guard NSClassFromString("UIApplication") != nil else { return false }
        return UIApplication.shared.applicationState == .background
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
        guard !isApplicationBackground else { return }
        onError?("Stream failed before start: \(failure.detail)")
    }

    /// SINGLE-OWNER YIELD (2026-10-03, the double-reload fix): one yielded
    /// active-load failure is recovered by exactly ONE retry machine. The
    /// choice is the pure `ActiveLoadRetryOwnership`; this method is only the
    /// adapter that enacts it. Foreground → report to the JS ladder and do NOT
    /// arm the native retry; background → arm the native retry and do NOT
    /// report (the JS machine is suspended). Every yield site routes through
    /// here — that is what keeps the sites from drifting.
    private func handleYieldedActiveLoadFailure(track: NativeTrack, failure: ActiveLoadFailure) {
        let owner = ActiveLoadRetryOwnership.owner(isBackground: isApplicationBackground)
        // Observed, not assumed: a dump can tell WHICH machine took the yield,
        // so the single-owner rule is verifiable from the field log alone.
        eventAdd(.info, "loader", "active-load yield for \(track.trackId) → \(owner.rawValue) owner (background=\(isApplicationBackground)): \(failure.detail)")
        switch owner {
        case .jsLadder:
            reportActiveLoadFailure(track: track, failure: failure)
        case .nativeRetry:
            scheduleActiveLoadRetry(track: track, failure: failure)
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
        // Remember the last pushed config: a rebuild creates fresh
        // AVAudioUnitEQ bands, and without replaying this the user's EQ would
        // silently reset to flat (2026-10-04).
        lastFilters = filters
        lastFiltersBypassed = bypassed
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
            // Recovery (2026-10-04): the ladder's live state, so a dump shows
            // whether an engine failure is being handled or has given up.
            "interruptionActive": interruptionActive,
            // Interruption BEGIN/END edges + stale clears (2026-10-08): the
            // next dump reads `9 begins / 0 ends` at a glance instead of
            // mining the ring for the shape that left the flag stale.
            "interruptionBegins": interruptionBeginCount,
            "interruptionEnds": interruptionEndCount,
            "staleInterruptionClears": staleInterruptionClears,
            "consecutiveEngineStartFailures": consecutiveEngineStartFailures,
            "engineUnavailable": engineUnavailable,
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
            // (2026-10-02g) The retry ladder's BRANCH counters: decisions taken
            // at schedule time plus the pools the loader actually rotated.
            // The two numbers differ by design (an opaque-resume retry keeps
            // the shared session), and both are needed to prove the new path
            // fires at all rather than only inferring it from timings.
            "retryBranch": retryBranchStats.snapshot(
                enactedFreshConnection: loader.freshConnectionAttempts),
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
            // Phase 2 (2026-10-07): the epoch's every decision input. The
            // self-test's `epoch` check reads exactly these, so an epoch that
            // opened without a verdict (the one shape the design forbids) is
            // FAIL-visible from a field dump.
            "seekEpochs": seekEpochMode.rawValue,
            // Transfer ladder (2026-10-07): the prefetch hold's state — a dump
            // must show whether speculative bytes yielded to the user's own
            // transfer, and how many distinct holds happened.
            "prefetchLadderHeld": prefetchHoldReason?.rawValue ?? "none",
            "prefetchLadderHolds": prefetchHoldCount,
            "userTransferActive": TransferLadder.ownsBandwidth(currentUserTransfer()),
            "streamEpochActive": seekEpoch != nil,
            "streamEpochBase": seekEpoch?.baseSeconds ?? 0,
            "streamEpochTarget": seekEpoch?.targetSeconds ?? 0,
            "streamEpochVerdict": seekEpoch?.verdict?.rawValue ?? "",
            "streamEpochCount": seekEpochCounter,
            // Phase 4 (2026-10-07): the last COMPLETE seek-latency line plus
            // how many were reported — the number the seek work is judged by.
            "seekLatency": seekLatencyLine ?? "",
            "seekLatencyReports": seekLatencyReports,
            "streamTimelineBaseSeconds": stagedSchedule.map { Double($0.timelineBaseFrames) / max(1, $0.sampleRate) } ?? 0,
            // The snapshot duration in frames — the container-shape classifier's
            // second anchor (2026-10-02 self-test): the JS side cannot derive
            // frames from a duration without the file's sample rate.
            "streamMetadataFrames": stagedSchedule?.metadataFrames ?? 0,
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
        // Phase 1 same-row restart guard (2026-10-07): a row whose staged
        // state is STILL live must not be torn down and restarted at 0 — that
        // is the last leg of the reported "play after a seek resets to 0:00"
        // chain. `play()` can no longer reach here for a stalled row (the
        // PlayIntent ordering), so this guards every other caller: re-schedule
        // in place from the held position instead of wiping it. A deliberate
        // same-row restart goes through `stopPlayback`, which tears the staged
        // state down first — the guard is inactive there by construction.
        if index == activeIndex, let staged = stagedSchedule, staged.trackId == track.trackId, stagedSourceURL != nil {
            let resumeAt = cachedPosition
            eventAdd(.info, "stream", "restart suppressed position=\(String(format: "%.1f", resumeAt))s row=\(index) — live staged state, re-scheduling in place")
            scheduleCurrentTrack(from: resumeAt, autoPlay: autoPlay)
            return
        }
        // A load for a DIFFERENT row abandons this row's parked seek intent;
        // a same-row restart keeps it (the position must survive a play tap on
        // a row whose source is still missing).
        if pendingSeekTrackId != nil, pendingSeekTrackId != track.trackId {
            pendingSeekSeconds = nil
            pendingSeekTrackId = nil
        }
        // Phase 2: a load for a DIFFERENT row abandons an open epoch (its
        // transfer is superseded and its file discarded); a same-row restart
        // keeps a live epoch (the position it holds is this row's).
        if let epoch = seekEpoch, epoch.trackId != track.trackId { discardSeekEpoch() }
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
                // ACTIVE-LOAD YIELD (dump-2): one owner per environment —
                // the SAME single-owner yield as the stream path.
                // (2026-10-02f) Carry the cut attribution when we have an
                // error; the string-only fallback keeps its previous shape.
                let failure = error.map { self.activeLoadFailure(kind: .download, error: $0) }
                    ?? ActiveLoadFailure(kind: .download, detail: "Failed to load track")
                self.handleYieldedActiveLoadFailure(track: track, failure: failure)
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
            // Phase 1 (2026-10-07): honor a position parked while this download
            // was in flight (or before it started) — the row's first real
            // schedule must start at the intent, never at 0.
            let parked = self.pendingSeekTrackId == track.trackId ? self.pendingSeekSeconds : nil
            self.pendingSeekSeconds = nil
            self.pendingSeekTrackId = nil
            self.scheduleCurrentTrack(
                from: PlayIntent.firstScheduleStartSeconds(pendingSeekSeconds: parked),
                autoPlay: autoPlay)
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
    /// "tracks are preloaded in parallel instead of sequentially"). Crossfade
    /// keeps reserving the immediate successor even at preloadCount 0. Each
    /// completion re-checks the crossfade monitor so a target that becomes
    /// ready inside the fade window does not wait for the next 100 ms tick.
    /// A chain is generation-guarded: a queue replacement (setQueue/refresh)
    /// bumps `prefetchGeneration` and the surviving completions drop the rest.
    ///
    /// PARK-AND-DRAIN (2026-10-02 Phase 3, the plan in
    /// docs/plans/2026-10-02-network-churn-and-prefetch-resilience.md): a row
    /// failure no longer sleeps INSIDE the serial walk — the old shape held
    /// every row behind a poisoning row for ~4.5 s (3 attempts × 1.5 s) before
    /// moving on. Now the failed row is PARKED and the walk advances
    /// IMMEDIATELY; once the walk is exhausted the parked rows drain oldest-
    /// first with the backoff, rotating a still-failing row so the others get
    /// a turn, up to `prefetchMaxAttempts`. One download is in flight at a
    /// time throughout (the bandwidth discipline is unchanged). Every decision
    /// is the pure `PrefetchChain` planner; this method is the thin
    /// interpreter. Generation-guarded throughout: a queue/track change kills
    /// pending backoffs with the rest of the chain.
    private static let prefetchMaxAttempts = 3
    /// The ladder's STANDARD retry spacing. `TransferCutRetryPolicy` shortens
    /// it for a `churnUnlikely` (fresh-connection) retry — there is no path to
    /// wait for, the suspect keep-alive socket is simply replaced.
    private static let prefetchRetryBackoffSeconds: TimeInterval = 1.5

    private func prefetchUpcoming(
        from index: Int,
        total: Int? = nil,
        state: PrefetchChain.State? = nil,
        generation: Int? = nil
    ) {
        // THE HOLD (2026-10-07): speculative bytes never start while a
        // user-initiated transfer owns the link — a staged stream, a seek
        // epoch (from the moment its request is on the wire), or the active
        // row's own download. EVERY such transfer has a terminal edge that
        // re-arms (`rearmPrefetchIfIdle`): a completion, an error, an epoch
        // discard, or a row change — so a hold cannot strand the walk; the
        // reason is logged on the transition only (this method is entered from
        // queue edges and its own recursion, not a tick).
        let userTransfer = currentUserTransfer()
        if !TransferLadder.mayIssueNextPrefetch(userTransfer) {
            let reason = TransferLadder.hold(userTransfer)
            if prefetchHoldReason != reason {
                prefetchHoldReason = reason
                prefetchHoldCount += 1
                eventAdd(.info, "preload", "transfer ladder: prefetch walk held (\(reason.rawValue)) — user transfer owns the link")
            }
            return
        }
        if let held = prefetchHoldReason {
            prefetchHoldReason = nil
            eventAdd(.info, "preload", "transfer ladder: prefetch walk resumed (was held: \(held.rawValue))")
        }
        let totalCount = total ?? (crossfadeDuration > 0 ? max(1, preloadCount) : preloadCount)
        guard totalCount > 0 else { return }
        let gen = generation ?? prefetchGeneration
        let current = state ?? PrefetchChain.State()
        let action = PrefetchChain.nextAction(
            state: current,
            totalCount: totalCount,
            maxAttempts: Self.prefetchMaxAttempts,
            walkCandidate: nextIndex(after: index)
        )
        switch action {
        case .finished:
            return

        case .download(let row):
            guard tracks.indices.contains(row) else { return }
            let track = tracks[row]
            let snapshot = current // Sendable capture: no mutating var in the closure.
            eventAdd(.debug, "preload", "chain: prefetch row \(row) (\(track.trackId))")
            loader.prefetch(track) { [weak self] _, error in
                guard let self, gen == self.prefetchGeneration else { return }
                // A failed prefetch must not sit "fetching" forever
                // (frozen-tint report): gone clears the row's tint now.
                let cut: CutAttribution?
                if let error {
                    self.emitPreload(track.trackId, "gone", nil)
                    // RETRY-BRANCH ACCOUNTING (2026-10-04, workstream B): the
                    // prefetch path used to log and park WITHOUT the ladder's
                    // classification, so `TransferCutRetryPolicy`'s
                    // `freshConnectionSoon` branch was structurally
                    // unreachable here — ~30 field failures parked on the
                    // first -1017 and `retryBranch` stayed all zeros.
                    // Classify once and COUNT the decision, exactly as
                    // `scheduleActiveLoadRetry` does; the cut is parked with
                    // the row so the drain retries it through the same branch.
                    cut = self.transferFailure(error).cut
                    self.retryBranchStats.record(strategy: TransferCutRetryPolicy.strategy(for: cut))
                    if Self.prefetchMaxAttempts > 1 {
                        self.eventAdd(.info, "preload", "prefetch FAILED row \(row) (\(track.trackId)) attempt 1/\(Self.prefetchMaxAttempts): \(error.localizedDescription) — parked \(self.transferEvidence(error))")
                    } else {
                        self.eventAdd(.info, "preload", "prefetch FAILED row \(row) (\(track.trackId)): \(error.localizedDescription) — moving on \(self.transferEvidence(error))")
                    }
                } else {
                    cut = nil
                    self.crossfadeMonitorTick()
                }
                let next = PrefetchChain.applyDownload(
                    state: snapshot,
                    index: row,
                    success: error == nil,
                    maxAttempts: Self.prefetchMaxAttempts,
                    cut: cut)
                self.prefetchUpcoming(from: row, total: totalCount, state: next, generation: gen)
            }

        case .retry(let row, let attempt):
            let snapshot = current // Sendable capture: no mutating var in the Task.
            // The drain runs only once the walk is exhausted, so `from: index`
            // (the walk's last position) is re-passed unchanged: the walk
            // cannot re-open mid-drain (seen is monotonic; the candidate is
            // nil or already seen).
            //
            // RETRY BRANCH (2026-10-04, workstream B): the row's parked cut
            // attribution selects the retry's SHAPE through the SAME pure
            // policy the active-load path uses. A `churnUnlikely` cut retries
            // promptly on a pool that cannot inherit the suspect keep-alive
            // socket; every other cut keeps the ladder's standard spacing and
            // its resume substrate. Decided-vs-enacted: the DECISION was
            // counted at the failure; the fresh pool is counted by the LOADER
            // only when a rotation actually happens.
            let parkedCut = snapshot.parked.first(where: { $0.index == row })?.cut
            let retryDelaySeconds = TransferCutRetryPolicy.delaySeconds(
                for: parkedCut, standardDelaySeconds: Self.prefetchRetryBackoffSeconds)
            let wantsFreshConnection = TransferCutRetryPolicy.requiresFreshConnection(for: parkedCut)
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(retryDelaySeconds * 1_000_000_000))
                guard let self, gen == self.prefetchGeneration else { return }
                guard self.tracks.indices.contains(row) else {
                    // The queue shrank under the parked row: drop it and continue.
                    let skipped = PrefetchChain.applyRetry(
                        state: snapshot, index: row, attempt: attempt,
                        success: true, maxAttempts: Self.prefetchMaxAttempts)
                    self.prefetchUpcoming(from: index, total: totalCount, state: skipped, generation: gen)
                    return
                }
                let track = self.tracks[row]
                if wantsFreshConnection {
                    self.loader.requestFreshConnectionForNextAttempt()
                    self.eventAdd(.info, "preload", "prefetch retry row \(row) (\(track.trackId)) attempt \(attempt)/\(Self.prefetchMaxAttempts) on a fresh connection (\(TransferCutRetryPolicy.strategy(for: parkedCut).rawValue))")
                }
                self.loader.prefetch(track) { [weak self] _, error in
                    guard let self, gen == self.prefetchGeneration else { return }
                    let cut: CutAttribution?
                    if let error {
                        self.emitPreload(track.trackId, "gone", nil)
                        cut = self.transferFailure(error).cut
                        self.retryBranchStats.record(strategy: TransferCutRetryPolicy.strategy(for: cut))
                        if attempt >= Self.prefetchMaxAttempts {
                            self.eventAdd(.danger, "preload", "prefetch FAILED row \(row) (\(track.trackId)) after \(attempt) attempts: \(error.localizedDescription) — giving up \(self.transferEvidence(error))")
                        } else {
                            self.eventAdd(.info, "preload", "prefetch RETRY FAILED row \(row) (\(track.trackId)) attempt \(attempt)/\(Self.prefetchMaxAttempts): \(error.localizedDescription) — reparked \(self.transferEvidence(error))")
                        }
                    } else {
                        cut = nil
                        self.crossfadeMonitorTick()
                    }
                    let next = PrefetchChain.applyRetry(
                        state: snapshot,
                        index: row,
                        attempt: attempt,
                        success: error == nil,
                        maxAttempts: Self.prefetchMaxAttempts,
                        cut: cut)
                    self.prefetchUpcoming(from: index, total: totalCount, state: next, generation: gen)
                }
            }
        }
    }

    /// Phase 4 (2026-10-02, the network-churn plan): a network PATH CHANGE
    /// re-arms the prefetch chain after the plugin's trailing debounce.
    /// Deliberately classification-free — the engine retries because the
    /// network changed, not because of a metered/cheap judgement, so no LDM
    /// semantics are mirrored into Swift and it works backgrounded (no JS
    /// round trip). No generation bump: in-flight rows chain onto their
    /// existing task and cached rows are no-ops, so this is cheap and
    /// idempotent. SKIPPED while a staged stream owns the bandwidth — the
    /// writer arms its own chain at completion (mirrors the `loadAndStart`
    /// staged note).
    ///
    /// SUPERSEDES an in-flight chain: the generation is bumped so any older
    /// walk's continuations drop and exactly ONE chain runs. The bump does NOT
    /// cancel the loader's in-flight downloads (the generation guard only drops
    /// chain bookkeeping) — the fresh walk re-requests the same rows and chains
    /// onto their existing tasks. Without the bump a re-arm during an active
    /// walk would run a SECOND concurrent chain, double-walking the window and
    /// amplifying event/tick churn (review finding, 2026-10-02).
    public func rearmPrefetchAfterNetworkChange() {
        // The SAME hold predicate the walk's own entry uses (2026-10-07): an
        // epoch in flight is held EXPLICITLY here, not through
        // `hasActiveWriter` incidentally counting epoch writers. The arm is
        // the shared one, so this site inherits the generation bump (a fresh
        // walk SUPERSEDES an older chain — never runs beside it).
        rearmPrefetchIfIdle(reason: "network re-arm")
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
    /// Returns `true` when the attempt was HANDLED — either a schedule now
    /// exists or the position was parked in the staged stall state — and
    /// `false` when the row has NO schedulable source (nothing in flight, or
    /// still loading): Phase 1 (2026-10-07) makes that an INTENT to park, and
    /// `seek(to:)` stores it as `pendingSeekSeconds` for the load's own
    /// completion to apply.
    @discardableResult
    private func scheduleCurrentTrack(from seconds: Double, autoPlay: Bool) -> Bool {
        // Never-judged until this schedule proves its own length: an early
        // return (not-ready, corrupt, zero-frame) must not leave the previous
        // track's segment length behind for the gate to misread.
        scheduledSegmentSeconds = 0
        guard tracks.indices.contains(activeIndex) else { return false }
        let track = tracks[activeIndex]

        // ---- Staged path: the growing .part is the source ----------------
        if stagedSchedule != nil, let stagedURL = stagedSourceURL {
            guard var staged = stagedSchedule else { return false }
            guard let file = try? AVAudioFile(forReading: stagedURL) else {
                // The .part vanished or became unreadable mid-stream: treat
                // like a stream failure (the scratch may still exist for a
                // Range-continue; the JS retry re-engages).
                teardownStagedState()
                onError?("Stream source unreadable: \(track.title)")
                return false
            }
            let sr = file.processingFormat.sampleRate
            staged.headerClaimedFrames = file.length
            staged.sampleRate = sr
            // THE COORDINATE CLAUSE (plan §2.2, 2026-10-07): an epoch
            // transfer's frame 0 is ABSOLUTE `timelineBaseFrames`, so the
            // frame arguments handed to AVAudioFile/scheduleSegment are
            // EPOCH-LOCAL while every stored or compared end stays ABSOLUTE.
            let baseFrames = staged.timelineBaseFrames
            let startFrame = Int64(max(0, seconds - Double(baseFrames) / max(1, sr)) * sr)
            // COMPLETE → the header claim is FILE TRUTH (gates passed):
            // schedule to the real end. Staged → the delivered-end estimate.
            // CONTAINER-SHAPE-HONEST ESTIMATE (2026-10-02): a transcode's
            // Ogg/Opus partial already reports only the DELIVERED duration, so
            // the legacy header-claim × ratio double-discounts. The
            // metadata-duration ratio capped by the container's own end is
            // correct under both shapes and never over-promises. The byte
            // denominator is epoch-relative (plan fact 21).
            let localEndable = staged.isComplete
                ? file.length
                : StreamSchedule.stagedEndFramesEstimate(
                    containerFrames: file.length,
                    metadataFrames: staged.metadataFrames,
                    deliveredBytes: staged.deliveredBytes,
                    announcedBytes: epochRelativeAnnouncedBytes(
                        baseFrames: baseFrames,
                        metadataFrames: staged.metadataFrames,
                        announcedBytes: staged.announcedBytes,
                        sampleRate: sr))
            guard StreamSchedule.canSchedule(startFrame: startFrame, endFrames: localEndable) else {
                // Seek (or stall resume) at/past the delivered end: the
                // buffering pause, not an error. autoPlay=false so the stall
                // resume (or the user's own play tap) restarts audio.
                // Both numbers are ABSOLUTE (this source's reach on the row's
                // timeline), so an epoch's message compares like for like.
                eventAdd(.info, "stream", "schedule target past delivered end id=\(track.trackId) (seek \(String(format: "%.1f", seconds))s vs endable \(String(format: "%.1f", Double(baseFrames + localEndable) / sr))s) — buffering")
                staged.userPaused = !autoPlay
                staged.isStalled = true
                staged.stalledAtFrames = baseFrames + min(startFrame, localEndable)
                staged.lastProgressAt = Date()
                stagedSchedule = staged
                cachedPosition = seconds
                positionBias = seconds
                setPlaying(false)
                stopCrossfadeMonitor()
                // HANDLED: the stall state itself holds the position —
                // `play()` resumes from `cachedPosition` (PlayIntent).
                return true
            }
            scheduleGeneration += 1
            let generation = scheduleGeneration
            // The promise is stored ABSOLUTE; the segment length is a LOCAL
            // delta (identical under both spaces) and the frame arguments
            // stay local.
            let endFrames = baseFrames + localEndable
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
            player.scheduleSegment(file, startingFrame: startFrame, frameCount: AVAudioFrameCount(localEndable - startFrame), at: nil, completionCallbackType: .dataConsumed) { [weak self] _ in
                self?.handleSegmentCompletion(index: scheduledIndex, generation: generation, trackId: scheduledTrackId, node: scheduledNode, isStagedSegment: true)
            }
            hasLiveSchedule = true
            markSeekLeg(.firstSchedule)
            positionBias = seconds
            cachedPosition = seconds
            crossfade = .idle
            if autoPlay {
                guard ensureEngineRunning() else {
                    // Recovery ladder owns it (see play()); no onError. The
                    // SCHEDULE exists, so there is nothing to park.
                    return true
                }
                player.play()
                setPlaying(true)
                markSeekLeg(.firstPlayback)
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
            return true
        }
        // ---- Normal path: the completed cache file is the source ---------
        guard let localURL = loader.localURL(for: track) else {
            // Phase 1 (2026-10-07): no source is an INTENT to park, not an
            // error, while the row's load is demonstrably in flight — the load
            // completion re-schedules with `pendingSeekSeconds` applied. Only
            // when NOTHING is loading is this the old "Track not ready"
            // report (JS retry ladder owns the recovery).
            if loadInFlight(for: track) {
                eventAdd(.info, "stream", "source not ready for \(track.trackId) — parking position \(String(format: "%.1f", seconds))s until the load schedules")
                return false
            }
            onError?("Track not ready: \(track.title)")
            return false
        }
        guard let file = try? AVAudioFile(forReading: localURL) else {
            // Corrupt or partial download. Evict it so the JS retry loop
            // re-fetches instead of replaying a poisoned file forever.
            // Variant-scoped: the good variants of this track survive.
            loader.evict(track.trackId, variant: TrackVariant(url: track.url))
            onError?("Unsupported audio file: \(track.title)")
            return false
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
                return false
            } else {
                // Seek/metadata landed past the real end of a DECODABLE file
                // (duration metadata longer than the audio). End THIS track
                // like a natural completion — not the queue.
                eventAdd(.info, "engine", "past-end schedule for \(track.trackId) (frames=\(totalFrames), seek=\(seconds)) — ending just this track")
                handleSegmentCompletion(index: activeIndex, generation: scheduleGeneration, trackId: track.trackId)
                return true
            }
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
        markSeekLeg(.firstSchedule)
        positionBias = seconds
        cachedPosition = seconds
        crossfade = .idle

        if autoPlay {
            // Never play() into a stopped engine — that raises (1.2.14 play
            // crash). Degrade into the engine's own recovery ladder instead.
            guard ensureEngineRunning() else {
                // Recovery ladder owns it (see play()); no onError. The
                // schedule exists, so there is nothing to park.
                return true
            }
            player.play()
            setPlaying(true)
            markSeekLeg(.firstPlayback)
            setupCrossfadeMonitor()
        } else {
            setPlaying(false)
            stopCrossfadeMonitor()
        }
        return true
    }

    /// Phase 1 (2026-10-07): is a load for THIS row demonstrably in flight?
    /// A schedule attempt that finds no local file while true must PARK the
    /// position (the load's completion re-schedules) rather than report a
    /// track error. The staged writer is single-row by construction
    /// (`startStagedLoad` runs for the active row only).
    private func loadInFlight(for track: NativeTrack) -> Bool {
        loader.hasActiveWriter || loader.inFlightProgress.contains { $0.trackId == track.trackId }
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
        /// The snapshot duration in frames (0 = unknown): the second anchor of
        /// the container-shape-honest staged estimate (2026-10-02). Recorded at
        /// the first schedule; the metadata duration does not change mid-load.
        /// EPOCH-RELATIVE for an epoch transfer (track duration − base), so
        /// both anchors of the estimate describe the SAME window.
        var metadataFrames: Int64 = 0
        var scheduledEndFrames: Int64    // the current chained schedule's end (ABSOLUTE)
        /// Phase 2 (2026-10-07): the ABSOLUTE frame of this source's frame 0.
        /// 0 for an ordinary head-first transfer; the epoch's offset in frames
        /// for an epoch file (and 0 again after an offset-ignored rebase).
        /// Every frame this struct stores is ABSOLUTE (`scheduledEndFrames`,
        /// `stalledAtFrames`, `timelineBaseFrames`) while the container's own
        /// numbers (`headerClaimedFrames`, `metadataFrames`) are LOCAL — the
        /// two meet only in `stagedSchedulableEndFrames` and the scheduler's
        /// coordinate clause. Do NOT add the base twice.
        var timelineBaseFrames: Int64 = 0
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
    /// Workstream C (2026-10-04): the latest delivery while the FIRST staged
    /// schedule is still pending, cached so the open can be re-attempted on
    /// byte ARRIVALS (already main-hopped) instead of only on the next
    /// rung-gated delivery — see `StreamSchedule.firstScheduleRetryDue`.
    private var lastFirstScheduleProgress: TrackFileLoader.StreamProgress? = nil
    /// Monotonic stamp of the last first-schedule OPEN attempt (the retry
    /// throttle). Cleared with the rest of the staged state.
    private var lastFirstScheduleAttemptAt: Double? = nil
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
                // ONE owner per environment (dump-2: backgrounded, the JS
                // machine is suspended and the row sat in dead air for 33
                // minutes — the native retry covers that; foreground the JS
                // ladder is the fast path). Arming BOTH was the double-reload
                // defect: the loser fired after the winner's reload and
                // re-engaged the track from 0:00 a second time.
                let failure = self.activeLoadFailure(kind: .stream, error: error)
                if self.stagedSchedule != nil {
                    self.teardownStagedState()
                }
                self.handleYieldedActiveLoadFailure(track: track, failure: failure)
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

    // MARK: - Seek epochs (Phase 2, 2026-10-07)

    /// Opens a server-offset EPOCH for a far seek when it is worth one; false
    /// leaves the Phase-1 wait in place. Every guard is a pure decision (plan
    /// §2.4–§2.6) and every side effect is either the loader's transfer or the
    /// engine's own epoch state.
    ///
    /// SUPERSESSION ORDER (plan §2.8): the row's own writer is cancelled FIRST
    /// through the loader's deliberate-cancel helper (flag → silence the legs
    /// → task.cancel → the delegate's completion records the retained
    /// prefix), then the staged state is torn down — the epoch becomes the
    /// only transfer while the retained prefix still backs a later
    /// Range-continue.
    @discardableResult
    private func openSeekEpochIfWorthwhile(track: NativeTrack, target: Double, autoPlay: Bool) -> Bool {
        // THE KILL SWITCH (plan §8): `off` reproduces Phase-1 behavior
        // exactly — position-preserving wait, no epoch, no extra request.
        guard seekEpochMode == .auto else { return false }
        // JS declares, native executes (plan §2.5): the capability rides the
        // snapshot, derived from the SAME transcode decision that built the
        // URL. A wrong "can" costs one request that the verdict demotes.
        guard track.seekCapability?.canServerOffset == true else { return false }
        // URL shape: the offset parameter is only honored on the transcode
        // lane (plan facts 19/20). The runtime verdict owns everything finer.
        guard StreamEpoch.supportsServerOffset(track.url) else { return false }
        // Below the floor a seek just waits (a trivial scrub is cheaper than a
        // fresh server job) — the pure rule.
        guard let base = StreamEpoch.offsetSeconds(target) else { return false }
        // A held drag re-seeks to the same second every ~150 ms: reuse the
        // epoch instead of restarting its transfer.
        if let epoch = seekEpoch, epoch.trackId == track.trackId, epoch.baseSeconds == base {
            return true
        }
        if seekEpoch != nil { discardSeekEpoch() }
        guard let transfer = loader.epochTransfer(for: track, offsetSeconds: base) else { return false }
        if loader.activeWriterIsEpoch { loader.cancelActiveWriterRetainingScratch() }
        teardownStagedState()
        seekEpoch = SeekEpochState(
            trackId: track.trackId,
            baseSeconds: base,
            targetSeconds: target,
            transfer: transfer)
        // The epoch's first schedule carries this autoPlay (a scrub while
        // playing keeps playing; a scrub while paused holds the position).
        stagedAutoPlay = autoPlay
        // The intent is parked too: if the epoch's first open is deferred
        // (header not landed yet) the position survives in the ordinary
        // Phase-1 machinery.
        pendingSeekSeconds = target
        pendingSeekTrackId = track.trackId
        positionBias = target
        cachedPosition = target
        seekEpochCounter += 1
        eventAdd(.info, "stream", "epoch open #\(seekEpochCounter) row=\(activeIndex) id=\(track.trackId) base=\(base)s target=\(String(format: "%.1f", target))s autoplay=\(autoPlay)")
        onStreamEpoch?([
            "trackId": track.trackId,
            "phase": "open",
            "epoch": seekEpochCounter,
            "base": base,
            "target": target,
        ])
        // The delivery guard is the ACTIVE ROW, not `seekEpoch != nil`: an
        // offset-IGNORED epoch is REBASED AND ADOPTED (the verdict clears
        // `seekEpoch`) while its transfer keeps delivering — that file is now
        // the row's own source, so its progress must still grow the schedule.
        // A row change silences the transfer first (`discardSeekEpoch` in
        // `loadAndStart`), so a stale delivery cannot arrive at all.
        let guardedTrackId = track.trackId
        let isActiveRow: () -> Bool = { [weak self] in
            guard let self = self, self.tracks.indices.contains(self.activeIndex) else { return false }
            return self.tracks[self.activeIndex].trackId == guardedTrackId
        }
        loader.streamLoad(track, epoch: transfer, onProgress: { [weak self] progress in
            guard let self = self, progress.isEpoch, isActiveRow() else { return }
            self.extendStagedSchedule(progress: progress)
        }, onFinished: { [weak self] progress, error in
            guard let self = self, isActiveRow() else { return }
            if let progress {
                self.completeStagedSchedule(progress: progress)
            } else if let error {
                // The epoch transfer died: discard it and hand the row to the
                // bounded retry with the intent still parked — Phase-1
                // behavior, the worst case of every Phase-2 path.
                let failure = self.activeLoadFailure(kind: .stream, error: error)
                self.discardSeekEpoch()
                self.teardownStagedState()
                self.handleYieldedActiveLoadFailure(track: track, failure: failure)
            }
        }, onArrival: { [weak self] deliveredBytes in
            guard let self = self, isActiveRow() else { return }
            self.recordStreamArrival(deliveredBytes: deliveredBytes)
        })
        return true
    }

    /// Ends the epoch: its transfer is cancelled and its ephemeral file
    /// discarded by the loader (never promoted, never served — plan §2.7).
    /// The staged state is left alone on purpose — the offset-ignored rebase
    /// keeps reading the same file as the row's ordinary transfer.
    private func discardSeekEpoch() {
        guard let epoch = seekEpoch else { return }
        seekEpoch = nil
        eventAdd(.info, "stream", "epoch closed #\(seekEpochCounter) id=\(epoch.trackId) base=\(epoch.baseSeconds)s verdict=\(epoch.verdict?.rawValue ?? "none")")
        onStreamEpoch?([
            "trackId": epoch.trackId,
            "phase": "closed",
            "base": epoch.baseSeconds,
            "verdict": epoch.verdict?.rawValue ?? "",
        ])
        if loader.activeWriterIsEpoch { loader.cancelActiveWriterRetainingScratch() }
        // The ladder's settle edge: the epoch no longer owns the link, so the
        // speculative walk may resume (a no-op when another user transfer, a
        // staged schedule, still holds it).
        rearmPrefetchIfIdle(reason: "epoch closed")
        // A cancelled writer's state clears on a QUEUED completion hop, so the
        // immediate call above can still see `hasActiveWriter` — one runloop
        // turn later it is honest. Without this a speculatively held walk could
        // sit with no remaining edge to release it (the engine's usual
        // one-turn-after-a-switch discipline).
        DispatchQueue.main.async { [weak self] in
            self?.rearmPrefetchIfIdle(reason: "epoch closed (state settled)")
        }
    }

    /// The timeline placement a staged delivery must be scheduled with
    /// (Phase 2): the ABSOLUTE frame of the source's frame 0 and the (for an
    /// epoch, epoch-relative) metadata duration.
    private struct StagedPlacement {
        var timelineBaseFrames: Int64
        var metadataFrames: Int64
    }

    /// Runs the runtime verdict ONCE per epoch (plan §2.6) and returns the
    /// placement to schedule with — or nil when the epoch was DISCARDED (an
    /// unknown container: the caller must not schedule it). A non-epoch
    /// delivery always returns the ordinary base-0 placement.
    ///
    /// The verdict is read from the epoch container's own claimed length at
    /// the existing first-schedule open boundary — before audio enters the
    /// graph — and the fail-safe is a REBASE, never a snap to 0.
    private func resolveStagedPlacement(
        track: NativeTrack,
        progress: TrackFileLoader.StreamProgress,
        containerFrames: Int64,
        sampleRate sr: Double
    ) -> StagedPlacement? {
        var placement = StagedPlacement(
            timelineBaseFrames: 0,
            metadataFrames: Int64(track.duration * sr))
        guard let epoch = seekEpoch, epoch.trackId == progress.trackId, progress.isEpoch else {
            return placement
        }
        let trackFrames = Int64(track.duration * sr)
        let expectedEpochFrames = Int64(max(0, track.duration - Double(epoch.baseSeconds)) * sr)
        let toleranceFrames = StreamEpoch.toleranceSeconds(trackSeconds: track.duration) * sr
        let verdict = StreamEpoch.offsetHonored(
            containerFrames: Double(containerFrames),
            expectedEpochFrames: Double(expectedEpochFrames),
            trackFrames: Double(trackFrames),
            toleranceFrames: toleranceFrames)
        seekEpoch?.verdict = verdict
        onStreamEpoch?([
            "trackId": track.trackId,
            "phase": "verdict",
            "epoch": seekEpochCounter,
            "base": epoch.baseSeconds,
            "verdict": verdict.rawValue,
            "containerFrames": containerFrames,
            "expectedFrames": expectedEpochFrames,
        ])
        switch verdict {
        case .honored:
            // The server re-encoded from the offset: this file's frame 0 is
            // absolute `base`, and the schedule starts INSIDE the window at
            // the user's EXACT intent (the integer parameter cannot carry the
            // sub-second part; the base can).
            placement.timelineBaseFrames = Int64(Double(epoch.baseSeconds) * sr)
            placement.metadataFrames = expectedEpochFrames
            eventAdd(.info, "stream", "epoch verdict honored #\(seekEpochCounter) id=\(track.trackId) base=\(epoch.baseSeconds)s container=\(containerFrames) frames (expected \(expectedEpochFrames))")
            return placement
        case .ignored:
            // The offset was IGNORED: the body is the row's ordinary
            // head-first transfer. REBASE to base 0 and ADOPT it — the bytes
            // are the row's own, so nothing is wasted; the intent stays
            // parked at T and the delivered window reaches it linearly.
            // NEVER a snap to 0 (plan §2.6/§9).
            placement.timelineBaseFrames = 0
            placement.metadataFrames = trackFrames
            seekEpoch = nil
            eventAdd(.info, "stream", "epoch verdict ignored #\(seekEpochCounter) id=\(track.trackId) — rebased to base 0, intent kept at \(String(format: "%.1f", epoch.targetSeconds))s (adopted as the row's transfer)")
            return placement
        case .unknown:
            // Neither shape: NEVER schedule an unverified base. Discard the
            // epoch and fall back to the row's own transfer with the position
            // parked — exactly the Phase-1 path.
            let target = epoch.targetSeconds
            eventAdd(.danger, "stream", "epoch verdict unknown #\(seekEpochCounter) id=\(track.trackId) (container \(containerFrames) frames vs expected \(expectedEpochFrames), track \(trackFrames)) — discarded, Phase-1 wait")
            discardSeekEpoch()
            teardownStagedState()
            hasLiveSchedule = false
            pendingSeekSeconds = target
            pendingSeekTrackId = track.trackId
            positionBias = target
            cachedPosition = target
            loadAndStart(currentIndex: activeIndex, autoPlay: stagedAutoPlay)
            return nil
        }
    }

    /// The schedulable end of a staged transfer in ABSOLUTE frames — the ONE
    /// place the epoch's local container numbers meet the track's absolute
    /// coordinates (plan §2.2). `isComplete` means the container is file
    /// truth; otherwise the estimate's byte denominator is epoch-relative.
    private func stagedSchedulableEndFrames(
        baseFrames: Int64,
        containerFrames: Int64,
        metadataFrames: Int64,
        deliveredBytes: Int64,
        announcedBytes: Int64,
        isComplete: Bool,
        sampleRate: Double
    ) -> Int64 {
        if isComplete { return baseFrames + containerFrames }
        let announced = epochRelativeAnnouncedBytes(
            baseFrames: baseFrames,
            metadataFrames: metadataFrames,
            announcedBytes: announcedBytes,
            sampleRate: sampleRate)
        let local = StreamSchedule.stagedEndFramesEstimate(
            containerFrames: containerFrames,
            metadataFrames: metadataFrames,
            deliveredBytes: deliveredBytes,
            announcedBytes: announced)
        return baseFrames + local
    }

    /// The announced-byte DENOMINATOR for a staged estimate. For an epoch
    /// transfer it is rescaled to the epoch's own expectation: the server
    /// computes `estimateContentLength` from the FULL duration even for an
    /// offset stream (plan fact 21), so the full number would deflate the
    /// epoch's delivered fraction and starve the lead.
    private func epochRelativeAnnouncedBytes(
        baseFrames: Int64,
        metadataFrames: Int64,
        announcedBytes: Int64,
        sampleRate: Double
    ) -> Int64 {
        guard baseFrames > 0, announcedBytes > 0, sampleRate > 0 else { return announcedBytes }
        let trackSeconds = Double(metadataFrames + baseFrames) / sampleRate
        let baseSeconds = Double(baseFrames) / sampleRate
        let expected = StreamEpoch.expectedEpochBytes(
            announcedBytes: Double(announcedBytes),
            trackSeconds: trackSeconds,
            offsetSeconds: baseSeconds)
        return expected > 0 ? Int64(expected) : announcedBytes
    }

    /// MAIN, on every byte arrival (F2): update the progress ledger the
    /// stall machinery reads. The schedule resume itself still rides the
    /// rung-gated deliveries (which carry full StreamProgress) — arrivals
    /// only keep the give-up timer honest and unblock resume promptly at
    /// rung cadence (~2-4 s on a trickle link, not ~30-60 s).
    private func recordStreamArrival(deliveredBytes: Int64) {
        // Workstream C (2026-10-04): while the FIRST schedule is still
        // pending, arrivals re-attempt the open at a bounded cadence. The
        // rung-gated delivery is the only other trigger, so a partial whose
        // header / first audio page landed just after a rung waited a whole
        // rung (a lead of bytes) to be opened — the field's 5-6 "partial not
        // openable yet" rounds.
        if stagedSchedule == nil {
            retryFirstStagedScheduleIfDue(deliveredBytes: deliveredBytes)
            return
        }
        guard var staged = stagedSchedule else { return }
        staged.deliveredBytes = deliveredBytes
        staged.lastProgressAt = Date()
        stagedSchedule = staged
    }

    /// MAIN, on each byte arrival while the first schedule is still pending: a
    /// throttled re-attempt of the first open. The pure `StreamSchedule`
    /// cadence owns the timing; `startFirstStagedSchedule` owns the identity
    /// guards (its `trackId == progress.trackId` check drops a stale cache
    /// after a track change). The retry attempt deliberately does NOT log a
    /// deferral — otherwise the self-test's `deferredFirstScheduleCount` would
    /// count cadence retries instead of the meaningful per-rung deferrals.
    private func retryFirstStagedScheduleIfDue(deliveredBytes: Int64) {
        guard let cached = lastFirstScheduleProgress else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard StreamSchedule.firstScheduleRetryDue(lastAttemptAt: lastFirstScheduleAttemptAt, now: now) else { return }
        lastFirstScheduleAttemptAt = now
        let refreshed = TrackFileLoader.StreamProgress(
            trackId: cached.trackId,
            url: cached.url,
            stage: cached.stage,
            deliveredBytes: max(deliveredBytes, cached.deliveredBytes),
            announcedBytes: cached.announcedBytes,
            // The epoch flag must SURVIVE this refresh: dropping it would
            // schedule an epoch file at base 0 (silent wrong-position audio).
            isEpoch: cached.isEpoch)
        lastFirstScheduleProgress = refreshed
        startFirstStagedSchedule(progress: refreshed, logDeferral: false)
    }

    /// MAIN, on each writer delivery: the staged schedule's growth engine.
    /// Not stalled → maybe chain an extension. Stalled → maybe resume.
    /// First delivery → the first honest schedule.
    private func extendStagedSchedule(progress: TrackFileLoader.StreamProgress) {
        // Phase 4 (2026-10-07): the first delivered byte after a seek is a
        // latency leg. Only this lane has byte callbacks at all — the plain
        // downloadTask lane is covered by the schedule leg's inference.
        if progress.deliveredBytes > 0 { markSeekLeg(.firstByte) }
        guard let current = stagedSchedule, stagedSourceURL != nil else {
            // Cache the delivery so byte arrivals can re-attempt the open
            // between rungs (workstream C).
            lastFirstScheduleProgress = progress
            lastFirstScheduleAttemptAt = ProcessInfo.processInfo.systemUptime
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
            let endable = stagedSchedulableEndFrames(
                baseFrames: staged.timelineBaseFrames,
                containerFrames: staged.headerClaimedFrames,
                metadataFrames: staged.metadataFrames,
                deliveredBytes: progress.deliveredBytes,
                announcedBytes: staged.announcedBytes,
                isComplete: staged.isComplete,
                sampleRate: staged.sampleRate)
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
        // Both frames below are ABSOLUTE (the promise and the estimate), so an
        // epoch's local container numbers meet the schedule in ONE place.
        let endable = stagedSchedulableEndFrames(
            baseFrames: staged.timelineBaseFrames,
            containerFrames: staged.headerClaimedFrames,
            metadataFrames: staged.metadataFrames,
            deliveredBytes: progress.deliveredBytes,
            announcedBytes: staged.announcedBytes,
            isComplete: staged.isComplete,
            sampleRate: staged.sampleRate)
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
    private func startFirstStagedSchedule(progress: TrackFileLoader.StreamProgress, logDeferral: Bool = true) {
        guard tracks.indices.contains(activeIndex) else { return }
        let track = tracks[activeIndex]
        guard track.trackId == progress.trackId else { return }
        guard let file = try? AVAudioFile(forReading: progress.url), file.length > 0 else {
            if logDeferral {
                eventAdd(.info, "stream", "partial not openable yet id=\(track.trackId) delivered=\(progress.deliveredBytes)B — deferring first schedule")
            }
            return
        }
        let sr = file.processingFormat.sampleRate
        let containerFrames = file.length
        // Phase 2 (2026-10-07): an EPOCH delivery carries its own coordinate
        // system, and its TIMELINE BASE is decided HERE — from the container's
        // own claim, BEFORE any schedule exists (plan §2.6). An epoch that
        // cannot demote itself must never start (plan §3 step 2).
        guard let placement = resolveStagedPlacement(
            track: track, progress: progress, containerFrames: containerFrames, sampleRate: sr) else {
            return
        }
        let timelineBaseFrames = placement.timelineBaseFrames
        let metadataFrames = placement.metadataFrames
        let endable = stagedSchedulableEndFrames(
            baseFrames: timelineBaseFrames,
            containerFrames: containerFrames,
            metadataFrames: metadataFrames,
            deliveredBytes: progress.deliveredBytes,
            announcedBytes: progress.announcedBytes,
            isComplete: false,
            sampleRate: sr)
        guard endable > 0 else {
            if logDeferral {
                eventAdd(.info, "stream", "no schedulable evidence yet id=\(track.trackId) — deferring first schedule")
            }
            return
        }
        // Phase 1 (2026-10-07): a seek parked before this row's source existed
        // is honored HERE — the first staged schedule starts at the intent,
        // not at 0.
        let parked = pendingSeekTrackId == track.trackId ? pendingSeekSeconds : nil
        pendingSeekSeconds = nil
        pendingSeekTrackId = nil
        let startAt = PlayIntent.firstScheduleStartSeconds(pendingSeekSeconds: parked)
        stagedSourceURL = progress.url
        stagedSchedule = StagedSchedule(
            trackId: track.trackId,
            headerClaimedFrames: containerFrames,
            sampleRate: sr,
            metadataFrames: metadataFrames,
            scheduledEndFrames: 0,
            timelineBaseFrames: timelineBaseFrames,
            announcedBytes: progress.announcedBytes,
            deliveredBytes: progress.deliveredBytes)
        markSeekLeg(.firstSchedule)
        eventAdd(.info, "stream", "first staged schedule id=\(track.trackId) start=\(String(format: "%.1f", startAt))s base=\(String(format: "%.1f", Double(timelineBaseFrames) / sr))s endable=\(endable) frames (\(String(format: "%.1f", Double(endable) / sr))s of header claim \(containerFrames))")
        scheduleCurrentTrack(from: startAt, autoPlay: stagedAutoPlay)
    }

    /// The writer promoted a COMPLETE file but NO staged schedule ever formed
    /// (its container never opened at the lead crossing — a non-progressive
    /// output — or its response carried no total so the delivery was withheld).
    /// The promoted file is on disk and passed the gate chain, so schedule it
    /// WHOLE, exactly what the normal download path does. Without this the
    /// completion would no-op and the track would load and then never play,
    /// with no error for the retry machine to act on. (2026-10-02 review: this
    /// is the shape a chunked transcode deliberately takes, so the hole my
    /// no-total guard would otherwise open was real; it equally covers a
    /// deferred RAW stream, which had the same latent dead air.)
    private func scheduleStagedFileWhole(progress: TrackFileLoader.StreamProgress) {
        guard tracks.indices.contains(activeIndex) else { return }
        let track = tracks[activeIndex]
        guard track.trackId == progress.trackId else { return }
        guard let file = try? AVAudioFile(forReading: progress.url), file.length > 0 else {
            let failure = ActiveLoadFailure(kind: .stream, detail: "Completed stream is not decodable")
            handleYieldedActiveLoadFailure(track: track, failure: failure)
            return
        }
        let sr = file.processingFormat.sampleRate
        // Phase 2 (2026-10-07): a whole-file completion can equally be an
        // EPOCH's (its container never opened at the lead crossing) — the
        // verdict runs here instead, and an unknown container falls back to
        // the row's own transfer with the intent parked (Phase-1 behavior).
        guard let placement = resolveStagedPlacement(
            track: track, progress: progress, containerFrames: file.length, sampleRate: sr) else {
            return
        }
        // Phase 1 (2026-10-07): this IS the row's first real schedule — honor
        // a position parked while the stream was maturing.
        let parked = pendingSeekTrackId == track.trackId ? pendingSeekSeconds : nil
        pendingSeekSeconds = nil
        pendingSeekTrackId = nil
        stagedSourceURL = progress.url
        stagedSchedule = StagedSchedule(
            trackId: track.trackId,
            headerClaimedFrames: file.length,
            sampleRate: sr,
            metadataFrames: placement.metadataFrames,
            scheduledEndFrames: 0,
            timelineBaseFrames: placement.timelineBaseFrames,
            announcedBytes: progress.announcedBytes,
            deliveredBytes: progress.deliveredBytes,
            isComplete: true) // the byte/duration gates already passed
        markSeekLeg(.firstSchedule)
        eventAdd(.info, "stream", "completed stream scheduled whole id=\(track.trackId) frames=\(file.length) base=\(String(format: "%.1f", Double(placement.timelineBaseFrames) / sr))s (no staged schedule had formed)")
        prefetchUpcoming(from: activeIndex)
        scheduleCurrentTrack(
            from: PlayIntent.firstScheduleStartSeconds(pendingSeekSeconds: parked),
            autoPlay: stagedAutoPlay)
    }

    /// The writer promoted a COMPLETE file: the byte gates passed, so the
    /// header claim is now FILE TRUTH. Chain the remaining full-length
    /// segment (the estimate's 2 % slack never truncates the tail) and mark
    /// the schedule complete — its final completion is a REAL natural end.
    private func completeStagedSchedule(progress: TrackFileLoader.StreamProgress) {
        guard stagedSchedule != nil else {
            // A deferred stream has no staged schedule to complete: schedule
            // the promoted file whole (2026-10-02 review — see the helper).
            scheduleStagedFileWhole(progress: progress)
            return
        }
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
            // ABSOLUTE (Phase 2): for an epoch the container's end is local,
            // so the base is added once, here — `scheduledEndFrames` and the
            // completion tail plan both live in track coordinates.
            let endable = staged.timelineBaseFrames + StreamSchedule.schedulableEndFrames(
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
                headerClaimedFrames: endable) {
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
        // EPOCH-LOCAL frame arguments (Phase 2): the source file's frame 0 is
        // `timelineBaseFrames`, while `toFrames`/`scheduledEndFrames` are
        // absolute. The LENGTH is a delta — identical under both spaces — so
        // only the segment's start converts.
        let start = staged.scheduledEndFrames - staged.timelineBaseFrames
        let localEnd = toFrames - staged.timelineBaseFrames
        let frames = toFrames - staged.scheduledEndFrames
        guard StreamSchedule.canSchedule(startFrame: start, endFrames: localEnd), frames > 0 else { return }
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
        eventAdd(.debug, "stream", "chained segment \(start) local → \(toFrames) absolute frames (\(String(format: "%.1f", Double(frames) / sr))s) id=\(staged.trackId) base=\(String(format: "%.1f", Double(staged.timelineBaseFrames) / sr))s")
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
        // Workstream C: the first-schedule retry cache dies with the state it
        // belongs to (a new load must never re-open the previous row's .part).
        lastFirstScheduleProgress = nil
        lastFirstScheduleAttemptAt = nil
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
                    announcedBytes: staged.announcedBytes,
                    isEpoch: staged.timelineBaseFrames > 0)
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
        // or finishes into cache, both harmless) and the parked seek intent.
        teardownStagedState()
        // Phase 2: an epoch is session-scoped too — its transfer is discarded
        // (the loader removes the ephemeral file).
        discardSeekEpoch()
        pendingSeekSeconds = nil
        pendingSeekTrackId = nil
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
