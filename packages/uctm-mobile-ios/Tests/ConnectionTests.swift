import XCTest
@testable import UCTMMobile

final class ConnectionTests: XCTestCase {
    func testStudioPairingCode() throws {
        let (connection, password) = try PairingCode.parse(#"{"v":1,"host":"192.168.1.23","port":3011,"password":"secret"}"#)
        XCTAssertEqual(connection.host, "192.168.1.23")
        XCTAssertEqual(connection.port, 3011)
        XCTAssertEqual(password, "secret")
    }

    func testRejectsCleartextPublicHost() {
        XCTAssertThrowsError(try StudioConnection.validated(host: "example.com", port: 3011, secure: false))
    }

    func testRejectsMalformedHostAndPort() {
        XCTAssertThrowsError(try StudioConnection.validated(host: "https://evil.example", port: 3011, secure: true))
        XCTAssertThrowsError(try StudioConnection.validated(host: "192.168.1.2", port: 0, secure: false))
    }

    func testRejectsWrongPairingVersion() {
        XCTAssertThrowsError(try PairingCode.parse(#"{"v":2,"host":"192.168.1.23","port":3011}"#))
    }

    /// Studio omits `secure` for plaintext LAN payloads so older clients can
    /// decode the same bytes, and adds it only for a Tailscale pairing.
    func testPairingCodeWithoutSecureKeyStaysCleartextOnAPrivateLAN() throws {
        let (connection, password) = try PairingCode.parse(#"{"v":1,"host":"172.20.10.12","port":3011,"password":"pIXKZAfU"}"#)
        XCTAssertFalse(connection.secure)
        XCTAssertEqual(connection.baseURL.absoluteString, "http://172.20.10.12:3011")
        XCTAssertEqual(password, "pIXKZAfU")
    }

    func testPairingCodeCarriesTheSecureTransportFlag() throws {
        let (connection, _) = try PairingCode.parse(
            #"{"v":1,"host":"100.84.118.106","port":3011,"password":"secret","secure":true}"#)
        XCTAssertTrue(connection.secure)
        XCTAssertEqual(connection.baseURL.absoluteString, "https://100.84.118.106:3011")
    }

    func testPortDecodesFromEitherAStringOrANumber() throws {
        let fromString = try PairingCode.parse(#"{"v":1,"host":"10.0.0.5","port":"3011"}"#)
        let fromNumber = try PairingCode.parse(#"{"v":1,"host":"10.0.0.5","port":3011}"#)
        XCTAssertEqual(fromString.0.port, 3011)
        XCTAssertEqual(fromNumber.0.port, 3011)
    }

    /// An unsigned build cannot reach the Keychain. That failure used to be
    /// reported as "Studio returned -34018", which blamed the Mac.
    func testKeychainFailuresBlameTheBuildNotStudio() {
        let message = StudioError.keychain(errSecMissingEntitlement).errorDescription ?? ""
        XCTAssertTrue(message.contains("Keychain"))
        XCTAssertFalse(message.contains("Studio returned"))
    }
}
