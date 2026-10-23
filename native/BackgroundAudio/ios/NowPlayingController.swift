import Foundation
import MediaPlayer
import UIKit
import BackgroundAudioCore

/// Native lock-screen / control-center integration:
/// - Publishes now playing metadata (title, artist, album, artwork, position) to
///   MPNowPlayingInfoCenter.
/// - Wires MPRemoteCommandCenter actions (play/pause/toggle/next/previous/seek)
///   to the audio engine.
final class NowPlayingController {

    var onCommand: ((PlaybackCommand, Double) -> PlaybackCommandResult)?
    private let registration = RemoteCommandRegistration()
    private var publication = NowPlayingPublication()
    private var cleared = true
    var publicationSink: (([String: Any]) -> Void)?

    private var cachedArtwork: UIImage?
    private var artworkTrackId: String?
    private var lastInfo: [String: Any] = [:]
    /// FAILURE BACKOFF (2026-09-24 dump-2, the hundreds-of-entries spam):
    /// a fetch that produced no decodable image (404, auth-token expiry,
    /// garbage body) used to return WITHOUT latching any state — the next
    /// `update` (every 250 ms tick / refreshNowPlaying) saw
    /// `artworkTrackId != trackId` and refetched, 2-4×/s FOREVER. Now the
    /// failed id is latched and retried on an exponential backoff (2 s →
    /// 60 s cap): the request loop stops flooding the network and the ring,
    /// while a transient server condition still recovers. A successful
    /// fetch clears the entry. Main-thread-confined like the controller.
    private var artworkFailureRetryAt: [String: Date] = [:]
    private var artworkFailureAttempt: [String: Int] = [:]
    /// De-dupe so a burst of updates before the completion lands fires ONE
    /// request per id instead of one per update tick (the wake burst logged
    /// 40 parallel fetches in the same millisecond).
    private var artworkInFlight: Set<String> = []
    private static let artworkBackoffBaseSeconds: TimeInterval = 2.0
    private static let artworkBackoffCapSeconds: TimeInterval = 60.0
    /// Dedupe for guard-drop logging (2026-09-21 ring hygiene): the last
    /// completed trackId whose artwork the guard dropped. A burst of loses
    /// for the same stale fetch logs once; a different id or a fresh apply
    /// resets it (main-thread-confined like the rest of this controller).
    private var lastDroppedArtworkId: String?
    /// Diagnostic sink (2026-09-19): the ArtworkRequestGuard's stale-drop
    /// verdict (the "lock screen shows the default app cover" class) rides
    /// the engine's event log (domain "artwork", wired by the plugin).
    var eventSink: ((NativeEvent.Level, String) -> Void)?
    private func event(_ level: NativeEvent.Level, _ message: String) {
        eventSink?(level, message)
    }

    /// Tracks the latest artwork request so an out-of-order completion (an
    /// older fetch landing last, or a track change without a new request) can
    /// never stamp stale art over the current track (TODO 4.4).
    private var artworkGuard = ArtworkRequestGuard()
    /// The track the lock screen is currently showing (updated in `update`).
    private var currentTrackId: String?

    func setupRemoteCommands() {
        precondition(Thread.isMainThread)
        guard onCommand != nil else { return }
        let center = MPRemoteCommandCenter.shared()
        registration.install {
            let commands: [(MPRemoteCommand, PlaybackCommand)] = [
                (center.playCommand, .play), (center.pauseCommand, .pause),
                (center.togglePlayPauseCommand, .toggle), (center.nextTrackCommand, .next),
                (center.previousTrackCommand, .previous)]
            var removals: [() -> Void] = commands.map { command, semantic in
                let token = command.addTarget { [weak self] _ in
                    self?.receive(semantic) ?? .commandFailed
                }
                return { command.removeTarget(token) }
            }
            let command = center.changePlaybackPositionCommand
            let token = command.addTarget { [weak self] event in
                guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
                return self?.receive(.seek(event.positionTime)) ?? .commandFailed
            }
            removals.append { command.removeTarget(token) }
            return removals
        }
        center.skipForwardCommand.isEnabled = false
        center.skipBackwardCommand.isEnabled = false
        center.seekForwardCommand.isEnabled = false
        center.seekBackwardCommand.isEnabled = false
        setCommandsEnabled(currentTrackId != nil)
    }

    private func receive(_ command: PlaybackCommand) -> MPRemoteCommandHandlerStatus {
        // Acknowledgement follows actual main-thread acceptance, never an
        // optimistic success for a weak nil owner or merely queued work.
        let receivedAt = ProcessInfo.processInfo.systemUptime
        let accept: () -> PlaybackCommandResult = { [weak self] in
            self?.onCommand?(command, receivedAt) ?? .unavailable
        }
        let result = Thread.isMainThread ? accept() : DispatchQueue.main.sync(execute: accept)
        switch result {
        case .accepted: return .success
        case .noContent: return .noSuchContent
        case .invalid, .unavailable: return .commandFailed
        }
    }

    private func setCommandsEnabled(_ enabled: Bool) {
        let center = MPRemoteCommandCenter.shared()
        let commands: [MPRemoteCommand] = [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
            center.nextTrackCommand, center.previousTrackCommand, center.changePlaybackPositionCommand]
        commands.forEach { $0.isEnabled = enabled }
        // Pause stays enabled for pending/buffering Play, not only rendering.
    }

    func teardownRemoteCommands() { registration.removeAll() }

    func debugState() -> [String: Any] {
        let current = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        return [
            "revision": publication.revision, "publisher": publication.publisher,
            "publishedAt": publication.publishedAt, "registrationCount": registration.count,
            "suppressedTicks": publication.suppressedTicks, "staleArtwork": publication.staleArtwork,
            "assignedTrackId": publication.snapshot?.trackId ?? "",
            "assignedEntryId": publication.snapshot?.entryId ?? "",
            "assignedRate": publication.snapshot?.rate ?? 0,
            "assignedElapsed": publication.snapshot?.position ?? 0,
            "assignedDefaultRate": publication.snapshot?.defaultRate ?? 0,
            "readableRate": current[MPNowPlayingInfoPropertyPlaybackRate] ?? NSNull(),
            "readableElapsed": current[MPNowPlayingInfoPropertyElapsedPlaybackTime] ?? NSNull(),
            "readableDefaultRate": current[MPNowPlayingInfoPropertyDefaultPlaybackRate] ?? NSNull(),
            "readableTrackId": current[MPNowPlayingInfoPropertyExternalContentIdentifier] ?? "",
            "cleared": cleared]
    }

    func update(track: NativeTrack?, queueCount: Int, position: Double, playing: Bool, speed: Double, duration: Double, publisher: String = "state") {
        precondition(Thread.isMainThread)
        guard let track = track else {
            currentTrackId = nil
            lastInfo = [:]
            cachedArtwork = nil
            artworkTrackId = nil
            artworkGuard = ArtworkRequestGuard()
            cleared = true
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            setCommandsEnabled(false)
            if publication.publish(nil, publisher: publisher, now: ProcessInfo.processInfo.systemUptime) {
                publicationSink?(debugState())
            }
            return
        }

        cleared = false
        currentTrackId = track.trackId
        setCommandsEnabled(true)
        let snapshot = NowPlayingPublication.Snapshot(trackId: track.trackId,
            entryId: track.queueEntryId ?? "", position: position, playing: playing, speed: speed)
        var info = lastInfo
        info[MPMediaItemPropertyTitle] = track.title
        info[MPMediaItemPropertyArtist] = track.artist
        info[MPMediaItemPropertyAlbumTitle] = track.album
        info[MPMediaItemPropertyPlaybackDuration] = duration > 0 ? duration : track.duration
        info[MPNowPlayingInfoPropertyExternalContentIdentifier] = track.trackId
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = snapshot.position
        info[MPNowPlayingInfoPropertyPlaybackRate] = snapshot.rate
        info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = snapshot.defaultRate
        info[MPNowPlayingInfoPropertyPlaybackQueueIndex] = track.index
        info[MPNowPlayingInfoPropertyPlaybackQueueCount] = queueCount

        if let artwork = cachedArtwork, artworkTrackId == track.trackId {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: artwork.size) { _ in artwork }
        } else {
            info[MPMediaItemPropertyArtwork] = nil
        }

        lastInfo = info
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        if publication.publish(snapshot, publisher: publisher, now: ProcessInfo.processInfo.systemUptime) {
            publicationSink?(debugState())
        }

        if let coverUrl = track.coverUrl, coverUrl.isFileURL == false, coverUrl.scheme != "blob", artworkTrackId != track.trackId {
            // Backoff gate: a recently failed id waits out its exponential
            // window before the next attempt (the spam fix — see the map
            // comments). Every other path (success, new track, guard) is
            // unchanged.
            if let retryAt = artworkFailureRetryAt[track.trackId], Date() < retryAt {
                return
            }
            guard !artworkInFlight.contains(track.trackId) else { return }
            artworkGuard.request(track.trackId)
            fetchArtwork(trackId: track.trackId, url: coverUrl)
        }
    }

    private func fetchArtwork(trackId: String, url: URL) {
        artworkInFlight.insert(trackId)
        self.event(.debug, "artwork fetch start \(trackId)")
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self else { return }
            guard let data = data, let image = UIImage(data: data) else {
                // Latch the failure on main: backoff schedule + one log per
                // ATTEMPT CAP (the hundreds-of-entries spam was one log per
                // 250 ms tick; now one per attempt, attempts spacing out to
                // 60 s).
                DispatchQueue.main.async {
                    self.artworkInFlight.remove(trackId)
                    let attempt = (self.artworkFailureAttempt[trackId] ?? 0) + 1
                    self.artworkFailureAttempt[trackId] = attempt
                    let backoff = min(
                        Self.artworkBackoffCapSeconds,
                        Self.artworkBackoffBaseSeconds * pow(2.0, Double(attempt - 1)))
                    self.artworkFailureRetryAt[trackId] = Date().addingTimeInterval(backoff)
                    self.event(.info, "artwork fetch failed (no decodable image) \(trackId) attempt \(attempt) — retry in \(Int(backoff)) s")
                }
                return
            }
            DispatchQueue.main.async {
                self.artworkInFlight.remove(trackId)
                self.artworkFailureRetryAt[trackId] = nil
                self.artworkFailureAttempt[trackId] = nil
                // Drop out-of-order completions (older fetch finishing last) and
                // completions for a track that is no longer current (TODO 4.4).
                guard self.publication.permitsArtwork(trackId: trackId),
                      let currentTrackId = self.currentTrackId,
                      self.artworkGuard.shouldApply(completedTrackId: trackId, currentTrackId: currentTrackId) else {
                    // The guard WORKING is expected churn, not a fault (2026-09-21
                    // ring hygiene): rapid track changes fire several completions
                    // that all correctly lose to the newer request — the 1.2.29
                    // dump showed these as danger-spam drowning the ring.
                    // info-level, and deduped per completed id so a burst of
                    // loses for the same stale fetch logs once. A drop that
                    // left NO artwork applied while one was wanted would be a
                    // real fault — the `artwork applied` info line (or its
                    // absence) on the winning fetch is the verifiable signal.
                    if self.lastDroppedArtworkId != trackId {
                        self.lastDroppedArtworkId = trackId
                        self.event(.info, "artwork completion dropped by guard (completed=\(trackId) current=\(self.currentTrackId ?? "nil")) — superseded, info")
                    }
                    return
                }
                self.lastDroppedArtworkId = nil
                self.event(.debug, "artwork applied \(trackId)")
                self.cachedArtwork = image
                self.artworkTrackId = trackId
                // Re-apply now playing info so the artwork appears on the lock screen.
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    self.lastInfo = info
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                    self.publication.publish(self.publication.snapshot, publisher: "artwork", now: ProcessInfo.processInfo.systemUptime)
                    self.publicationSink?(self.debugState())
                }
            }
        }.resume()
    }
}
