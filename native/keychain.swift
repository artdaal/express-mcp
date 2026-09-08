import Foundation
import Security
import AppKit

// One atomic Keychain item. No token arguments, logging, profile imports or dumps.
func respond(_ object: [String: Any], _ code: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object) { FileHandle.standardOutput.write(data) }
    exit(code)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 1048576,
      let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any],
      let operation = request["operation"] as? String else { respond(["ok": false], 1) }
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "io.github.express-mcp.express-sessiond",
    kSecAttrAccount as String: "auth-bundle-v1",
    kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail
]
if operation == "selfTest" {
    // Isolated disposable item: never read, overwrite or remove the auth bundle.
    let probe: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "io.github.express-mcp.express-sessiond.selftest",
        kSecAttrAccount as String: UUID().uuidString,
        kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    var create = probe
    create[kSecValueData as String] = Data("synthetic-first".utf8)
    create[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let added = SecItemAdd(create as CFDictionary, nil) == errSecSuccess
    let updated = added && SecItemUpdate(probe as CFDictionary, [kSecValueData as String: Data("synthetic-second".utf8)] as CFDictionary) == errSecSuccess
    var lookup = probe; lookup[kSecReturnData as String] = true; lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let read = updated && SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess && (result as? Data) == Data("synthetic-second".utf8)
    let removed = SecItemDelete(probe as CFDictionary) == errSecSuccess
    respond(["ok": added && updated && read && removed, "created": added, "updated": updated, "readback": read, "deleted": removed], added && updated && read && removed ? 0 : 1)
} else if operation == "openLogin", let value = request["url"] as? String,
   let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1" {
    respond(["ok": NSWorkspace.shared.open(url)])
} else if operation == "load" {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let code = SecItemCopyMatching(lookup as CFDictionary, &result)
    if code == errSecItemNotFound { respond(["ok": true, "value": NSNull()]) }
    guard code == errSecSuccess, let data = result as? Data,
          let object = try? JSONSerialization.jsonObject(with: data) else { respond(["ok": false], 1) }
    respond(["ok": true, "value": object])
} else if operation == "save", let value = request["value"] as? [String: Any],
          let data = try? JSONSerialization.data(withJSONObject: value) {
    let changes = [kSecValueData as String: data]
    var code = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
    if code == errSecItemNotFound {
        var create = query
        create[kSecValueData as String] = data
        create[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        code = SecItemAdd(create as CFDictionary, nil)
    }
    guard code == errSecSuccess else { respond(["ok": false], 1) }
    respond(["ok": true])
}
respond(["ok": false], 1)
