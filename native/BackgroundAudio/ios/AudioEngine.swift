import Foundation
import AVFoundation

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
    struct LoadedFile {
        let url: URL
    }

    private var cache: [String: LoadedFile] = [:]
    private var activeTasks: [String: URLSessionDownloadTask] = [:]
    /// Completions waiting on a download already in flight (see `prefetch`).
    private var pendingCompletions: [String: [(URL?, Error?) -> Void]] = [:]
    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.timeoutIntervalForRequest = 120
        config.timeoutIntervalForResource = 600
        return URLSession(configuration: config)
    }()

    func localURL(for track: NativeTrack) -> URL? {
        if track.url.isFileURL { return track.url }
        guard let entry = cache[track.trackId] else { return nil }
        return entry.url
    }

    func prefetch(_ track: NativeTrack, completion: @escaping (URL?, Error?) -> Void) {
        if track.url.isFileURL {
            completion(track.url, nil)
            return
        }
        if cache[track.trackId] != nil {
            completion(cache[track.trackId]?.url, nil)
            return
        }
        if activeTasks[track.trackId] != nil {
            // A download for this track is already in flight (started by
            // `prefetchNeighbors`). Chain onto it instead of dropping the
            // completion: `loadAndStart` only schedules its track once this
            // fires, so a dropped callback leaves the engine silently stalled.
            pendingCompletions[track.trackId, default: []].append(completion)
            return
        }

        let destination = Self.destinationURL(for: track)
        let task = session.downloadTask(with: track.url) { [weak self] tempURL, _, error in
            guard let self = self else { return }
            self.activeTasks[track.trackId] = nil
            let pendings = self.pendingCompletions.removeValue(forKey: track.trackId) ?? []
            if let tempURL = tempURL, error == nil {
                do {
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.moveItem(at: tempURL, to: destination)
                    self.cache[track.trackId] = LoadedFile(url: destination)
                } catch {
                    pendings.forEach { $0(nil, error) }
                    return
                }
                completion(destination, nil)
                pendings.forEach { $0(destination, nil) }
            } else {
                completion(nil, error)
                pendings.forEach { $0(nil, error) }
            }
        }
        activeTasks[track.trackId] = task
        task.resume()
    }

    /// Drops a cached file (e.g. a corrupt or partial download) and cancels any
    /// in-flight fetch for it so the next prefetch re-fetches from the server.
    func evict(_ trackId: String) {
        if let entry = cache.removeValue(forKey: trackId) {
            try? FileManager.default.removeItem(at: entry.url)
        }
        activeTasks[trackId]?.cancel()
        activeTasks[trackId] = nil
        pendingCompletions.removeValue(forKey: trackId)
    }

    /// Deletes cached files for tracks that are no longer within `keepRadius` of `currentIndex`.
    func cleanup(currentIndex: Int, tracks: [NativeTrack], keepRadius: Int = 3) {
        let minIndex = currentIndex - keepRadius
        let maxIndex = currentIndex + keepRadius
        for track in tracks where track.index < minIndex || track.index > maxIndex {
            if let entry = cache.removeValue(forKey: track.trackId) {
                try? FileManager.default.removeItem(at: entry.url)
            }
            activeTasks[track.trackId]?.cancel()
            activeTasks[track.trackId] = nil
        }
    }

    private static func destinationURL(for track: NativeTrack) -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("mmdrome-tracks", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let hash = abs(track.trackId.hashValue).description
        let ext = track.url.pathExtension
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

    // MARK: - State

    private let loader = TrackFileLoader()
    private var tracks: [NativeTrack] = []
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
    /// True while a crossfade between active and standby is in progress.
    private var crossfadeActive = false
    /// True once the crossfade for the current track has been armed.
    private var crossfadeArmed = false
    /// Index of the standby track during an armed crossfade.
    private var crossfadeTargetIndex = -1

    /// Incremented on every schedule reset so stale completion handlers are ignored.
    private var scheduleGeneration = 0
    /// Incremented when the standby player's pending segment is cancelled so its
    /// (stop-triggered) completion handler cannot fake a natural track advance.
    private var standbyScheduleGeneration = 0
    /// Standby generation captured when the standby segment was scheduled.
    private var standbyGeneration = 0

    private var crossfadeMonitor: Timer?
    private var volumeRampTimer: Timer?
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
    private var replayGainMode = "off"
    private var preampDb: Double = 0
    private var masterVolume: Double = 1
    private var crossfadeDuration: Double = 0
    private var crossfadeCurve = "sigmoid"
    private var sigmoidSteepness: Double = 6

    public override init() {
        super.init()
        setupGraph()
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

        engine.connect(playerA, to: gainA, format: nil)
        engine.connect(playerB, to: gainB, format: nil)
        engine.connect(gainA, to: mixer, format: nil)
        engine.connect(gainB, to: mixer, format: nil)
        engine.connect(mixer, to: timePitch, format: nil)
        engine.connect(timePitch, to: varispeed, format: nil)
        engine.connect(varispeed, to: eq, format: nil)
        engine.connect(eq, to: preamp, format: nil)
        engine.connect(preamp, to: engine.mainMixerNode, format: nil)

        mixer.outputVolume = 1.0
        gainA.outputVolume = 1.0
        gainB.outputVolume = 1.0
        preamp.outputVolume = 1.0
        timePitch.pitch = 0.0
        timePitch.rate = 1.0
        varispeed.rate = 1.0
        for band in eq.bands { band.bypass = true }
    }

    private func ensureEngineRunning() {
        guard !engine.isRunning else { return }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            onError?("Failed to start audio engine: \(error.localizedDescription)")
        }
    }

    // MARK: - Queue & playback control

    public func setQueue(tracks: [NativeTrack], activeIndex: Int, loopMode: NativeLoopMode) {
        stopPlayback()
        self.tracks = tracks
        self.loopMode = loopMode
        self.activeIndex = tracks.isEmpty ? 0 : max(0, min(activeIndex, tracks.count - 1))
    }

    public func playTrack(at index: Int, autoPlay: Bool) {
        guard !tracks.isEmpty else { return }
        let clamped = max(0, min(index, tracks.count - 1))
        let changed = clamped != activeIndex
        activeIndex = clamped
        loadAndStart(currentIndex: clamped, autoPlay: autoPlay)
        if autoPlay && changed {
            onTrackChanged?(tracks[clamped].trackId)
        }
    }

    /// Replaces the queue tail without disturbing the actively playing track.
    /// `tracks[activeIndex].trackId` must match the currently playing track; the
    /// JS side re-sends the full current combined queue after its own promotions.
    public func refreshQueue(tracks: [NativeTrack], activeIndex: Int) {
        guard !tracks.isEmpty else { return }
        guard tracks.indices.contains(activeIndex), tracks[activeIndex].trackId == currentTrackId else {
            // Divergent queue — fall back to a full reset.
            stopPlayback()
            self.tracks = tracks
            self.activeIndex = max(0, min(activeIndex, tracks.count - 1))
            return
        }
        self.tracks = tracks
        // Tear down any armed crossfade targeting the OLD tail; the monitor re-arms
        // from the new list on its next tick. Only invalidate the standby completion
        // while a crossfade is armed/in-flight — after finalizeCrossfadeSwitch the
        // (former standby) node's completion is the active track's natural-end trigger.
        let hadCrossfade = crossfadeArmed || crossfadeActive
        stopCrossfadeMonitor()
        stopVolumeRamp()
        if hadCrossfade {
            standbyScheduleGeneration += 1
            standbyNode.stop()
        }
        standbyGain.outputVolume = 0
        crossfadeActive = false
        crossfadeArmed = false
        crossfadeTargetIndex = -1
        if isPlaying {
            setupCrossfadeMonitor()
        }
    }

    public func setLoopMode(_ mode: NativeLoopMode) {
        loopMode = mode
        let hadCrossfade = crossfadeArmed || crossfadeActive
        stopCrossfadeMonitor()
        stopVolumeRamp()
        if hadCrossfade {
            standbyScheduleGeneration += 1
            standbyNode.stop()
        }
        standbyGain.outputVolume = 0
        crossfadeActive = false
        crossfadeArmed = false
        crossfadeTargetIndex = -1
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
        stopCrossfadeMonitor()
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
        guard clamped != pitchOctaves else { return }
        pitchOctaves = clamped
        scheduleParamRestart()
    }

    public func setTapeMode(_ enabled: Bool) {
        guard enabled != tapeMode else { return }
        tapeMode = enabled
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
        masterVolume = max(0, min(1, volume))
        refreshPreamp()
    }

    public func setCrossfade(duration: Double, curve: String, sigmoidSteepness: Double) {
        crossfadeDuration = max(0, min(15, duration))
        crossfadeCurve = curve
        self.sigmoidSteepness = sigmoidSteepness
        if isPlaying {
            setupCrossfadeMonitor()
        } else {
            stopCrossfadeMonitor()
        }
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
            let hadCrossfade = crossfadeArmed || crossfadeActive
            stopCrossfadeMonitor()
            stopVolumeRamp()
            if hadCrossfade {
                standbyScheduleGeneration += 1
                standbyNode.stop()
            }
            standbyGain.outputVolume = 0
            crossfadeActive = false
            crossfadeArmed = false
            crossfadeTargetIndex = -1
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
        if let url = loader.localURL(for: track),
           let file = try? AVAudioFile(forReading: url) {
            return Double(file.length) / file.processingFormat.sampleRate
        }
        return 0
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
            guard generation == self.scheduleGeneration else { return }
            guard let url = url else {
                self.onError?(error?.localizedDescription ?? "Failed to load track")
                return
            }
            self.loader.cleanup(currentIndex: index, tracks: self.tracks)
            self.prefetchNeighbors(of: index)
            self.scheduleCurrentTrack(from: 0, autoPlay: autoPlay)
        }
    }

    private func prefetchNeighbors(of index: Int) {
        if let next = nextIndex(after: index), tracks.indices.contains(next) {
            loader.prefetch(tracks[next], completion: { _, _ in })
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
            loader.evict(track.trackId)
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
        crossfadeActive = false
        crossfadeArmed = false
        crossfadeTargetIndex = -1

        if autoPlay {
            ensureEngineRunning()
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
            if self.crossfadeActive {
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

            if let next = self.nextIndex(after: completedIndex) {
                self.playTrack(at: next, autoPlay: true)
            } else {
                self.handleTrackEnd()
            }
        }
    }

    private func setPlaying(_ playing: Bool) {
        if isPlaying == playing { return }
        isPlaying = playing
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
    }

    /// Stops both players and invalidates all pending schedules/completions.
    private func cancelScheduled() {
        scheduleGeneration += 1
        waitingAtTrackEnd = false
        crossfadeActive = false
        crossfadeArmed = false
        crossfadeTargetIndex = -1
        stopCrossfadeMonitor()
        stopVolumeRamp()
        playerA.stop()
        playerB.stop()
    }

    // MARK: - Crossfade

    private func setupCrossfadeMonitor() {
        stopCrossfadeMonitor()
        guard crossfadeDuration > 0, isPlaying, loopMode != .one, !sleepAtTrackEnd, tracks.indices.contains(activeIndex) else { return }

        let current = tracks[activeIndex]
        guard current.duration >= crossfadeDuration + 1 else { return }
        guard let nextIdx = nextIndex(after: activeIndex), tracks.indices.contains(nextIdx) else { return }
        let next = tracks[nextIdx]
        // The standby track must be long enough to fully overlap the fade.
        guard next.duration >= crossfadeDuration else { return }

        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.crossfadeMonitorTick()
        }
        crossfadeMonitor = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopCrossfadeMonitor() {
        crossfadeMonitor?.invalidate()
        crossfadeMonitor = nil
        crossfadeArmed = false
    }

    private func crossfadeMonitorTick() {
        guard isPlaying, !crossfadeActive, !crossfadeArmed else { return }
        guard crossfadeDuration > 0, tracks.indices.contains(activeIndex) else { return }

        let current = tracks[activeIndex]
        let transitionPoint = current.duration - crossfadeDuration
        guard currentPosition >= transitionPoint else { return }
        guard let nextIdx = nextIndex(after: activeIndex), tracks.indices.contains(nextIdx) else { return }

        crossfadeArmed = true
        startCrossfade(to: nextIdx)
    }

    private func startCrossfade(to nextIdx: Int) {
        let nextTrack = tracks[nextIdx]
        guard let localURL = loader.localURL(for: nextTrack),
              let file = try? AVAudioFile(forReading: localURL) else {
            // Standby not ready yet: fall back to plain transition at natural end.
            crossfadeArmed = false
            return
        }

        crossfadeActive = true
        crossfadeTargetIndex = nextIdx
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

        rampVolume(from: startGain, to: 0, on: activeGain, duration: duration)
        rampVolume(from: 0, to: targetGain, on: standbyGain, duration: duration)
    }

    private func rampVolume(from start: Float, to end: Float, on gainNode: AVAudioMixerNode, duration: Float) {
        let steps = 40
        guard duration > 0, steps > 0 else {
            gainNode.outputVolume = end
            return
        }
        let stepTime = duration / Float(steps)

        stopVolumeRamp()
        rampStepCount = 0
        let timer = Timer(timeInterval: Double(stepTime), repeats: true) { [weak self] timer in
            guard let self = self, timer === self.volumeRampTimer else {
                timer.invalidate()
                return
            }
            self.rampStepCount += 1
            let t = min(1, Float(self.rampStepCount) / Float(steps))
            let value: Float
            switch self.crossfadeCurve {
            case "linear":
                value = start + (end - start) * t
            case "exponential":
                value = start + (end - start) * (t * t)
            default:
                // Sigmoid S-curve, mirroring the web engine's manual interpolation.
                let k = Float(self.sigmoidSteepness)
                let sig = 1.0 / (1.0 + exp(-k * (t - 0.5)))
                value = start + (end - start) * sig
            }
            gainNode.outputVolume = value
            if t >= 1 {
                timer.invalidate()
                self.volumeRampTimer = nil
            }
        }
        volumeRampTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopVolumeRamp() {
        volumeRampTimer?.invalidate()
        volumeRampTimer = nil
        rampStepCount = 0
    }

    private func finalizeCrossfadeSwitch() {
        stopVolumeRamp()
        stopCrossfadeMonitor()
        crossfadeActive = false
        crossfadeArmed = false

        activeIndex = crossfadeTargetIndex
        isActiveB.toggle()
        standbyNode.stop()
        standbyGain.outputVolume = 0
        positionBias = 0
        cachedPosition = 0
        activeGain.outputVolume = Float(tracks[activeIndex].replayGainLinear(mode: replayGainMode))

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
