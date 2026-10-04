import Foundation
import AVFoundation
import BackgroundAudioCore

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
    /// True while an AVAudioSession interruption is in progress. The engine's
    /// recovery policy reads this (via `onInterruptionStateChanged` →
    /// `NativeAudioEngine.setInterruptionActive`): re-activating the session
    /// mid-interruption always fails, so the ladder waits instead of
    /// rebuilding or surfacing.
    private(set) var isInterrupted = false
    /// Fired whenever `isInterrupted` flips. The plugin mirrors it onto the
    /// engine; on the falling edge the engine also gets a fresh recovery run.
    var onInterruptionStateChanged: ((Bool) -> Void)?
    /// Fired on `mediaServicesWereReset` / `mediaServicesWereLost`: the audio
    /// services were torn down underneath the app and EVERY audio resource
    /// (session + AVAudioEngine graph) must be reinitialized. The plugin wires
    /// this to `NativeAudioEngine.rebuildAudioStack()` — without it the app
    /// kept a dead graph forever (the 2026-10-04 field bug).
    var onSessionInvalidated: (() -> Void)?
    /// The JS `iosAudioMixing` setting ('exclusive' | 'mix'). Unknown values
    /// fall back to exclusive — never fail a session activation over a typo.
    private var mixingMode = "exclusive"
    /// Block-observer tokens (TODO 4.5c) — block-based `addObserver` returns a
    /// token that must be retained or the registration can never be removed.
    private var observerTokens: [NSObjectProtocol] = []
    /// Diagnostic sink (2026-09-19): interruption/route/mixing decisions ride
    /// the engine's structured event log (domain "session", wired by the
    /// plugin) — these were previously fully silent, and a missed resume or a
    /// clobbered category is exactly the danger class the dump must verify.
    var eventSink: ((NativeEvent.Level, String) -> Void)?
    private func event(_ level: NativeEvent.Level, _ message: String) {
        eventSink?(level, message)
    }

    /// The greppable identity of an audio error: the raw NSError domain+code
    /// and, for OSStatus errors, the numeric status. `localizedDescription`
    /// ("The operation couldn't be completed") told a field dump NOTHING —
    /// the 2026-10-04 session failure printed only that, and the diagnosis
    /// had to be reconstructed from the Android-style OSStatus number.
    private func errorEvidence(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSOSStatusErrorDomain {
            return "[domain=\(ns.domain) code=\(ns.code) osstatus=0x\(String(ns.code, radix: 16))]"
        }
        return "[domain=\(ns.domain) code=\(ns.code)]"
    }

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
            self.event(.info, "setMixingMode → \(mode)")
        } catch {
            // Non-fatal: keep playing under the previous category.
            self.event(.danger, "setMixingMode \(mode) category/activate FAILED \(errorEvidence(error))")
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
            self.event(.danger, "configure category/activate FAILED (mode \(mixingMode)) \(errorEvidence(error)) — background may suspend")
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

        // Media services were RESET (the whole audio stack was torn down and
        // must be reinitialized) or LOST (temporarily gone). Both invalidate
        // the engine graph; the 2026-10-04 field bug was exactly this class of
        // event with NO handler, so the app kept a dead AVAudioEngine forever.
        observerTokens.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: session,
            queue: .main
        ) { [weak self] _ in
            self?.handleSessionInvalidated("mediaServicesWereReset")
        })

        observerTokens.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereLostNotification,
            object: session,
            queue: .main
        ) { [weak self] _ in
            self?.handleSessionInvalidated("mediaServicesWereLost")
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
            // Flip the interruption flag BEFORE pausing: the engine's recovery
            // policy keys on it, and a play() racing the pause must already see
            // "interrupted" so it waits instead of rebuilding a doomed graph.
            setInterrupted(true)
            self.event(.info, "interruption BEGAN wasPlaying=\(wasPlayingBeforeInterruption) → pause")
            onPause?()
        case .ended:
            setInterrupted(false)
            // Re-activate the session NOW. The interruption released it, and
            // the engine may have been left with an inactive session (the
            // 2026-10-04 dump: `setActive` failed with `'!ses'` and every
            // `engine.start()` then failed with -50 forever). This attempt is
            // best-effort; the engine's own ladder owns retries if it fails.
            reactivateSessionAfterInterruption()
            guard wasPlayingBeforeInterruption else {
                self.event(.info, "interruption ended wasPlaying=false → stay paused")
                break
            }
            let shouldResume = (info[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map { AVAudioSession.InterruptionOptions(rawValue: $0).contains(.shouldResume) } ?? false
            self.event(.info, "interruption ended shouldResume=\(shouldResume) → \(shouldResume ? "resume" : "stay paused")")
            if shouldResume {
                onResume?()
            }
        @unknown default:
            break
        }
    }

    /// Flip the interruption flag and notify exactly once per edge.
    private func setInterrupted(_ value: Bool) {
        guard isInterrupted != value else { return }
        isInterrupted = value
        onInterruptionStateChanged?(value)
    }

    /// One best-effort session re-activation after an interruption ends.
    private func reactivateSessionAfterInterruption() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: Self.categoryOptions(for: mixingMode))
            try session.setActive(true)
            self.event(.info, "interruption ended → session re-activated")
        } catch {
            self.event(.danger, "interruption ended → session re-activation FAILED \(errorEvidence(error))")
        }
    }

    /// The audio services were reset/lost: the session and the engine graph are
    /// both invalid. Re-point the session at our category, then hand off to the
    /// engine to rebuild (it owns the graph).
    private func handleSessionInvalidated(_ reason: String) {
        self.event(.danger, "\(reason) → audio services invalidated, rebuilding audio stack")
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: Self.categoryOptions(for: mixingMode))
        } catch {
            self.event(.danger, "\(reason) → setCategory FAILED \(errorEvidence(error))")
        }
        onSessionInvalidated?()
    }

    private func handleRouteChange(_ note: Notification) {
        guard let info = note.userInfo,
              let rawReason = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason) else { return }
        if reason == .oldDeviceUnavailable {
            self.event(.info, "route change oldDeviceUnavailable → pause")
            onPause?()
        } else {
            self.event(.debug, "route change reason=\(reason.rawValue) (no action)")
        }
    }
}
