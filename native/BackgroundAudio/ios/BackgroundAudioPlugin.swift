import Foundation
import Capacitor

@objc(BackgroundAudioPlugin)
public class BackgroundAudioPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "BackgroundAudioPlugin"
    public let jsName = "BackgroundAudio"

    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setQueue", returnType: CAPPluginReturnPromise),
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
        CAPPluginMethod(name: "setReplayGainMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPreampDb", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMasterVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCrossfade", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setEq", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateNowPlaying", returnType: CAPPluginReturnPromise)
    ]

    private let engine = NativeAudioEngine()
    private let session = SessionController()
    private let nowPlaying = NowPlayingController()
    private var nowPlayingTimer: Timer?

    @objc override public func load() {
        super.load()

        session.configure { [weak self] in
            self?.engine.pause()
        }

        engine.onTrackChanged = { [weak self] index in
            guard let self = self else { return }
            self.notifyListeners("trackChanged", data: ["index": index])
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

        nowPlaying.setupRemoteCommands()
        nowPlaying.onPlayPause = { [weak self] in self?.engine.togglePlayPause() }
        nowPlaying.onToggle = { [weak self] in self?.engine.togglePlayPause() }
        nowPlaying.onNext = { [weak self] in self?.engine.next() }
        nowPlaying.onPrevious = { [weak self] in self?.engine.previous() }
        nowPlaying.onSeek = { [weak self] position in self?.engine.seek(to: position) }
    }

    deinit {
        nowPlayingTimer?.invalidate()
    }

    // MARK: - Commands

    @objc func initialize(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func setQueue(_ call: CAPPluginCall) {
        guard let array = call.getArray("tracks", JSObject.self) else {
            call.reject("Missing tracks")
            return
        }
        let tracks: [NativeTrack] = array.enumerated().compactMap { idx, object in
            guard let dict = object as? JSObject else { return nil }
            return NativeTrack(from: dict, index: idx)
        }
        let activeIndex = call.getInt("activeIndex") ?? 0
        let loopMode = NativeLoopMode(rawValue: call.getString("loopMode") ?? "none") ?? .none
        engine.setQueue(tracks: tracks, activeIndex: activeIndex, loopMode: loopMode)
        call.resolve()
    }

    @objc func playTrackAt(_ call: CAPPluginCall) {
        let index = call.getInt("index") ?? 0
        let autoPlay = call.getBool("autoPlay") ?? true
        engine.playTrack(at: index, autoPlay: autoPlay)
        call.resolve()
    }

    @objc func play(_ call: CAPPluginCall) {
        engine.play()
        call.resolve()
    }

    @objc func pause(_ call: CAPPluginCall) {
        engine.pause()
        call.resolve()
    }

    @objc func toggle(_ call: CAPPluginCall) {
        engine.togglePlayPause()
        call.resolve()
    }

    @objc func seek(_ call: CAPPluginCall) {
        engine.seek(to: call.getDouble("position") ?? 0)
        call.resolve()
    }

    @objc func next(_ call: CAPPluginCall) {
        engine.next()
        call.resolve()
    }

    @objc func previous(_ call: CAPPluginCall) {
        engine.previous()
        call.resolve()
    }

    @objc func setSpeed(_ call: CAPPluginCall) {
        engine.setSpeed(call.getDouble("speed") ?? 1)
        call.resolve()
    }

    @objc func setPitchOctaves(_ call: CAPPluginCall) {
        engine.setPitchOctaves(call.getDouble("octaves") ?? 0)
        call.resolve()
    }

    @objc func setTapeMode(_ call: CAPPluginCall) {
        engine.setTapeMode(call.getBool("enabled") ?? false)
        call.resolve()
    }

    @objc func setReplayGainMode(_ call: CAPPluginCall) {
        engine.setReplayGainMode(call.getString("mode") ?? "off")
        call.resolve()
    }

    @objc func setPreampDb(_ call: CAPPluginCall) {
        engine.setPreampDb(call.getDouble("db") ?? 0)
        call.resolve()
    }

    @objc func setMasterVolume(_ call: CAPPluginCall) {
        engine.setMasterVolume(call.getDouble("volume") ?? 1)
        call.resolve()
    }

    @objc func setCrossfade(_ call: CAPPluginCall) {
        engine.setCrossfade(
            duration: call.getDouble("duration") ?? 0,
            curve: call.getString("curve") ?? "sigmoid",
            sigmoidSteepness: call.getDouble("sigmoidSteepness") ?? 6
        )
        call.resolve()
    }

    @objc func setEq(_ call: CAPPluginCall) {
        let filters = (call.getArray("filters", JSObject.self) ?? []).map { object -> NativeFilterConfig in
            NativeFilterConfig(from: object as? JSObject ?? [:])
        }
        engine.applyFilters(filters, bypassed: call.getBool("bypassed") ?? false)
        call.resolve()
    }

    @objc func getState(_ call: CAPPluginCall) {
        let state = engine.state()
        call.resolve([
            "index": state.index,
            "trackId": state.trackId,
            "position": state.position,
            "duration": state.duration,
            "playing": state.playing,
            "speed": state.speed
        ])
    }

    @objc func updateNowPlaying(_ call: CAPPluginCall) {
        refreshNowPlaying()
        call.resolve()
    }

    // MARK: - Now Playing

    private func refreshNowPlaying() {
        let state = engine.state()
        nowPlaying.update(
            track: engine.currentTrack(),
            queueCount: engine.queueCount,
            position: state.position,
            playing: state.playing,
            speed: state.speed
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
