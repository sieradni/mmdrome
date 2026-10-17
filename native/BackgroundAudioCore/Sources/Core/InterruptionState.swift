/// Duplicate notifications cannot erase resume intent or reactivate idle audio.
public struct InterruptionState {
    public private(set) var active = false
    public private(set) var wasPlaying = false
    public init() {}

    public mutating func begin(isPlaying: Bool) -> Bool {
        guard !active else { return false }
        active = true
        wasPlaying = isPlaying
        return true
    }

    public mutating func end(shouldResume: Bool) -> Bool {
        let resume = active && wasPlaying && shouldResume
        clear()
        return resume
    }

    public mutating func clear() {
        active = false
        wasPlaying = false
    }
}
