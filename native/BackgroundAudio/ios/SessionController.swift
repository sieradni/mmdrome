import Foundation
import AVFoundation

/// Manages the AVAudioSession for background playback (category `.playback`) and
/// reacts to interruptions (phone calls, Siri) and audio route changes
/// (headphones unplugged) by pausing playback.
///
/// Also owns the audio-sharing mode (Settings → Playback → Audio Mixing):
/// 'exclusive' takes over device audio (the historical behavior), 'mix' adds
/// `.mixWithOthers` so mmdrome plays alongside other apps. The mapping lives
/// in exactly ONE place (`categoryOptions(for:)`): both this controller and
/// `NativeAudioEngine.ensureEngineRunning` resolve through it, so an engine
/// restart can never silently clobber the user's choice back to exclusive.
/// System interruptions (calls/Siri) and route changes fire in every mode.
final class SessionController {
    private var onPause: (() -> Void)?
    private var onResume: (() -> Void)?
    private var isPlaying: () -> Bool = { false }
    private var wasPlayingBeforeInterruption = false
    /// The JS `iosAudioMixing` setting ('exclusive' | 'mix'). Unknown values
    /// fall back to exclusive — never fail a session activation over a typo.
    private var mixingMode = "exclusive"
    /// Block-observer tokens (TODO 4.5c) — block-based `addObserver` returns a
    /// token that must be retained or the registration can never be removed.
    private var observerTokens: [NSObjectProtocol] = []

    /// The single owner of the mode → category-options mapping.
    static func categoryOptions(for mixingMode: String) -> AVAudioSession.CategoryOptions {
        return mixingMode == "mix" ? [.mixWithOthers] : []
    }

    /// Applies a new sharing mode live (no restart needed): re-sets the
    /// category and re-activates the session. Called from the
    /// `setAudioMixing` bridge (and never from anywhere else).
    func setMixingMode(_ mode: String) {
        mixingMode = mode
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: Self.categoryOptions(for: mode))
            try session.setActive(true)
        } catch {
            // Non-fatal: keep playing under the previous category.
        }
    }

    func configure(onPause: @escaping () -> Void, onResume: @escaping () -> Void, isPlaying: @escaping () -> Bool) {
        self.onPause = onPause
        self.onResume = onResume
        self.isPlaying = isPlaying

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: Self.categoryOptions(for: mixingMode))
            try session.setActive(true)
        } catch {
            // Non-fatal: playback will work in foreground, background may be suspended.
        }

        observerTokens.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] note in
            self?.handleInterruption(note)
        })

        observerTokens.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: session,
            queue: .main
        ) { [weak self] note in
            self?.handleRouteChange(note)
        })
    }

    deinit {
        observerTokens.forEach { NotificationCenter.default.removeObserver($0) }
    }

    private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let rawType = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
        switch type {
        case .began:
            wasPlayingBeforeInterruption = isPlaying()
            onPause?()
        case .ended:
            guard wasPlayingBeforeInterruption else { break }
            let shouldResume = (info[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map { AVAudioSession.InterruptionOptions(rawValue: $0).contains(.shouldResume) } ?? false
            if shouldResume {
                onResume?()
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ note: Notification) {
        guard let info = note.userInfo,
              let rawReason = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason) else { return }
        if reason == .oldDeviceUnavailable {
            onPause?()
        }
    }
}
