import Foundation

/// Reject server/login documents before they enter audio or resume storage.
/// Missing and generic MIME types remain valid: many music servers use them.
public enum AudioResponsePolicy {
    public static let errorDomain = "mmdrome.response"
    public static let stopQueueKey = "stopQueue"

    public static func rejection(status: Int, contentType: String?, prefix: Data = Data(), contentRangeStart: Int64? = nil) -> NSError? {
        let mime = (contentType ?? "").split(separator: ";").first?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let text = String(decoding: prefix.prefix(512), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{feff}")))
            .lowercased()
        // A Range remainder starts inside compressed audio: its first bytes
        // are not a file signature and can legitimately resemble JSON/HTML.
        let inspectPrefix = status != 206 || contentRangeStart == 0
        let document = mime.hasPrefix("text/") || mime.contains("json") || mime.contains("xml")
            || (inspectPrefix && (text.hasPrefix("<!doctype html") || text.hasPrefix("<html")
            || text.hasPrefix("<?xml") || text.hasPrefix("<subsonic-response")
            || text.hasPrefix("{") || text.hasPrefix("[")))
        guard (status != 200 && status != 206) || document else { return nil }
        // A missing song may advance after bounded retries; authentication,
        // throttling and server documents cannot be repaired by skipping songs.
        let stop = status == 401 || status == 403 || status == 429 || status >= 500 || ((status == 200 || status == 206) && document)
        let reason = document ? "Server returned a document instead of audio" : "Audio request failed"
        return NSError(domain: errorDomain, code: status, userInfo: [
            NSLocalizedDescriptionKey: "\(reason) (HTTP \(status)). Check the music server connection and sign-in, then press Play.",
            stopQueueKey: stop,
        ])
    }

    public static func stopsQueue(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == errorDomain && ns.userInfo[stopQueueKey] as? Bool == true
    }
}
