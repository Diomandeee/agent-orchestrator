# UCTM Studio connection plan — 2026-09-18

Planning artifact. Baseline is the verified state at 2026-09-18 21:30 EDT
(America/New_York). Authority stays with Mohamed; implementation runs through AO
workers.

## 0. What "everything connected" means

Connected is per-layer, not global. Each layer has its own authority ceiling, and
connecting one never promotes another.

| # | Layer | Connected means | Today |
| --- | --- | --- | --- |
| L1 | Evidence delivery | A gated recall turn reaches the model through CEF with a durable identity-only receipt | **Live** (2 receipts) |
| L2 | Evidence hardening | Native identity, signed Graph Kernel membership, and pre-hydration read boundary are enforced, not asserted | **Partial** |
| L3 | Spine projection | Studio reads UCTM facts over a loopback service and displays them; proposals stay advisory | **Partial** — v0 read surface implemented, spine service implemented, frontend view implemented and rendered against a live service; one live read verified on a throwaway instance; off by default, no launcher wiring, deployed daemon unchanged (`AO_F2_READONLY_PROJECTION_2026-09-19.md`, `AO_F3_1_SPINE_SERVICE_2026-09-19.md`, `AO_F3_FRONTEND_PROJECTION_2026-09-19.md`) |
| L4 | Governance | PACT/pPACT, SQUID, Canonical and Spine independently authorize a specific effect | **Not started** |
| L5 | Learning | Learned Harness and Harness Router act only on split-locked, evaluated evidence | **Advisory only** |
| L6 | Release | Signed, installable, advisory-clean distribution | **Dev runtime** |

Definitions of done:

- L1 done: a recall turn completes with zero tool calls, zero external effects,
  and a receipt that survives a daemon restart.
- L2 done: every selected occurrence carries a versioned identity witness and the
  slice manifest is verified; an out-of-slice decoy cannot cause a read.
- L3 done: `GET /api/v1/uctm/status` (and the v0 read set) return real spine facts
  with the required response metadata, in `read_only` mode, loopback only.
- L4 done: no proposal becomes an effect without an independent authorization
  record from the owning layer.
- L5 done: routing and learning decisions are backed by a human-labelled corpus
  and split/holdout identity, with no tool dispatch from the router.
- L6 done: signed package, clean-install evidence, advisory and key hygiene closed.

## 1. Verified baseline

### Studio (Electron + Go daemon fork)

- Recall adapter: `backend/internal/adapters/chatdriver/codexappserver/uctm_context.go`
  (grant read, 0600 bearer token, loopback CEF only, model-safe endpoint,
  provenance validation, identity-only receipt writer).
- Turn wiring: `backend/internal/adapters/chatdriver/codexappserver/conversation.go`
  (`/recall ` prefix gate, forced `approvalPolicy=on-request` +
  `sandboxPolicy=readOnly`, receipt at `turn/start`).
- Launcher and doctor: `bridge/studio_launcher.py`; host shim `bridge/codex`.
- Deployed daemon SHA256 `f87c094a9cd1ddfa447efada909d170bb881f0bd811a21f01f408444d3a97f8f`.
- Live receipts: `~/.ao/uctm-studio/context-receipts/e19858e6-….json` (19:55 EDT)
  and `27d3e6f2-112f-d110-6401-405f5c886756.json` (21:29 EDT), both
  `uctm.context-delivery.v1` / `accepted_by_codex_host`, no query, no excerpt.
- Doctor (post-fix): `deepseek_transport=ready`, `coding_harness_ready=true`,
  `cef_live_delivery_proven=true`, `cef_live_pipeline_qualified=false`,
  `evidence_context_connected=false`, `uctm_spine_connected=false`.
- Contracts on disk: `docs/uctm/INTEGRATION_ENDPOINTS.v0.json` (status
  `planned_not_implemented`), `docs/uctm/READINESS_CONTRACT.json`,
  `docs/uctm/INTERFACE_ABSORPTION_PLAN.md`, `docs/uctm/CONTEXT_PIPELINE_GATE_2026-09-18.md`.

### CEF service (Rust)

- Source worktree: `~/.codex/worktrees/context-evidence-fabric/core/retrieval/cc-context-evidence-fabric`
  (git worktree under `Desktop/Comp-Core`).
- Routes in `src/service.rs`: `/health`, `/v1/context/resolve`,
  `/v1/context/resolve/model-safe`, `/v1/schema/context-request`,
  `/v1/schema/context-evidence-bundle`, `/v1/schema/context-evidence-receipt`.
- Modules: `gate.rs`, `canonical.rs`, `model_context.rs`, `orchestrator.rs`,
  `providers.rs`, `receipt.rs`, `runtime.rs`, root `service.rs`, `types.rs`.
  There is no `grant.rs`: CEF authenticates but does not authorize.
- Deployed binary SHA256 `563d46d04ff4312ddce266ac7adf9b9b070a575ad4d842493b87f2683fb391b3`;
  `/health` reports `writes_enabled=false`, `authority_promoted=false`,
  `live_pipeline_qualified=false`.
- Tests present: `http_adapters`, `mcp_transport`, `native_adapters`,
  `native_full_stack`, `pipeline`, `recovered_native`, `schemas`, `service`,
  plus `synthetic_service_e2e.py`. Only `service`, `recovered_native` and
  `mcp_transport` have been run as binaries (6/6).

### Evidence Recovery (Python)

- `~/.codex/skills/context-recovery-ops` (script `scripts/hybrid_context_recovery.py`,
  MCP server `mcp_server/evidence_recovery_server.py`, adapter `api/evidence_recovery_uctm_adapter_v0.py`).
- Derived index `~/.codex/state/context-recovery/hybrid-transcripts-v1.sqlite3`,
  `raw_text_stored=false`. Bounded single-day refresh receipt: 161 files
  considered, 79 indexed, 82 unchanged, 7,077 messages, 216,460 postings,
  130 embeddings, semantic available, 774 s.
- 45-test suite recorded green; metadata-only selection is `review` by design.

### UCTM spine (Rust CLI)

- Repo `~/Developer/UCTM`; modules `coding`, `coding_terminal`, `context`,
  `control`, `grant`, `input`, `main`, `promotion`, `router`, `storage`;
  Python bridges `spine`, `ui`, `install`, `keychain`, `recover`, `codex_host_smoke`;
  12 Python test modules.
- Active release `~/.local/share/uctm/releases/20260918-workspace-6/uctm`,
  binary `9aa9d55e8cdb126b3a88554e27b9a37b4239afaa903eb0593977ef22f876e154`.
- **No HTTP listener** (no axum/hyper/TcpListener). `uctm ui` is a local server
  with token/Origin/Host protection, not the contract in the endpoint file.
- Its own open list: (1) finish tests incl. lifecycle/packaging, (2) repair and
  select index only after integrity checks, (3) CEF lacks native
  occurrence-to-graph IDs, (4) Learned Harness and Router proposal surfaces not
  connected, (5) whole-product acceptance, independent effect-boundary review,
  resource isolation, packaged upgrade/rollback and clean-install evidence.
- `HarnessRouterV2` (`~/Developer/HarnessRouterV2`) is linked by path, runs
  shadow evaluation, writes advisory receipts, dispatches no tools.
- `~/Developer/pact` is **Prompt Algebra and Composition Theory** — a different
  system from the UCTM governance notion of PACT. `pPACT` has **no
  implementation anywhere**; it appears only in
  `docs/uctm/INTERFACE_ABSORPTION_PLAN.md`.

## 2. Workstreams

### WS0 — Authority and contract freeze (no code)

| ID | Goal | Deliverable | Acceptance |
| --- | --- | --- | --- |
| WS0.1 | Fix the authority ceiling per layer | Signed table: what Studio, CEF, spine, PACT/pPACT, Canonical may each cause | Mohamed signs; every later task cites it |
| WS0.2 | Freeze the "connected" claim vocabulary | Allowed/forbidden claim list per layer, mirroring `READINESS_CONTRACT.json` style | Review of every doc that reports status |
| WS0.3 | Name ownership for each layer | Owner + reviewer per workstream, independent-effect reviewer named | Recorded in this file |
| WS0.4 | Decide the PACT name collision | Resolution: rename UCTM governance layer or bind it to `Developer/pact` semantics | Written decision, no code |

Blocks WS1-WS6 documentation claims, not their code.

### WS1 — Live evidence gate closure

| ID | Goal | Target | Acceptance evidence |
| --- | --- | --- | --- |
| WS1.1 | Tool-free recall turns | `conversation.go` recall branch; provider turn parameters that remove shell/file capability | A recall turn produces zero tool calls; regression test asserts the turn boundary |
| WS1.2 | Grant enforcement inside CEF | New `grant.rs` in the CEF crate; authorization on `/v1/context/resolve*` (schema, expiry, family allowlist, purpose, byte budget) | Unauthenticated 401; authenticated-but-ungranted 403; out-of-family 403; expired 403 |
| WS1.3 | Restart and cancel checks | Studio + CEF; receipt survives restart, cancel leaves no partial admission | Restart mid-recall leaves no receipt and no model turn; recorded receipt |
| WS1.4 | Pre-hydration no-read proof | ER RAG++ boundary; instrumented run showing zero source reads for a rejected family | Instrumented evidence, not inference |

Exit: `evidence_context_connected=true` with `evidence_context_gate_open=[]`.

### WS2 — Evidence plane hardening

| ID | Goal | Target | Acceptance evidence |
| --- | --- | --- | --- |
| WS2.1 | Versioned native identity registry | ER: registry with version, host/session/turn/item identity + digest witness per occurrence; migration rule for ambiguous legacy records (stay `review`) | Registry version present in every occurrence; ambiguous fixtures stay review |
| WS2.2 | Graph Kernel signed slices + membership | CEF: verify the allowed-turn/content manifest against a signed slice and its membership | Tampered manifest rejected; decoy turn excluded |
| WS2.3 | RAG++ read boundary before hydration | ER: enforce the slice before search/fetch, not only after ranking | High-scoring out-of-slice decoy yields zero prohibited reads |
| WS2.4 | Human-labelled Evaluation v2.1 | ER `tests/` + `benchmarks/`: natural trigger, admission, concurrency cases with human labels | Published recall/MRR/FAR with human-verified labels > 0 |

Exit: L2 done; ER may be described as hardened, still never as memory or authority.

### WS3 — Spine service and Studio projection

WS3.1 and WS3.2 are implemented and verified as of 2026-09-19 in
`AO_F3_1_SPINE_SERVICE_2026-09-19.md`: `uctm service --port PORT` serves
`/v1/status` and `/v1/receipts` with the full response metadata, abstains with
204 for the other seven contract routes, binds loopback only behind a 0600 token
file, and reads real spine state. The section below is retained as the original
plan text.

| ID | Goal | Target | Acceptance evidence |
| --- | --- | --- | --- |
| WS3.1 | Spine loopback service | New service in `~/Developer/UCTM` exposing `/v1/status`, `/program`, `/lanes`, `/gates`, `/receipts`, `/families`, `/adjudication/queue`, `/evaluations`, `/events` | Each response carries schema version, source commit/freeze id, generated-at, historical/current, authority ceiling, receipt ref, content hash |
| WS3.2 | Transport boundary | Loopback only, token file 0600, no DNS, no public bind, request timeout | Rejected: DNS name, non-loopback bind, missing/loose token |
| WS3.3 | Studio domain and port | `backend/internal/domain/uctm.go`, `backend/internal/ports/uctm.go` | No HTTP/SQLite/Electron imports in domain; interface consumed by service |
| WS3.4 | Studio service and projection | `backend/internal/service/uctm/{service.go,projection.go,modes.go}` | `off`/`read_only`/`shadow` behaviours unit-tested; `shadow` cannot mutate prompts |
| WS3.5 | Loopback HTTP adapter | `backend/internal/adapters/uctm/{http_client.go,types.go,redaction.go}` | Timeout, TLS-off loopback, redaction, schema mismatch fail closed |
| WS3.6 | HTTP controller + spec | `backend/internal/httpd/controllers/uctm.go`, regenerated OpenAPI/TS client | Contract tests; `/api/v1/uctm/*` returns disabled state when mode is `off` |
| WS3.7 | Projection storage + UI tab | New appended migration, `uctm.sql`, `frontend/src/renderer/routes/_shell.projects.$projectId_.uctm.tsx` + components | Projection rows carry receipt refs only; no canonical labels; PR/CI/review tabs untouched — **done**: the view renders all eight kinds read-only, is reachable from the command palette, and has an automated read-only/no-telemetry test |

Exit: L3 done in `read_only`; `uctm_spine_connected=true` only when the service is
pinned and the projections are live. As of 2026-09-19 the service exists and one
read is verified, but the endpoint is not pinned in a launcher and no projection
is displayed, so L3 is still partial and `uctm_spine_connected` stays false.

### WS4 — Governance: PACT/pPACT, SQUID, Canonical, adjudication

| ID | Goal | Target | Acceptance evidence |
| --- | --- | --- | --- |
| WS4.1 | pPACT contract freeze | Written contract: inputs (proposed effect, authority budget, holdout state, receipt ref), outputs (valid/invalid + receipt), and the rule that no gate opens on model claims | Signed contract before any code (WS0.1 dependent) |
| WS4.2 | pPACT deterministic validator | Implementation of the frozen contract with replayable receipts | Deterministic replay: same inputs, same verdict; invalid inputs leave no effect |
| WS4.3 | Proposal routing | Studio `shadow` proposals flow through WS4.2 before any effect | `proposal_only` effects provable; no path from proposal to merge/training |
| WS4.4 | SQUID + Canonical adapters | Authorization records from the owning layer, keyed to the proposal | Missing authorizer denies; recorded authorization is queryable |
| WS4.5 | Human adjudication surface | Desktop-only decision form with typed confirmation, actor identity, idempotency, readback receipt | Contract test for each; v2 endpoints remain `human_gated_not_authorized` until qualified |

Exit: L4 done. No layer may be described as "governed" until proposals cannot
become effects without WS4.4 authorization.

### WS5 — Learned Harness and Harness Router

| ID | Goal | Target | Acceptance evidence |
| --- | --- | --- | --- |
| WS5.1 | Split-locked training views | Spine: episode/split/holdout identity for any learned component | Holdout never visible to training paths |
| WS5.2 | Router proposal surface | Connect `HarnessRouterV2` advisory receipts into Studio projections | Advisory-only; zero tool dispatch asserted by test |
| WS5.3 | Learned Harness evaluation | Context policy comparison against baselines with token/calibration/abstention metrics | Evaluation reflected in WS2.4 corpus discipline |
| WS5.4 | Promotion gate | Checkpoint promotion only through WS4.2 + WS4.4 | No promotion path bypasses consequence validation |

Exit: L5 done. Until then, routing claims stay "shadow/advisory".

### WS6 — Release and ops hygiene

| ID | Goal | Target | Acceptance evidence |
| --- | --- | --- | --- |
| WS6.1 | npm advisory remediation | Studio frontend dependency tree (2 high, 2 moderate recorded 2026-09-18) | `npm audit --omit=dev` clean or explicitly accepted with reasons |
| WS6.2 | DeepSeek key rotation | Provider console + Keychain item; proxy token regeneration | Old key rejected; no `DEEPSEEK_API_KEY=` in the isolated Codex home |
| WS6.3 | Packaged upgrade/rollback | Spine packaging + Studio signing/notarization path | Clean-install and rollback receipts |
| WS6.4 | Resource isolation | Bounded CPU/memory/disk for ER index writes and CEF | Bounded run under load; no unbounded writer |

## 3. Sequencing

- **M1 (days)** — WS1.1, WS1.2, WS1.3, WS1.4, WS6.1, WS6.2. Exit: L1 done and
  closed out; `evidence_context_connected` may become true.
- **M2 (weeks)** — WS2.1, WS2.2, WS2.3 then WS2.4. Exit: L2 done.
  WS2.1 and WS2.2 can start in parallel with M1 because they are read-only work.
- **M3 (weeks, largest)** — WS3.1, WS3.2 first (spine side), then WS3.3 → WS3.7.
  Exit: L3 done in `read_only`; `shadow` behind a separate switch.
- **M4 (weeks, decision-bound)** — WS0.1 → WS4.1 → WS4.2 → WS4.3 → WS4.4 → WS4.5.
  Exit: L4 done. Nothing here starts before the WS4.1 contract is signed.
- **M5 (after M2 + M4)** — WS5.*, WS6.3, WS6.4.
- Parallelism rule: only one writer per store. ER index writes and CEF
  deployments are serialized by lease or by explicit handoff.

## 4. Verification matrix

| Level | Evidence required for any task above |
| --- | --- |
| Structure | Files, modules and boundaries as specified; no cross-layer imports |
| Compilation | Go `go test`/`go build`, Rust `cargo test` with warnings denied, Python suite, TS typecheck |
| Integration | Real services on loopback with real tokens; no mocked authority |
| Content | No raw-history copying; receipts carry identities only; claims match WS0.2 vocabulary |
| User journey | A human sees the fact in Studio (or the receipt in the receipts directory) and can reproduce it |
| Deployment | Restart, rollback and clean-install paths exercised; status fields reflect reality |

## 5. Decision register (Mohamed only)

1. Authority ceiling per layer (WS0.1).
2. Which families, windows and egress purposes are approved, per use (grant model).
3. Whether Studio may ever hold canonical authority (recommended: no).
4. The PACT naming collision resolution (WS0.4).
5. Whether M2 hardening runs before or interleaved with M3 build.
6. Promotion of any claim from partial to connected.

## 6. Fail-closed rules (must not regress)

- No grant, no search: recall requires a private, unexpired, family-scoped grant.
- Source drift or invalid UTF-8 fails closed; no silent re-index.
- `raw_text_stored=false` in the ER index; receipts store identities, not text.
- CEF stays loopback, token-authenticated, `writes_enabled=false`,
  `authority_promoted=false`.
- Model output never authorizes an effect; `execution_authorized=false` is default.
- Studio never writes canonical labels, opens training, or merges evidence into truth.
- Protected history and the original recovery index are never mutated.

## 7. Kill switches and rollback

- Revoke: delete or expire `cef-grant.json`; the next recall turn fails closed.
- CEF: stop the service; Studio reports `cef_service_ready=false`.
- Studio: restore `frontend/daemon/ao.pre-cef-20260918`
  (`242a685b125b80a439061485332c6ece7aaeb13e7602f12a901857b741b2f2e2`).
- Spine: keep previous release directories; launcher selects by manifest.
- ER: the derived index is replaceable; restored from a verified schema-3 copy.

## 8. Explicit non-claims

- No layer below L1 is connected today.
- PACT/pPACT, SQUID, Canonical and Spine are not wired into Studio.
- The Evidence Recovery index is derived, replaceable, and unproven as general memory.
- Current receipts prove delivery of admitted context, not that the model used every source.
- Green doctor fields prove local runtime readiness, not UCTM integration.

## 9. Effort estimate

Ranges are judgment, not measurement; they assume one focused worker per
workstream slice and no new authority blockers.

- M1: hours to 2 days (WS1.2 is the largest single item).
- M2: 2-4 weeks (WS2.1 and WS2.2 dominate; WS2.4 is corpus work).
- M3: 3-6 weeks (new service plus adapter, projections, migration and UI).
- M4: 2-4 weeks after the contract is signed; blocked on WS0.1/WS4.1 decisions.
- M5: 2-4 weeks after M2 and M4.

## 10. Next actions

1. Mohamed: WS0.1 authority table and WS0.4 PACT naming decision.
2. Worker: WS1.1 + WS1.2 (tool-free recall boundary and CEF grant enforcement).
3. Worker (parallel, read-only): WS2.1 registry design and WS2.2 manifest verification.
4. ~~Worker: WS3.1 minimal `/v1/status` returning real spine facts with full response metadata.~~ Done 2026-09-19 (`AO_F3_1_SPINE_SERVICE_2026-09-19.md`); `/v1/receipts` also publishes, and the remaining seven routes abstain.
5. Mohamed: decide whether the Studio daemon is rebuilt and redeployed with the read surface, and whether `UCTM_MODE=read_only` plus the local endpoint are exported for the desktop launch. Deployment is a gate, not a task.
6. ~~Worker: AO-F3, the project-scoped UCTM view, which must render disabled/unknown/stale/fresh honestly before it renders any payload.~~ Done 2026-09-19 (`AO_F3_FRONTEND_PROJECTION_2026-09-19.md`); the view is reachable from the command palette and its read-only/no-telemetry behaviour is asserted by a test that drives the real API client.
7. Worker or design owner: decide the app-wide `text-accent` fix. **The inventory below was corrected 2026-09-19 after two independent counts disagreed with the first one; do not action this from an earlier list.** The defect is confirmed by compiling the repo's own stylesheet with `@tailwindcss/node` 4.3 — the emitted rule is `.text-accent { color: var(--accent) }`, and `--accent` is the shadcn *surface* token: light `oklch(0.967 0.001 286.375)` on `--card` `oklch(0.985 0 0)` = **1.054:1**; dark `oklch(0.274 0.006 286.033)` on `--card` `oklch(0.24 0.008 285.885)` = **1.106:1**. `styles.css:13` says dark is the primary theme, so a light-only repair leaves the default theme broken, and every alternate theme from `tokens.css:852` has the same accent-near-card shape. Reading the source is a trap: `--color-accent: var(--primary)` sits at `tokens.css:106` and `:713`, later in source order than the `@theme inline` block, but the inline directive bypasses its own theme key and inlines `var(--accent)`, so a source read concludes the opposite of the compiled truth.
   - **Inventory: 16 production usages in 10 files.** Reproduce with `rg --pcre2 -o --glob '!node_modules' 'text-accent(?![-a-zA-Z])' frontend/src packages -g '*.{ts,tsx}'`.
   - `BrowserPanel.tsx` 5, `chat/ChatTimelineItems.tsx` 2, `TerminalPane.tsx` 2, `chat/TurnPlan.tsx` 1, `chat/ChatMarkdown.tsx` 1, `lib/workspace-file-status.ts` 1, `SessionInspector.tsx` 1, `IntakeFields.tsx` 1, `CenterPane.tsx` 1, `packages/product-ui/src/SessionsBoardView.tsx` 1.
   - Five of those sixteen were missed by the first inventory: `lib/workspace-file-status.ts`, `SessionInspector.tsx`, `IntakeFields.tsx` and `CenterPane.tsx` were absent from the list entirely, and `packages/product-ui/src/SessionsBoardView.tsx` was missed by *both* scans until the `@source` directive at `styles.css:5` was checked. Two of them deserve emphasis: `lib/workspace-file-status.ts` is a status→class map, so it is **transitive** across every surface that renders a file status; and the product-ui chip pairs `bg-accent/12` with `text-accent`, which measures **1.048:1** light and **1.092:1** dark — accent text on its own tint.
   - One entry was a false positive and is removed: `NotificationCenter.tsx` has no bare `text-accent`; its only match is `text-accent-foreground` over `bg-accent-strong`, which is the correct token.
   - One test file is affected and is not a production call site: `chat/ChatComposer.test.tsx` 1.
   - The UCTM view holds **zero** real usages. The two matches in `components/uctm/UctmProjectionCard.tsx` are the comment that documents this defect, which is itself what made the first count read one file too wide.
   - `text-accent-foreground`, `-weak`, `-dim` and `-strong` are different tokens, compile to different variables, and are mostly correct: `.text-accent-foreground { color: var(--primary-foreground) }`, `.text-accent-dim { color: var(--bridge-accent-dim) }`, `.bg-accent-strong { background-color: var(--bridge-accent-strong) }`.
   - The replacement is a **design decision** (`text-accent-foreground` vs `text-primary` vs a new brand token) that would be worse guessed wrong across 16 sites than left recorded, so it stays open. Whoever builds the delegation-lineage tree view must not use `text-accent` for text.
    - **Completeness, checked rather than assumed (second pass, 2026-09-19).** Two escape routes that a text-utility grep structurally cannot see were closed by hand, so 16/10 is the complete *live* inventory and not merely the greppable subset: (a) there is no computed class name anywhere in the compiled scope — no `text-${…}` or concatenated `text-*` builder; and (b) exactly two CSS rules set an accent token as a text colour, `.inspector-section__link` (`styles.css:3224`) and `.dashboard-app-header__primary-btn` (`styles.css:2709`), and both have **zero** consumers in `.tsx`/`.ts`/`.html` — dead CSS. No live seventeenth site exists.
    - The worst site's verdict does not depend on the alpha-compositing model: gamma-encoded sRGB gives 1.093:1 dark / 1.047:1 light and linear gives 1.092:1 / 1.048:1, a 0.001 spread, so the number is safe to quote whichever model a reader assumes.
    - **Adjacent, but a different defect class, and deliberately not folded into this item:** the dead `.dashboard-app-header__primary-btn` rule pairs `background: var(--accent)` with `color: var(--accent-fg)`, and `--accent-fg` is declared nowhere in the repository — its only occurrence is that usage, and `--bridge-accent-fg` (`styles/tokens.css:583`) is a different variable. It is invalid at computed-value time, so the colour inherits from the parent. Harmless while the class is dead; a silent wrong-colour trap if anyone revives it.
    - Why a source read misleads here, in one line: `--color-accent` is declared four times inside the compiled scope — `renderer/styles.css:257` and `site-theme/tokens.css:62` as `var(--accent)`, `styles/tokens.css:106` and `:713` as `var(--primary)`. That is a cascade read and not a browser measurement; the compile remains the evidence.
8. ~~Worker: serve `docs/uctm/ORIENTATION.v0.json` from the daemon or inject it at spawn time, so re-orientation does not depend on a session knowing the script exists (`AO_ORIENTATION_INDEX_2026-09-19.md`).~~ Done 2026-09-19 (`AO_F4_ORIENTATION_AT_SPAWN_2026-09-19.md`) by the spawn-injection half: the session manager appends a bounded orientation card under `UCTM_STUDIO=1`, and `docs/uctm/GRAPH.v0.json` adds occurrence identity plus `--impact`/`--stale`. The served half is deliberately not built — a second disclosure surface needs a consumer that is not a session. Effect begins at the next Studio launch; the daemon was not rebuilt.
9. Worker: extend the evidence kernel's edge extraction past documents and session artifacts — receipts name `backend/` paths and test names, which is the join the spine's occurrence-to-graph item needs (`AO_F4_ORIENTATION_AT_SPAWN_2026-09-19.md`).
