/// User intent is not the player's observed rendering state. Buffering,
/// interruptions and engine failure may all stop rendering without a Pause.
/// Main-thread owned by the engine; no clocks, timers or platform APIs here.
public struct PlaybackControl: Equatable {
    public struct Lease: Equatable {
        public let session: UInt64
        public let revision: UInt64
    }

    public struct Source: Equatable {
        public let session: UInt64
        public let revision: UInt64
    }

    public private(set) var session: UInt64 = 0
    public private(set) var revision: UInt64 = 0
    public private(set) var desiredPlaying = false
    public private(set) var interrupted = false
    private var interruptionRevision: UInt64?
    private var sourceRevision: UInt64 = 0

    public init() {}
    public var lease: Lease { Lease(session: session, revision: revision) }
    public var mayRender: Bool { desiredPlaying && !interrupted }

    /// Automatic graph work cannot probe session ownership during a real
    /// interruption. Only a deliberate Play may prove a missing end stale.
    public func mayAttemptStart(explicitPlay: Bool) -> Bool {
        desiredPlaying && (!interrupted || explicitPlay)
    }

    /// A new occurrence/load owner (including a same-song replacement) voids
    /// old deliveries. Pause/Play alone do NOT throw away delivered bytes.
    public mutating func replace(playing: Bool) {
        session &+= 1
        request(playing: playing)
    }

    public mutating func request(playing: Bool) {
        revision &+= 1
        desiredPlaying = playing
    }

    public mutating func stop() { replace(playing: false) }

    /// Byte deliveries may still build a paused schedule for this session.
    public func ownsSession(_ lease: Lease) -> Bool { session == lease.session }

    /// Source ownership is separate from both intent and node scheduling.
    /// Seek/parameter reschedules and graph rebuilds keep the current bytes;
    /// starting a replacement load/epoch supersedes its callbacks.
    public mutating func beginSource() -> Source {
        sourceRevision &+= 1
        return Source(session: session, revision: sourceRevision)
    }

    public func ownsSource(_ source: Source) -> Bool {
        source.session == session && source.revision == sourceRevision
    }

    /// Timers/recovery actions require the EXACT accepted intent as well as
    /// the session. A Pause then Play must not revive an older retry owner.
    public func permits(_ lease: Lease) -> Bool { lease == self.lease && mayRender }

    public mutating func beginInterruption() {
        guard !interrupted else { return }
        interrupted = true
        interruptionRevision = revision
    }

    /// A newer explicit command wins over the interruption's snapshot. A
    /// denied automatic resume parks the old Play; a fresh explicit Play
    /// during the interruption remains eligible when the session returns.
    @discardableResult
    public mutating func endInterruption(shouldResume: Bool) -> Bool {
        guard interrupted else { return false }
        let unchanged = interruptionRevision == revision
        interrupted = false
        interruptionRevision = nil
        if unchanged && !shouldResume { request(playing: false) }
        return mayRender
    }

    /// Positive session-start evidence can clear a missing OS end edge, but
    /// never invents Play intent or changes a newer explicit Pause.
    public mutating func clearStaleInterruption() {
        interrupted = false
        interruptionRevision = nil
    }
}

public enum PlaybackCommand: Equatable {
    case play, pause, toggle, next, previous, seek(Double)

    public var name: String {
        switch self {
        case .play: return "play"
        case .pause: return "pause"
        case .toggle: return "toggle"
        case .next: return "next"
        case .previous: return "previous"
        case .seek: return "seek"
        }
    }
}

public enum PlaybackCommandResult: String {
    /// Accepted intent, NOT a promise that buffered audio is rendering yet.
    case accepted, noContent, unavailable, invalid
}

/// Both bridge and remote adapters use this interpreter, on main. Tests
/// inject effects into THIS production boundary, not a second controller.
public enum PlaybackCommandInterpreter {
    @discardableResult
    public static func perform(
        _ command: PlaybackCommand,
        hasContent: Bool,
        desiredPlaying: Bool,
        execute: (PlaybackCommand) -> Void,
        publish: () -> Void
    ) -> PlaybackCommandResult {
        if case .seek(let seconds) = command, !seconds.isFinite || seconds < 0 {
            return .invalid
        }
        guard hasContent else { return .noContent }
        let semantic: PlaybackCommand = command == .toggle
            ? (desiredPlaying ? .pause : .play) : command
        execute(semantic)
        // Includes idempotent commands and accepted-but-buffering Play.
        publish()
        return .accepted
    }
}
