import Foundation
import MediaPlayer
import UIKit

/// Native lock-screen / control-center integration:
/// - Publishes now playing metadata (title, artist, album, artwork, position) to
///   MPNowPlayingInfoCenter.
/// - Wires MPRemoteCommandCenter actions (play/pause/toggle/next/previous/seek)
///   to the audio engine.
final class NowPlayingController {

    var onPlayPause: (() -> Void)?
    var onNext: (() -> Void)?
    var onPrevious: (() -> Void)?
    var onToggle: (() -> Void)?
    var onSeek: ((Double) -> Void)?

    private var cachedArtwork: UIImage?
    private var artworkTrackId: String?
    private var lastInfo: [String: Any] = [:]

    func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            self?.onPlayPause?()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.onPlayPause?()
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

    func update(track: NativeTrack?, queueCount: Int, position: Double, playing: Bool, speed: Double) {
        guard let track = track else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }

        var info = lastInfo
        info[MPMediaItemPropertyTitle] = track.title
        info[MPMediaItemPropertyArtist] = track.artist
        info[MPMediaItemPropertyAlbumTitle] = track.album
        info[MPMediaItemPropertyPlaybackDuration] = track.duration
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
            fetchArtwork(trackId: track.trackId, url: coverUrl)
        }
    }

    private func fetchArtwork(trackId: String, url: URL) {
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self,
                  let data = data,
                  let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
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
