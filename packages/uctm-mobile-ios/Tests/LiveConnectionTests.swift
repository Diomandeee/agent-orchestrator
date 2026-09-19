import XCTest
@testable import UCTMMobile

/// Opt-in check that drives the app's real client against a real Studio daemon.
///
/// Set `UCTM_LIVE_PAIRING="host:port:password"` — the host, port and password
/// Studio shows in Settings → Connect Mobile — to run it. Without the variable
/// the test skips, so the default suite never depends on a Mac being reachable.
///
/// This is the end-to-end receipt for "the phone can connect": it uses the same
/// `StudioConnection.validated` gate, the same Bearer auth, and the same
/// `/api/v1/*` reads the app uses, against the LAN listener a phone reaches.
final class LiveConnectionTests: XCTestCase {

    private func liveConfiguration() throws -> (host: String, port: Int, password: String) {
        guard let raw = ProcessInfo.processInfo.environment["UCTM_LIVE_PAIRING"], !raw.isEmpty else {
            throw XCTSkip("Set UCTM_LIVE_PAIRING=host:port:password to run the live pairing check")
        }
        // maxSplits keeps a password that contains colons intact.
        let parts = raw.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3, let port = Int(parts[1]) else {
            XCTFail("UCTM_LIVE_PAIRING must be host:port:password")
            throw StudioError.invalidPairingCode
        }
        return (String(parts[0]), port, String(parts[2]))
    }

    func testLiveStudioServesTheContractThePhoneDependsOn() async throws {
        let config = try liveConfiguration()
        // Goes through the same address gate the pairing screen uses.
        let connection = try StudioConnection.validated(host: config.host, port: config.port, secure: false)
        let api = StudioAPI(connection: connection, password: config.password)

        let sessions = try await api.sessions()
        let projects = try await api.projects()
        let orchestrators = try await api.orchestrators()

        XCTAssertFalse(projects.isEmpty, "Studio returned no projects over the LAN bridge")

        // The board mapping must survive real daemon data, not just fixtures.
        let grouped = groupSessions(sessions)
        XCTAssertEqual(grouped.sections.flatMap(\.sessions).count + grouped.archived.count, sessions.count)
        XCTAssertTrue(orchestrators.allSatisfy(\.isOrchestrator), "orchestrator read returned a worker")

        // Chat transcript read + send-path shape, on a live chat session.
        if let chat = sessions.first(where: { $0.mode == "chat" && $0.isTerminated != true }) {
            let messages = try await api.messages(sessionID: chat.id)
            XCTAssertFalse(messages.isEmpty, "live chat session \(chat.id) returned no messages")
        }
    }

    // The unauthenticated path is deliberately not exercised here: the LAN
    // listener arms a five-failures-per-minute lockout, and a test suite must
    // not be able to lock the real phone out. It is checked with a single curl.
}
