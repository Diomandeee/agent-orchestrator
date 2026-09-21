# Fleet Handoff — 2026-09-21

Receiving agent: read this whole file before touching anything. It compresses a
full day of fleet + device-farm + distribution work across Mac1/Mac5/ASC.

## 1. Mission state

- **Consumer fleet: 49 apps**, release-ordered in `bridge/parks/fleet-app-*.json`
  (`wave` 1–3, `tier` TIER-1/2/3/MISSION, `status` active/parked).
- **Wave 1 (9, all active except FloorReport):** MotionMixApp, CreativeDirector,
  BodyBeat, FirstDate, IdeaGarden, LifeOS, Spore, MilkmanField, FloorReport.
- **Wave 2:** Aura, SecuriClaw, EternalSerenity, MeaningFullPower.
- **Wave 3:** the 36-app tail (list in §8).
- **Tracks (do NOT force into waves):** MISSION (NKo Keyboard/MathLab/Scribe —
  language mission), OPS (BWB suite, MilkMen ops, Ledger, RouteForge, Serenity
  Store), INFRA (AgentCommandCenter, Signal-proposed, FleetPaywallKit).
- Dropped/merged: SpeakFlow packet deleted, folded into VoiceAgent `related`.
  Pending approval: 9 listing retirements (DreamScape, VoicePilot, StageView,
  Stack, Pith, Rune, ShootView, StyleShoot, CaliLightsIOS) + new packets for
  Door, Encore, Parole, Signal + 12 shell reincarnations (Rune→Sigil Streaks,
  Stack→Setlists, StageView→Stage Mode, StyleShoot→First Look,
  ShootView→Proof, VoicePilot→Cue, CaliLights→365, Pods→Cypher Pods,
  SpeakReader→Listen, BitworkWorker→Shift, Direttore→House, Steep→90-Day
  Steep). None of this paragraph is packetized yet.
- Revenue model: free → 14-day trial → weekly sub (≥$7.48/wk) via shared
  FleetPaywallKit (blocked: extract from Spore) + print/cohort/ticket/audiobook
  attach. Five-number analytics everywhere.

## 2. Distribution lane (built, verified, UNCOMMITTED)

- Backend: `backend/internal/service/dist/` (git-IGNORED, like `bridge/dist/`
  queue data — deliberate, queue state never commits), controller
  `backend/internal/httpd/controllers/dist{,_test}.go`, routes wired in
  `backend/internal/httpd/api.go` + `backend/internal/daemon/daemon.go`, spec
  in `backend/internal/httpd/apispec/openapi.yaml` (+`specgen/build.go`),
  generated `frontend/src/api/schema.ts`.
- Endpoints: `GET /api/v1/dist/queue` → `{"items":[...]}`, `POST .../enqueue`,
  `PATCH .../items/{id}/status` (draft|scheduled only),
  `POST .../queue/reorder`, `POST .../webhooks` (HMAC-SHA256 via
  `X-DS-Signature` against `DIST_WEBHOOK_SECRET`, unsigned → 401).
- Frontend: `frontend/src/renderer/hooks/useDistQueue.ts` (unwraps `items` —
  that shape mismatch hid the lane for a day, see §6), board summary +
  per-card queue section in `FleetPanel/FleetCard`, `useDistQueue`,
  `DistQueueItem` in `lib/fleet.ts`, keys in all 8 locales.
- Statuses: draft|scheduled|posted|linked|failed. Providers: `farm` only.
  NO doublespeed integration by explicit user decision — their interface was
  reverse-engineered for shape only (recon in `/tmp/ds-recon/`, 10 page
  screenshots + endpoint map; user keeps the org link, do not re-auth).
- Verified: `go build ./...`, dist+controllers+parks tests pass; vitest
  uctm + i18n instance 38/38. Coverage gate fails ONLY on pre-existing
  `ConnectMobileContent.tsx:272` (fails on HEAD, not ours).
- Live proof: one `farm` draft item for fleet-app-firstdate in the queue.
- Daemon fragility: `:3001` runs `frontend/daemon/ao` under a managed session
  and DIES with it (twice observed). Rebuild: `npm run build:daemon -- --dev`.
  Restart: `cd frontend && ./daemon/ao daemon`. Tell the user when it dies.

## 3. App Store Connect (live, authed)

- `asc` CLI installed, authed as `studio` (key `26YT8HF7KR`, `.p8` at
  `~/.appstoreconnect/private_keys/`). 50 app records. Notables: Meaning Full
  Power, Serenity Soother + Eternal Serenity, MilkMan trio, BWB trio,
  11 surprise records (Floor Report, LineSkip City, CinemaWalk, ParkSight City,
  VisionClaw AI, NKo Bridge, Command Hub, Pane Viz/PaneView, Feed Deck Reader,
  Fleet Command HQ). Cross-check command: `asc apps list | python3 ...`.
- Skill: `ops:asc` (iris patterns, existing key ids, altool upload line).

## 4. Machine topology (verified live)

- Mac1 (this Air, `mohameddiomande`, 10.0.5.1): orchestrator + Studio dev.
  Disk CRITICAL 5.2G free. Load ~50 from syncthing + Notes thrash — user said
  kill NOTHING. HD5 (58G, 14G free, Codex sessions), HD2/HD4 mounted.
- Mac5 (Mini, `10.0.5.2`, alias `mac5-tb5`): healthy, fresh reboot 9/21,
  huge free disk, TD/Canonical work. SSH works post-login. Screen Sharing on.
- Mac4: MISSING. Not on any wire, Tailscale offline 2d. Do not claim contact.
- Network: Thunderbolt Mac1–Mac5 static 10.0.5.0/24 (restored 9/21, keep).
  "Ethernet Mac5–Mac4" cabled 9/20 actually loops Mac5–Mac1 (en13 =
  169.254.24.109 is Mac1 itself). Tunnels dead; VNC 5902 killed.
- GOTCHA (burned us): syncthing syncs `~/.ssh`, so any Mac accepts any Mac's
  key; both Airs share ComputerName "Mohamed's MacBook Air". Identity must come
  from interface MACs / ComputerName `Mac5`, never from key-auth or hostname
  alone. Known_hosts `mac5` entry was stale-cleared 9/20; `mac4` alias added.

## 5. Repo hygiene (hard lessons, obey them)

- Branch: `codex/uctm-interface-v0`. Another builder works here in parallel —
  coordinate, never `git add -A`.
- Locale files: ASCII escapes (`\u2192`) are ORIGINAL bytes; python
  `ensure_ascii=False` rewrites them → restore post-edit. Same for packets.
  Parity test requires every en key in all 8 locales with matching
  `{{placeholders}}`.
- Packets are 2-space JSON. Keep diffs surgical (3-line changes, not rewrites).
- `routeTree.gen.ts` is tracked: new routes need it committed alongside.
- Uncommitted lane batch + packet edits are the deliverable — commit as
  `uctm(dist-lane)` + `uctm(fleet-packets)` groups when user says commit.
  Never commit `bridge/dist/`, pycache, orient docs, or others' files.

## 6. Open threads for you

1. Commit lane + packet batches (user signal pending).
2. Daemon supervision (dies with sessions — propose launchd or user-owned start).
3. Compose UI for the queue (enqueue is API-only today).
4. 9 listing retirements + Door/Encore/Parole/Signal packets + 12 shell
   reincarnations (all approved-in-principle, none packetized).
5. 26 no-packet names triage (24 with disk code → packets; 7 vapor → verify).
6. Doublespeed pilot IF user reverses: one key, one app, 30 days (currently NO).
7. Mac1 triage (disk + syncthing/Notes) — offered, unanswered. Mac4 hunt.
8. Pre-existing failures to not own: landing vitest files, coverage gate line.

## 7. Wave 3 tails (36, directions assigned in chat 9/21 — encode on approval)

Photo trio→1 camera suite (StyleShoot survives); DreamScape→DreamStudio;
Drift+Pith+Stack→1 inbox; Steep→TrajectorySearch→LifeOS goals; VoicePilot→
VoiceAgent; StageView→KineticTheater; Glyph/Rune→mission; Ledger/RouteForge→
ops; Sway/Cadence/Timbre/Transpose/SkateForge→movement cluster feeders;
TeleprompterPro+Cue→recording pipeline; Torrent+ResearchBrowser→volumes
readers; Vesper+Dictum+DreamStudio→reflection suite; Vigil→SecuriClaw face;
Envoy→LifeOS outbox; Ember→streaks; Loom→CreativeDirector pre-pro;
CardForge+PrintWorlds→merch arm; PersonalSpanish→engine prototype for Parole;
SkateForge stays (Mocopi skin); AmbientListen→LifeOS ears; KineticTheater→
MotionMix content arm; Aura spoke VoiceAgent stays.
