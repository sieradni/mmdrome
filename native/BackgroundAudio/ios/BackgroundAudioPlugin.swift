import Foundation
import Capacitor

@objc(BackgroundAudioPlugin)
public class BackgroundAudioPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "BackgroundAudioPlugin"
    public let jsName = "BackgroundAudio"

    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setQueueAndPlay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refreshQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLoopMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playTrackAt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "toggle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previous", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSpeed", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPitchOctaves", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTapeMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSnapTolerance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setReplayGainMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPreampDb", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMasterVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCrossfade", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPreloadCount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSleepTimer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setEq", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDebugState", returnType: CAPPluginReturnPromise)
    ]

    private let engine = NativeAudioEngine()
    private let session = SessionController()
    private let nowPlaying = NowPlayingController()
    private var nowPlayingTimer: Timer?

    /// Capacitor invokes plugin methods on its serial bridge queue. The native
    /// audio graph, loader, timers, and engine state are main-thread-owned, so
    /// commands are marshalled before touching the engine and resolve only after
    /// the main-thread operation completes.
    private func performOnMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    private func performOnMainSync<T>(_ work: () -> T) -> T {
        if Thread.isMainThread { return work() }
        return DispatchQueue.main.sync(execute: work)
    }

    @objc override public func load() {
        super.load()

        session.configure(
            onPause: { [weak self] in self?.performOnMain { self?.engine.pause() } },
            onResume: { [weak self] in self?.performOnMain { self?.engine.play() } },
            isPlaying: { [weak self] in self?.performOnMainSync { self?.engine.isCurrentlyPlaying ?? false } ?? false }
        )

        engine.onTrackChanged = { [weak self] trackId in
            guard let self = self else { return }
            self.notifyListeners("trackChanged", data: ["trackId": trackId])
            self.refreshNowPlaying()
        }
        engine.onPlaybackStateChanged = { [weak self] playing in
            guard let self = self else { return }
            self.notifyListeners("playbackStateChanged", data: ["playing": playing])
            if playing {
                self.startNowPlayingTimer()
            } else {
                self.stopNowPlayingTimer()
            }
            self.refreshNowPlaying()
        }
        engine.onQueueEnded = { [weak self] in
            guard let self = self else { return }
            self.notifyListeners("ended", data: [:])
            self.refreshNowPlaying()
        }
        engine.onError = { [weak self] message in
            self?.notifyListeners("error", data: ["message": message])
        }
        engine.onSleepTimerFired = { [weak self] in
            self?.notifyListeners("sleepTimerFired", data: [:])
            self?.refreshNowPlaying()
        }

        nowPlaying.setupRemoteCommands()
        nowPlaying.onPlay = { [weak self] in self?.performOnMain { self?.engine.play() } }
        nowPlaying.onPause = { [weak self] in self?.performOnMain { self?.engine.pause() } }
        nowPlaying.onToggle = { [weak self] in self?.performOnMain { self?.engine.togglePlayPause() } }
        nowPlaying.onNext = { [weak self] in self?.performOnMain { self?.engine.next() } }
        nowPlaying.onPrevious = { [weak self] in self?.performOnMain { self?.engine.previous() } }
        nowPlaying.onSeek = { [weak self] position in self?.performOnMain { self?.engine.seek(to: position) } }
    }

    deinit {
        nowPlayingTimer?.invalidate()
    }

    // MARK: - Commands

    @objc func initialize(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func setQueue(_ call: CAPPluginCall) {
        let raw = call.getArray("tracks", [])
        let tracks: [NativeTrack] = raw.enumerated().compactMap { idx, object in
            guard let dict = object as? JSObject else { return nil }
            return NativeTrack(from: dict, index: idx)
        }
        let activeIndex = call.getInt("activeIndex", 0)
        let loopMode = NativeLoopMode(rawValue: call.getString("loopMode", "none")) ?? .none
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setQueue(tracks: tracks, activeIndex: activeIndex, loopMode: loopMode)
            call.resolve()
        }
    }

    @objc func setQueueAndPlay(_ call: CAPPluginCall) {
        let raw = call.getArray("tracks", [])
        let tracks: [NativeTrack] = raw.enumerated().compactMap { idx, object in
            guard let dict = object as? JSObject else { return nil }
            return NativeTrack(from: dict, index: idx)
        }
        let activeIndex = call.getInt("activeIndex", 0)
        let loopMode = NativeLoopMode(rawValue: call.getString("loopMode", "none")) ?? .none
        let autoPlay = call.getBool("autoPlay", true)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setQueueAndPlay(tracks: tracks, activeIndex: activeIndex, loopMode: loopMode, autoPlay: autoPlay)
            // Ensure lock-screen updates even when playback hasn't started yet — the
            // trackChanged event fired synchronously above, but if the caller
            // restarts the same track (oldId==newId) no event fires and the previous
            // track's artwork/duration would linger until the next timer tick.
            self.refreshNowPlaying()
            call.resolve()
        }
    }

    @objc func refreshQueue(_ call: CAPPluginCall) {
        let raw = call.getArray("tracks", [])
        let tracks: [NativeTrack] = raw.enumerated().compactMap { idx, object in
            guard let dict = object as? JSObject else { return nil }
            return NativeTrack(from: dict, index: idx)
        }
        let activeIndex = call.getInt("activeIndex", 0)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.refreshQueue(tracks: tracks, activeIndex: activeIndex)
            call.resolve()
        }
    }

    @objc func setLoopMode(_ call: CAPPluginCall) {
        let mode = NativeLoopMode(rawValue: call.getString("loopMode", "none")) ?? .none
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setLoopMode(mode)
            call.resolve()
        }
    }

    @objc func playTrackAt(_ call: CAPPluginCall) {
        let index = call.getInt("index", 0)
        let autoPlay = call.getBool("autoPlay", true)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.playTrack(at: index, autoPlay: autoPlay)
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.play()
            self.refreshNowPlaying()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.pause()
            // The engine's onPlaybackStateChanged only fires when isPlaying actually
            // flips; refreshing unconditionally guarantees the lock screen / control
            // center reflects the paused state even when the guard short-circuits.
            self.refreshNowPlaying()
            call.resolve()
        }
    }

    @objc func toggle(_ call: CAPPluginCall) {
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.togglePlayPause()
            self.refreshNowPlaying()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let position = call.getDouble("position", 0)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.seek(to: position)
            call.resolve()
        }
    }

    @objc func next(_ call: CAPPluginCall) {
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.next()
            call.resolve()
        }
    }

    @objc func previous(_ call: CAPPluginCall) {
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.previous()
            call.resolve()
        }
    }

    @objc func setSpeed(_ call: CAPPluginCall) {
        let speed = call.getDouble("speed", 1)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setSpeed(speed)
            call.resolve()
        }
    }

    @objc func setPitchOctaves(_ call: CAPPluginCall) {
        let octaves = call.getDouble("octaves", 0)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setPitchOctaves(octaves)
            call.resolve()
        }
    }

    @objc func setTapeMode(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled", false)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setTapeMode(enabled)
            call.resolve()
        }
    }

    @objc func setSnapTolerance(_ call: CAPPluginCall) {
        let semitones = call.getDouble("semitones", 0.15)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setSnapTolerance(semitones)
            call.resolve()
        }
    }

    @objc func setReplayGainMode(_ call: CAPPluginCall) {
        let mode = call.getString("mode", "off")
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setReplayGainMode(mode)
            call.resolve()
        }
    }

    @objc func setPreampDb(_ call: CAPPluginCall) {
        let db = call.getDouble("db", 0)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setPreampDb(db)
            call.resolve()
        }
    }

    @objc func setMasterVolume(_ call: CAPPluginCall) {
        let volume = call.getDouble("volume", 1)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setMasterVolume(volume)
            call.resolve()
        }
    }

    @objc func setCrossfade(_ call: CAPPluginCall) {
        let duration = call.getDouble("duration", 0)
        let curve = call.getString("curve", "sigmoid")
        let steepness = call.getDouble("sigmoidSteepness", 6)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setCrossfade(duration: duration, curve: curve, sigmoidSteepness: steepness)
            call.resolve()
        }
    }

    @objc func setPreloadCount(_ call: CAPPluginCall) {
        let count = call.getInt("count", 0)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setPreloadCount(count)
            call.resolve()
        }
    }

    @objc func setSleepTimer(_ call: CAPPluginCall) {
        let active = call.getBool("active", false)
        let mode = call.getString("mode", "minutes")
        let minutes = call.getDouble("minutes", 30)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.setSleepTimer(active: active, mode: mode, minutes: minutes)
            call.resolve()
        }
    }

    @objc func setEq(_ call: CAPPluginCall) {
        let raw = call.getArray("filters", [])
        let filters = raw.compactMap { $0 as? JSObject }.map { NativeFilterConfig(from: $0) }
        let bypassed = call.getBool("bypassed", false)
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            self.engine.applyFilters(filters, bypassed: bypassed)
            call.resolve()
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            let state = self.engine.state()
            call.resolve([
                "index": state.index,
                "trackId": state.trackId,
                "position": state.position,
                "duration": state.duration,
                "playing": state.playing,
                "speed": state.speed
            ])
        }
    }

    @objc func getDebugState(_ call: CAPPluginCall) {
        performOnMain { [weak self] in
            guard let self else { call.resolve(); return }
            call.resolve(self.engine.debugState())
        }
    }

    // MARK: - Now Playing

    private func refreshNowPlaying() {
        let state = engine.state()
        nowPlaying.update(
            track: engine.currentTrack(),
            queueCount: engine.queueCount,
            position: state.position,
            playing: state.playing,
            speed: state.speed,
            duration: state.duration
        )
    }

    private func startNowPlayingTimer() {
        stopNowPlayingTimer()
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.refreshNowPlaying()
        }
        nowPlayingTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func stopNowPlayingTimer() {
        nowPlayingTimer?.invalidate()
        nowPlayingTimer = nil
    }
}
