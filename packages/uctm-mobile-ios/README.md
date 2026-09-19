# UCTM Mobile (iPhone)

Separate first-party iPhone companion for UCTM Studio. Bundle ID
`com.mohameddiomande.uctmstudio.mobile`; it does not replace the installed AO
app or subscribe to AO's Expo/TestFlight updates.

The app scans Studio's Connect Mobile QR code (or accepts manual host, port,
and password), probes the authenticated mobile bridge before storing the
connection, and then drives the same sessions the desktop app shows. The bearer
secret is kept in the iPhone Keychain. Cleartext connections are accepted only
for private LAN addresses; remote pairing requires HTTPS.

This is a thin client: the Studio daemon, models, evidence/context gates, and
task execution remain on the Mac. The app does not run agents on-device.

## Screens

The app is three tabs, mirroring the AO phone app and the desktop board:

- **Agents** — the board. A working/need-you/mergeable summary, then sessions
  grouped into desktop's four zones (Needs you, Ready to merge, Working, In
  review), with the archive collapsed underneath. A project menu filters the
  board to one project.
- **Orchestrator** — one card per project: lifecycle state (Not started /
  Stopped / Running), a link into the orchestrator session, and worker counts
  by attention zone. This is the surface the phone was missing.
- **Settings** — the live connection (host, transport), refresh, and the
  disconnect-and-pair-again path.

Session rows read the same way as desktop: the same title chain
(`displayName ?? issueId ?? issueTitle ?? userPrompt ?? summary ?? id` — only
the first two rungs and the id are populated today), the same status
vocabulary, and the same branch line. Chat sessions open a durable transcript
you can reply into; terminal (TUI) sessions accept a line into their terminal
over `POST /api/v1/sessions/{id}/send`.

Those rules live in `Sources/SessionBoard.swift`, a pure port of the AO app's
`lib/sessionStatus.ts` / `lib/agentsView.ts` / `lib/orchestratorView.ts`, so the
two apps cannot drift apart without a test failing. The port mirrors the phone's
source rather than its current behaviour, including paths the daemon does not
exercise yet: a server-supplied `attentionLevel` wins over recomputation (and
`action` is a real level reachable only that way), and the title chain walks all
five candidates. Those were found by review, not by running the app, and are
pinned by fixtures — see `MOBILE_PORT_LINEAGE_2026-09-19.md` in `docs/uctm`.

## Build and run

```bash
xcodegen generate
xcodebuild test -project UCTMMobile.xcodeproj -scheme UCTMMobile \
  -destination 'platform=iOS Simulator,name=<a booted iPhone>'
```

Open UCTM Studio's Connect Mobile settings and enable its authenticated bridge
before pairing. The old AO TestFlight link is not a download link for this app.

Sign for the Keychain. A build with code signing disabled (for example
`CODE_SIGNING_ALLOWED=NO`) cannot write the pairing secret and will report a
Keychain failure instead of pairing.

## Live checks

Two tests are opt-in because they need a running Studio, and they are the
end-to-end receipt that the phone can reach the Mac:

```bash
TEST_RUNNER_UCTM_LIVE_PAIRING="<lan-host>:<port>:<password>" xcodebuild test \
  -project UCTMMobile.xcodeproj -scheme UCTMMobile \
  -destination 'platform=iOS Simulator,name=<a booted iPhone>'
```

Use the host, port and password Studio shows in Settings → Connect Mobile.

- `LiveConnectionTests` drives the app's real client through the pairing gate,
  Bearer auth and `/api/v1/{projects,sessions,orchestrators}` reads, and decodes
  a live chat transcript.
- `PairingJourneyTests` does the same through the UI: disconnect (if already
  paired), type the address and password, Connect, and assert all three tabs
  open. It attaches a screenshot of each tab to the result bundle.

Without `UCTM_LIVE_PAIRING` both skip, so CI never depends on a reachable Mac.
