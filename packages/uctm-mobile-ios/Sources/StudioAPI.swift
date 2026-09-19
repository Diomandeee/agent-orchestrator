import Foundation
import Security

struct StudioConnection: Codable, Equatable {
    var host: String
    var port: Int
    var secure: Bool

    var baseURL: URL {
        URL(string: "\(secure ? "https" : "http")://\(host):\(port)")!
    }

    static func validated(host rawHost: String, port: Int, secure: Bool) throws -> StudioConnection {
        let host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard (1...65535).contains(port), !host.isEmpty,
              !host.contains("://"), !host.contains("/"), !host.contains("@"),
              !host.contains("?"), !host.contains("#"), !host.contains(":") else {
            throw StudioError.invalidAddress
        }
        // The bearer secret must never be sent over cleartext to an arbitrary host.
        if !secure && !Self.isPrivateHost(host) {
            throw StudioError.untrustedCleartextHost
        }
        return StudioConnection(host: host, port: port, secure: secure)
    }

    private static func isPrivateHost(_ host: String) -> Bool {
        if host.hasSuffix(".local") { return true }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        return octets[0] == 10 ||
            (octets[0] == 172 && (16...31).contains(octets[1])) ||
            (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 169 && octets[1] == 254)
    }
}

struct PairingCode: Decodable {
    let v: Int
    let host: String
    let port: String
    let password: String?
    let secure: Bool?

    init(from decoder: Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        v = try box.decode(Int.self, forKey: .v)
        host = try box.decode(String.self, forKey: .host)
        if let text = try? box.decode(String.self, forKey: .port) {
            port = text
        } else {
            port = String(try box.decode(Int.self, forKey: .port))
        }
        password = try box.decodeIfPresent(String.self, forKey: .password)
        secure = try box.decodeIfPresent(Bool.self, forKey: .secure)
    }

    private enum CodingKeys: String, CodingKey { case v, host, port, password, secure }

    static func parse(_ text: String) throws -> (StudioConnection, String) {
        let code = try JSONDecoder().decode(PairingCode.self, from: Data(text.utf8))
        guard code.v == 1, let port = Int(code.port) else { throw StudioError.invalidPairingCode }
        let connection = try StudioConnection.validated(host: code.host, port: port, secure: code.secure == true)
        return (connection, code.password ?? "")
    }
}

enum StudioError: LocalizedError {
    case invalidAddress, invalidPairingCode, untrustedCleartextHost, missingPassword
    case keychain(OSStatus)
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidAddress: return "Enter a valid host and port from UCTM Studio."
        case .invalidPairingCode: return "This is not a UCTM Studio pairing code."
        case .untrustedCleartextHost: return "Unencrypted pairing is allowed only on a private LAN. Use secure Tailscale pairing for other hosts."
        case .missingPassword: return "Enter the connection password shown in UCTM Studio."
        case let .keychain(status):
            // A build without a Keychain entitlement (an unsigned or
            // simulator-only build) fails here with a bare OSStatus; saying
            // "Studio returned -34018" blamed the wrong machine.
            let reason = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return "This build could not use the iPhone's Keychain (\(reason)). Install a signed build of UCTM, then pair again."
        case let .server(status, message): return "Studio returned \(status): \(message)"
        }
    }
}

struct StudioProject: Decodable, Identifiable {
    let id: String
    let name: String
    let path: String?
    let kind: String?
}

/// A pull-request fact attached to a session by the daemon's board read model.
struct StudioPR: Decodable {
    let url: String?
    let number: Int?
    let state: String?
    let ci: String?
    let review: String?
    let mergeability: String?
}

/// The daemon's activity read model: a coarse state plus when it last moved.
struct StudioActivity: Decodable {
    let state: String?
    let lastActivityAt: String?
}

struct StudioSession: Decodable, Identifiable {
    let id: String
    let projectId: String
    let issueId: String?
    let issueTitle: String?
    let userPrompt: String?
    let summary: String?
    let kind: String?
    let harness: String?
    let displayName: String?
    let mode: String?
    let status: String?
    /// A server-computed attention bucket, when the server sends one. This
    /// daemon does not today (the wire type carries no such field), but the AO
    /// app defers to it when present, so the port decodes it rather than
    /// agreeing with the phone only by coincidence.
    let attentionLevel: String?
    let isTerminated: Bool?
    let isPinned: Bool?
    let branch: String?
    let previewUrl: String?
    let createdAt: String?
    let updatedAt: String?
    let activity: StudioActivity?
    let prs: [StudioPR]?

    var title: String { sessionTitle(self) }

    /// When this session last moved, across the fields the daemon may populate.
    var lastActivityAt: String? { activity?.lastActivityAt ?? updatedAt ?? createdAt }

    var isOrchestrator: Bool { kind == "orchestrator" }
}

/// The daemon's `/api/v1/sessions` and `/api/v1/orchestrators` share one shape.
private struct SessionsResponse: Decodable { let sessions: [StudioSession] }

struct StudioMessage: Decodable, Identifiable {
    let id: String
    let role: String
    let text: String
    let kind: String
}

private struct ProjectsResponse: Decodable { let projects: [StudioProject] }
private struct ConversationResponse: Decodable { let messages: [StudioMessage] }
private struct ErrorResponse: Decodable { let message: String? }

final class StudioAPI {
    let connection: StudioConnection
    private let password: String
    private let session: URLSession

    init(connection: StudioConnection, password: String, session: URLSession = .shared) {
        self.connection = connection
        self.password = password
        self.session = session
    }

    private func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        guard !password.isEmpty else { throw StudioError.missingPassword }
        var request = URLRequest(url: connection.baseURL.appending(path: path))
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 12
        request.setValue("Bearer \(password)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw StudioError.server(0, "No HTTP response") }
        guard (200...299).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data).message) ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw StudioError.server(http.statusCode, message)
        }
        return data
    }

    func projects() async throws -> [StudioProject] {
        let data = try await request("api/v1/projects")
        return try JSONDecoder().decode(ProjectsResponse.self, from: data).projects
    }

    func sessions() async throws -> [StudioSession] {
        let data = try await request("api/v1/sessions")
        return try JSONDecoder().decode(SessionsResponse.self, from: data).sessions
    }

    /// Orchestrator sessions across projects, from the same read model as the
    /// board — this is what gives the phone the AO orchestrator surface.
    func orchestrators() async throws -> [StudioSession] {
        let data = try await request("api/v1/orchestrators")
        return try JSONDecoder().decode(SessionsResponse.self, from: data).sessions
    }

    func messages(sessionID: String) async throws -> [StudioMessage] {
        let id = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        let data = try await request("api/v1/sessions/\(id)/conversation")
        return try JSONDecoder().decode(ConversationResponse.self, from: data).messages
            .filter { $0.kind == "message" }
    }

    func send(text: String, sessionID: String) async throws {
        let id = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        let body = try JSONSerialization.data(withJSONObject: ["text": text, "clientMessageId": UUID().uuidString])
        _ = try await request("api/v1/sessions/\(id)/conversation/messages", method: "POST", body: body)
    }

    /// Deliver a line to a live terminal session, the equivalent of typing into
    /// its terminal in Studio. Used for orchestrator and TUI-mode sessions,
    /// which have no chat controller to send conversation messages to.
    func steer(text: String, sessionID: String) async throws {
        let id = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        let body = try JSONSerialization.data(withJSONObject: ["message": text])
        _ = try await request("api/v1/sessions/\(id)/send", method: "POST", body: body)
    }
}

enum ConnectionStorage {
    private static let hostKey = "uctm.studio.connection.v1"
    private static let keychainService = "com.mohameddiomande.uctmstudio.mobile"
    private static let passwordAccount = "studio-mobile-password"

    static func load() -> (StudioConnection, String)? {
        guard let data = UserDefaults.standard.data(forKey: hostKey),
              let connection = try? JSONDecoder().decode(StudioConnection.self, from: data),
              let password = readPassword(), !password.isEmpty else { return nil }
        return (connection, password)
    }

    static func save(_ connection: StudioConnection, password: String) throws {
        guard !password.isEmpty else { throw StudioError.missingPassword }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: keychainService,
                                    kSecAttrAccount as String: passwordAccount]
        SecItemDelete(query as CFDictionary)
        var write = query
        write[kSecValueData as String] = Data(password.utf8)
        write[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(write as CFDictionary, nil)
        guard status == errSecSuccess else { throw StudioError.keychain(status) }
        UserDefaults.standard.set(try JSONEncoder().encode(connection), forKey: hostKey)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: hostKey)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: keychainService,
                                    kSecAttrAccount as String: passwordAccount]
        SecItemDelete(query as CFDictionary)
    }

    private static func readPassword() -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: keychainService,
                                    kSecAttrAccount as String: passwordAccount,
                                    kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
