/// Counts callbacks still owed by segments behind the rendering segment.
/// A segment appended AFTER the predecessor's dataConsumed callback has
/// already been handled must not add a phantom predecessor callback.
public struct StreamSegmentLedger {
    public private(set) var successors = 0
    public private(set) var finalConsumed = false
    public init() {}

    /// True when chaining supersedes a final callback already being deferred
    /// until its audible tail renders.
    @discardableResult
    public mutating func chain() -> Bool {
        if finalConsumed {
            finalConsumed = false
            return true
        }
        successors += 1
        return false
    }

    public mutating func consume() -> StreamSchedule.CompletionVerdict {
        if successors > 0 {
            successors -= 1
            return .segmentEnd
        }
        finalConsumed = true
        return .trackEnd
    }
}
