import Foundation

/// Stable, process-independent identifiers (TODO 4.5a).
///
/// `String.hashValue` is SipHash-seeded per process, so using it for on-disk
/// cache filenames forced a full re-download every launch and orphaned every
/// previous launch's files. FNV-1a over the UTF-8 bytes is deterministic
/// across processes AND launches, and never traps on `abs(Int.min)` the way
/// the old `abs(hashValue)` did.
public enum StableID {

    /// FNV-1a (64-bit, offset basis 0xcbf29ce484222325, prime 0x100000001b3)
    /// over `string`'s UTF-8 bytes.
    public static func fnv1a64(_ string: String) -> UInt64 {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in string.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return hash
    }
}
