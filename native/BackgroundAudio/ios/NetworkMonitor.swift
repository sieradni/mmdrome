import Foundation
import Network

/// Network path monitoring for low data mode (PR-C).
///
/// `NWPathMonitor` is the ONLY authoritative cellular/expensive signal an iOS
/// app can obtain: `isExpensive` is true on cellular (and metered hotspots),
/// `isConstrained` mirrors the user's system-wide Low Data Mode toggle. The
/// monitor owns its own queue; snapshots are published to the plugin via the
/// `onNetworkChanged` callback (JS `networkStateChanged` event) and answered
/// on demand through `getNetworkState`.
///
/// Thread-safety: `pathSnapshot` is written on the monitor's internal queue
/// and read on the main thread — the `_lock` guards the read-modify race.
final class NetworkMonitor {
    static let shared = NetworkMonitor()

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.mmdrome.network-monitor")
    private let lock = NSLock()
    private var _isExpensive = false
    private var _isConstrained = false
    private var _started = false

    /// Wired by the plugin at load(): emits on EVERY path update (including
    /// the initial one) so the JS side stays current without polling.
    var onNetworkChanged: ((_ isExpensive: Bool, _ isConstrained: Bool) -> Void)?

    private init() {}

    func startIfNeeded() {
        lock.lock()
        let alreadyStarted = _started
        lock.unlock()
        if alreadyStarted { return }
        lock.lock()
        _started = true
        lock.unlock()
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lock.lock()
            self._isExpensive = path.isExpensive
            self._isConstrained = path.isConstrained
            self.lock.unlock()
            // The handler runs on the monitor's queue; the plugin's JS bridge
            // notification must marshal to main like every other callback.
            let expensive = path.isExpensive
            let constrained = path.isConstrained
            DispatchQueue.main.async { [weak self] in
                self?.onNetworkChanged?(expensive, constrained)
            }
        }
        monitor.start(queue: queue)
    }

    var isExpensive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isExpensive
    }

    var isConstrained: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isConstrained
    }
}
