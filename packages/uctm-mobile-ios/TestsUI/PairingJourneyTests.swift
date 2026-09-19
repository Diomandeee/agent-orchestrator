import XCTest

/// The real user journey: open the app unpaired, type the Studio address and
/// password from Settings → Connect Mobile, and land on the session board.
///
/// Opt-in for the same reason as `LiveConnectionTests`: it needs a running
/// Studio. Run it with `TEST_RUNNER_UCTM_LIVE_PAIRING=host:port:password`
/// alongside `xcodebuild test`.
final class PairingJourneyTests: XCTestCase {

    private func liveConfiguration() throws -> (host: String, port: String, password: String) {
        guard let raw = ProcessInfo.processInfo.environment["UCTM_LIVE_PAIRING"], !raw.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_UCTM_LIVE_PAIRING=host:port:password to run the pairing journey")
        }
        let parts = raw.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3 else {
            XCTFail("UCTM_LIVE_PAIRING must be host:port:password")
            throw XCTSkip("malformed UCTM_LIVE_PAIRING")
        }
        return (String(parts[0]), String(parts[1]), String(parts[2]))
    }

    override func setUp() {
        continueAfterFailure = false
    }

    func testPairingLandsOnTheSessionBoard() throws {
        let config = try liveConfiguration()

        let app = XCUIApplication()
        app.launch()

        // A simulator keeps its Keychain across reinstalls, so a previous run
        // leaves the phone paired. Walk back through Disconnect rather than
        // depending on a clean device — it exercises that path too.
        let settingsTabOnLaunch = app.tabBars.buttons["Settings"]
        if settingsTabOnLaunch.waitForExistence(timeout: 12) {
            settingsTabOnLaunch.tap()
            let disconnect = app.buttons["Disconnect and pair again"]
            XCTAssertTrue(disconnect.waitForExistence(timeout: 10), "paired Settings screen had no Disconnect")
            disconnect.tap()
        }

        // iOS asks for local-network access on the first LAN call; without this
        // the request never completes and the board never appears.
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            for label in ["Allow", "OK", "Allow While Using App"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }

        let hostField = app.textFields["Host (e.g. 192.168.1.20)"]
        XCTAssertTrue(hostField.waitForExistence(timeout: 15), "pairing screen did not appear")
        hostField.tap()
        hostField.typeText(config.host)

        let portField = app.textFields["Port"]
        if portField.exists, portField.value as? String != config.port {
            portField.tap()
            portField.press(forDuration: 1.2)
            if app.menuItems["Select All"].exists { app.menuItems["Select All"].tap() }
            portField.typeText(config.port)
        }

        let passwordField = app.secureTextFields["Connection password"]
        XCTAssertTrue(passwordField.exists)
        passwordField.tap()
        passwordField.typeText(config.password)

        let connect = app.buttons["Connect"]
        // The keyboard can cover the last rows of the form.
        if !connect.isHittable { app.swipeUp() }
        XCTAssertTrue(connect.waitForExistence(timeout: 5))
        connect.tap()
        dismissSystemAlerts()

        let agentsTab = app.tabBars.buttons["Agents"]
        XCTAssertTrue(agentsTab.waitForExistence(timeout: 30), "pairing did not reach the session board")
        attach(name: "Agents board")

        openTab("Orchestrator", expecting: "Orchestrator", in: app)
        attach(name: "Orchestrator")

        openTab("Settings", expecting: "Settings", in: app)
        // The section header's static text is not always exposed; the row's
        // button is, and only exists on the paired Settings screen.
        XCTAssertTrue(app.buttons["Refresh now"].waitForExistence(timeout: 10), "settings screen had no rows")
        attach(name: "Settings")
    }

    /// Selects a tab, retrying around system alerts. A springboard alert that
    /// lands on top of the tab bar swallows the tap and leaves the previous tab
    /// selected, so a single tap is not enough on a device that is still asking
    /// whether to save the password.
    private func openTab(_ name: String, expecting navigationBar: String, in app: XCUIApplication) {
        let tab = app.tabBars.buttons[name]
        XCTAssertTrue(tab.waitForExistence(timeout: 10), "\(name) tab missing from the phone")
        for _ in 0..<3 {
            dismissSystemAlerts()
            tab.tap()
            if app.navigationBars[navigationBar].waitForExistence(timeout: 6) { return }
        }
        XCTFail("\(name) tab did not open")
    }

    private func attach(name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// iOS offers to save the typed password to iCloud Keychain over the app,
    /// and asks for local-network access. Both are springboard alerts, so they
    /// are invisible to `app.buttons` and must be cleared before the board can
    /// be reached.
    private func dismissSystemAlerts() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // Give a just-triggered alert a moment to appear before looking.
        _ = springboard.buttons.firstMatch.waitForExistence(timeout: 2)
        for label in ["Not Now", "Allow", "OK", "Allow While Using App"] {
            let button = springboard.buttons[label]
            if button.exists { button.tap() }
        }
    }
}
