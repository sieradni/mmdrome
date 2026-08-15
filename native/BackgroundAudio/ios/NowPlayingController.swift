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

    var onPlay: (() -> Void)?
    var onPause: (() -> Void)?
    var onToggle: (() -> Void)?
    var onNext: (() -> Void)?
    var onPrevious: (() -> Void)?
    var onSeek: ((Double) -> Void)?

    private var cachedArtwork: UIImage?
    private var artworkTrackId: String?
    private var lastInfo: [String: Any] = [:]

    /// Tracks the latest artwork request so an out-of-order completion (an
    /// older fetch landing last, or a track change without a new request) can
    /// never stamp stale art over the current track (TODO 4.4).
    private var artworkGuard = ArtworkRequestGuard()
    /// The track the lock screen is currently showing (updated in `update`).
    private var currentTrackId: String?

    func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            self?.onPlay?()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.onPause?()
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.onToggle?()
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.onNext?()
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.onPrevious?()
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let positionEvent = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self?.onSeek?(positionEvent.positionTime)
            return .success
        }

        center.skipForwardCommand.isEnabled = false
        center.skipBackwardCommand.isEnabled = false
        center.seekForwardCommand.isEnabled = false
        center.seekBackwardCommand.isEnabled = false
    }

    func update(track: NativeTrack?, queueCount: Int, position: Double, playing: Bool, speed: Double, duration: Double) {
        guard let track = track else {
            currentTrackId = nil
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }

        currentTrackId = track.trackId
        var info = lastInfo
        info[MPMediaItemPropertyTitle] = track.title
        info[MPMediaItemPropertyArtist] = track.artist
        info[MPMediaItemPropertyAlbumTitle] = track.album
        info[MPMediaItemPropertyPlaybackDuration] = duration > 0 ? duration : track.duration
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? speed : 0
        info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = speed
        info[MPNowPlayingInfoPropertyPlaybackQueueIndex] = track.index
        info[MPNowPlayingInfoPropertyPlaybackQueueCount] = queueCount

        if let artwork = cachedArtwork, artworkTrackId == track.trackId {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: artwork.size) { _ in artwork }
        } else {
            info[MPMediaItemPropertyArtwork] = nil
        }

        lastInfo = info
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        if let coverUrl = track.coverUrl, coverUrl.isFileURL == false, coverUrl.scheme != "blob", artworkTrackId != track.trackId {
            artworkGuard.request(track.trackId)
            fetchArtwork(trackId: track.trackId, url: coverUrl)
        }
    }

    private func fetchArtwork(trackId: String, url: URL) {
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self,
                  let data = data,
                  let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                // Drop out-of-order completions (older fetch finishing last) and
                // completions for a track that is no longer current (TODO 4.4).
                guard let currentTrackId = self.currentTrackId,
                      self.artworkGuard.shouldApply(completedTrackId: trackId, currentTrackId: currentTrackId) else { return }
                self.cachedArtwork = image
                self.artworkTrackId = trackId
                // Re-apply now playing info so the artwork appears on the lock screen.
                if var info = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                    info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
            }
        }.resume()
    }
}
