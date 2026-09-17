import Foundation
import Security

/// Minimal Keychain CRUD for app credentials (2026-09-17). The JS layer
/// (`secureStore.ts`) routes the secret settings keys here through the
/// BackgroundAudio bridge instead of persisting them into IndexedDB, so a
/// backup/inspection of the WebView's storage no longer carries them.
///
/// Storage shape: generic passwords under one service string, account = the
/// JS key ("navidromePassword" etc.), value = the UTF-8 bytes of the
/// JSON-encoded setting. No entitlements are needed — an app's own keychain
/// items are private to it by default.
///
/// Accessibility is `kSecAttrAccessibleAfterFirstUnlock`: the scrobble flush
/// engine and the native background path run while the device may be locked,
/// and this class unlocks once after first unlock — the standard choice for
/// app credentials that background work must read.
enum KeychainStore {
    /// Namespaces every item this store writes. Keep in sync with the bundle
    /// id — items under this service are invisible to every other app.
    static let service = "com.mmdrome.player.credentials"

    static func get(key: String) throws -> String? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError(status: status)
        }
    }

    static func set(key: String, value: String) throws {
        let data = Data(value.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(baseQuery(key: key) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery(key: key)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw KeychainError(status: status)
        }
    }

    /// Deleting a missing item is success (idempotent — the JS delete paths
    /// clear both stores unconditionally).
    static func delete(key: String) throws {
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    private static func baseQuery(key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

struct KeychainError: LocalizedError {
    let status: OSStatus

    var errorDescription: String? {
        let message = SecCopyErrorMessageString(status, nil) as String?
        return "Keychain error \(status): \(message ?? "unknown")"
    }
}
