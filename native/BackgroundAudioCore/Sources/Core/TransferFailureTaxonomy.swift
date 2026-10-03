import Foundation

/// The IDENTITY of a failed transfer (2026-10-02e — the `cannot parse response`
/// root-cause work).
///
/// WHY this exists. Every transfer failure in the engine used to be logged as
/// `error.localizedDescription` alone. That is a LOCALIZED sentence: a dump
/// could not prove which error it was, only read a sentence that happens to
/// say `cannot parse response` on today's English OS. Nothing carried the
/// error's DOMAIN, its numeric CODE, or the UNDERLYING error that actually
/// caused a wrapped failure — and the open question ("is a repeated -1017
/// interface churn or a reverse-proxy keep-alive race?") cannot be answered
/// from a sentence. It needs a stable, greppable identity plus the time since
/// the last network transition (see `TransferCutCorrelation`).
///
/// The doc trail also drifted here: the 2026-09-23 transcode post-mortem named
/// `cannot parse response` as -1010, but -1010 is `NSURLErrorBadServerResponse`
/// and `cannot parse response` is `NSURLErrorCannotParseResponse` = **-1017**.
/// An identity that is asserted from memory is exactly what rots; this type
/// derives it from the `NSError` itself.
///
/// Pure, no clocks, no engine state — `swift test`-hostable (E5).
public struct TransferFailureInfo: Equatable, Sendable {
    public enum Kind: String, Sendable {
        /// `NSURLErrorCannotParseResponse` (-1017): the URL Loading System
        /// could not parse the response it received. The classic keep-alive
        /// race reads this way — a request sent on a connection the far end
        /// had already closed, or a body cut where a valid HTTP message could
        /// not be completed. A mid-body cut from local churn surfaces here too,
        /// which is precisely why the TIMING evidence decides between them.
        case cannotParseResponse
        /// -1005: the connection died under an established transfer.
        case connectionLost
        /// -1001.
        case timedOut
        /// -1009: no usable path when the request was attempted.
        case notConnected
        /// -1004.
        case cannotConnect
        /// -1003.
        case cannotFindHost
        /// -1006.
        case dnsLookupFailed
        /// -1010: the far end answered something the client rejected.
        case badServerResponse
        /// -1200 family / -1202: TLS.
        case secureConnectionFailed
        /// -999: URLSession cancelled the task (ours, or the system's).
        case cancelled
        /// One of our OWN gate rejections (`mmdrome.loader` -7001…-7004): a
        /// verdict about the BYTES, never a transport cut.
        case appVerdict
        /// A transport failure outside the enumerated codes.
        case otherTransport
        /// Not a URL Loading System failure at all.
        case other
    }

    public let domain: String
    public let code: Int
    /// The wrapped cause when the error carries one. Churn frequently surfaces
    /// as a high-level URLSession error wrapping a POSIX/CFNetwork failure, and
    /// the inner code is the one that actually names the cause.
    public let underlyingDomain: String?
    public let underlyingCode: Int?
    public let kind: Kind

    /// The CFNetwork error domain string (no Foundation constant exists).
    public static let cfNetworkDomain = "kCFErrorDomainCFNetwork"
    /// Our own loader/gate error domain.
    public static let appDomain = "mmdrome.loader"

    /// True for URL Loading System transport failures — the family interface
    /// churn and keep-alive races both produce. Our own gate rejections are
    /// NOT (they report what the bytes were, not how the transfer ended).
    public var isTransportFailure: Bool {
        domain == NSURLErrorDomain || domain == Self.cfNetworkDomain
    }

    /// One stable, greppable line for a failure log. Localized text is
    /// deliberately absent: it varies by OS language and version, and the
    /// point of the identity is that it does not.
    public var evidenceLine: String {
        var parts = ["err=\(domain)(\(code))", "kind=\(kind.rawValue)"]
        if let underlyingDomain, let underlyingCode {
            parts.append("under=\(underlyingDomain)(\(underlyingCode))")
        }
        return parts.joined(separator: " ")
    }

    /// Classify any thrown error. Never throws, never inspects localized text.
    public static func classify(_ error: Error) -> TransferFailureInfo {
        let ns = error as NSError
        let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError
        return TransferFailureInfo(
            domain: ns.domain,
            code: ns.code,
            underlyingDomain: underlying?.domain,
            underlyingCode: underlying?.code,
            kind: classifyKind(domain: ns.domain, code: ns.code))
    }

    /// The domain+code → kind map, split out so the vocabulary is pinnable in
    /// isolation (`swift test`) without constructing NSErrors.
    public static func classifyKind(domain: String, code: Int) -> Kind {
        if domain == appDomain { return .appVerdict }
        guard domain == NSURLErrorDomain else {
            return domain == cfNetworkDomain ? .otherTransport : .other
        }
        switch code {
        case NSURLErrorCannotParseResponse: return .cannotParseResponse
        case NSURLErrorNetworkConnectionLost: return .connectionLost
        case NSURLErrorTimedOut: return .timedOut
        case NSURLErrorNotConnectedToInternet: return .notConnected
        case NSURLErrorCannotConnectToHost: return .cannotConnect
        case NSURLErrorCannotFindHost: return .cannotFindHost
        case NSURLErrorDNSLookupFailed: return .dnsLookupFailed
        case NSURLErrorBadServerResponse: return .badServerResponse
        case NSURLErrorSecureConnectionFailed: return .secureConnectionFailed
        case NSURLErrorCancelled: return .cancelled
        default: return .otherTransport
        }
    }
}
