import Foundation

/// File name lives at FILE scope on purpose: the handler below is a C
/// function pointer, and a C-function-pointer closure cannot capture context
/// — referencing enum members from inside it is exactly that (CI: "a C
/// function pointer cannot be formed from a closure that captures context").
/// Globals are statically resolved, so they are safe to use in the handler.
private let crashBreadcrumbFile = "mmdrome-crash-breadcrumb"

/// Last-launch crash breadcrumb. An NSException during the previous run (the
/// 1.2.13/1.2.14 graph crashes were both `objc_exception_throw`) leaves a
/// small text file in Caches; the engine's init reads and clears it and
/// `debugState()` surfaces it, so a crash-on-play report reaches the Debug
/// HUD without the user exporting a .ips file.
///
/// Scope is deliberately narrow: NSSetUncaughtExceptionHandler catches ObjC
/// exceptions only — Swift fatalErrors and plain abort() do not route through
/// it, and async-signal-unsafe file writes from a signal handler are not
/// worth the risk. Best-effort by design: a failed write under crash
/// conditions simply loses the breadcrumb.
enum CrashBreadcrumb {
    private static var fileURL: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appendingPathComponent(crashBreadcrumbFile)
    }

    /// Reads and deletes the previous run's breadcrumb (nil when none).
    /// Never throws — a missing or unreadable file is the no-crash case.
    static func readAndClear() -> String? {
        let text = try? String(contentsOf: fileURL, encoding: .utf8)
        try? FileManager.default.removeItem(at: fileURL)
        return (text?.isEmpty ?? true) ? nil : text
    }

    /// Installs the uncaught-exception hook. Safe to call once at engine init.
    /// The closure captures nothing: the path constant is a file-scope global
    /// and the directory is resolved inside the handler.
    static func installHook() {
        NSSetUncaughtExceptionHandler { exception in
            let stack = exception.callStackSymbols.prefix(12).joined(separator: "\n")
            let text = "\(exception.name.rawValue): \(exception.reason ?? "-")\n\(stack)"
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            try? text.write(
                to: caches.appendingPathComponent(crashBreadcrumbFile),
                atomically: true,
                encoding: .utf8
            )
        }
    }
}
