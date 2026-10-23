import Foundation

/// Values assigned to the system are evidence, not proof of its visible UI.
/// A single revision spans command/state/timer/artwork publishers.
public struct NowPlayingPublication {
    public struct Snapshot: Equatable {
        public let trackId: String
        public let entryId: String
        public let position: Double
        public let rate: Double
        public let defaultRate: Double

        public init(trackId: String, entryId: String, position: Double, playing: Bool, speed: Double) {
            self.trackId = trackId
            self.entryId = entryId
            self.position = position.isFinite ? max(0, position) : 0
            self.defaultRate = speed.isFinite && speed > 0 ? speed : 1
            self.rate = playing ? self.defaultRate : 0
        }
    }

    public private(set) var revision: UInt64 = 0
    public private(set) var snapshot: Snapshot?
    public private(set) var publisher = "none"
    public private(set) var publishedAt: Double = 0
    public private(set) var suppressedTicks = 0
    public private(set) var staleArtwork = 0

    public init() {}

    /// Returns whether this is a meaningful diagnostic edge. Timer position
    /// updates still publish, but never flood the retained control transcript.
    @discardableResult
    public mutating func publish(_ value: Snapshot?, publisher: String, now: Double) -> Bool {
        let old = snapshot
        let edge = publisher != "timer" || old?.trackId != value?.trackId
            || old?.entryId != value?.entryId || old?.rate != value?.rate
            || old?.defaultRate != value?.defaultRate
        revision &+= 1
        snapshot = value
        self.publisher = publisher
        publishedAt = now
        if !edge { suppressedTicks += 1 }
        return edge
    }

    /// Artwork completion patches only the CURRENT publication; it cannot
    /// restore a pre-Pause rate/position or resurrect metadata after clear.
    public mutating func permitsArtwork(trackId: String) -> Bool {
        guard snapshot?.trackId == trackId else {
            staleArtwork += 1
            return false
        }
        return true
    }
}

/// Owns all removeTarget closures. Setup is idempotent and teardown is
/// deterministic; tests inject registrations without MediaPlayer/UIKit.
public final class RemoteCommandRegistration {
    private var removals: [() -> Void] = []
    public var count: Int { removals.count }
    public init() {}

    public func install(_ register: () -> [() -> Void]) {
        guard removals.isEmpty else { return }
        removals = register()
    }

    public func removeAll() {
        let owned = removals
        removals = []
        owned.forEach { $0() }
    }

    deinit { removeAll() }
}
