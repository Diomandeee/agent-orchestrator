# UCTM recall enforcement activation - 2026-09-18 (M1)

Scope: WS1.2 (grant enforcement inside CEF) and WS1.1 (tool-free recall turn).
This record contains identities, codes, and counts only. It stores no excerpt,
query result, or raw-history text.

## 1. Grant enforcement inside CEF (WS1.2)

CEF previously authenticated the loopback caller but did not authorize it: any
same-user process able to read the 0600 `cef-token` could resolve any family.
Enforcement now repeats at the service itself.

Implementation (`core/retrieval/cc-context-evidence-fabric`):

- `src/grant.rs` loads the same private `uctm.recall-grant.v1` file the Studio
  boundary reads, on every evidence request, so rotation and expiry take effect
  without a restart. Denials are stable machine codes, never a path, query, or
  excerpt: `grant_unavailable`, `grant_permissions_insecure`,
  `grant_too_large`, `grant_malformed`, `grant_schema_invalid`,
  `grant_expired`, `grant_expiry_too_long`, `grant_window_invalid`,
  `grant_window_too_wide`, `grant_budget_invalid`, `grant_mode_not_authorized`,
  `grant_scope_missing`, `grant_scope_out_of_window`, `grant_budget_exceeded`,
  `grant_active_thread_not_excluded`, `grant_family_mismatch`, and related
  structural codes.
- Request scope and budget are authorized before any provider runs; the selected
  family is authorized after resolution and before any payload leaves.
- `src/bin/cef-server.rs` requires `--grant-file` (env `CEF_GRANT_FILE`) and
  reports the active grant at startup.
- `/health` now carries `grant_enforced`, true only on the deployment router, so
  a launcher cannot report enforcement from the binary version alone.

Deployed: `~/.ao/uctm-studio/cef-server`, sha256
`a7b6464c239a887f59fe81869ef2a6ccbbdd2ba6319a539fbeb0c758c28ec3ed`.
Previous binary preserved at `cef-server.pre-grant-20260918`, sha256
`563d46d04ff4312ddce266ac7adf9b9b070a575ad4d842493b87f2683fb391b3`.
`bridge/studio_launcher.py` passes `CEF_GRANT_FILE` and reports
`cef_grant_enforced_by_service`.

Live denial matrix against the running service, one request per row:

| case | result |
| --- | --- |
| no bearer token | 401 |
| scope outside the granted window | 403 `grant_scope_out_of_window` |
| budget above the granted ceiling | 403 `grant_budget_exceeded` |
| mode `explore` | 403 `grant_mode_not_authorized` |
| second CEF instance on a grant naming another family, same query | 403 `grant_family_mismatch` |
| granted query, granted window and budget | 200, family matches the grant, slice `55d9e6eb1ab8145e`, 4 items, 1343 of 8192 characters |

Verification: `cargo test --features service` 53 tests green (11 service
integration tests including grant denial, one new `deployment_health_reports_grant_enforcement`),
`cargo clippy --all-targets --features service` clean for every file this change
touched. One pre-existing `#[must_use]` warning remains in
`create_authenticated_router`, which this change did not introduce.

Two drift items were found and handled honestly rather than papered over:

- `checked_in_schemas_match_rust_types` failed because
  `schemas/context-evidence-bundle.v0.schema.json` predated the `ContextEvidenceBundle`
  documentation that warns the diagnostic bundle must never reach a model. The
  schema was regenerated with the checked-in `generate-schemas` binary; the diff
  is that description string and nothing else.
- CEF must run with the user's real `HOME`: the Evidence Recovery MCP server
  resolves its Python dependencies there, and an isolated `HOME` yields
  `recovery_unavailable`. The launcher already does this; the note is here
  because a hand-started service does not.

## 2. Tool-free recall turn (WS1.1)

A recall turn previously ran with `approvalPolicy=on-request` and a read-only
sandbox. That bounds execution but still runs read commands, and the model did
in fact issue local tool calls on the first admitted recall turn.

Measured against the installed host (`codex-cli 0.154.0-alpha.6.2`, experimental
API negotiated as Studio does), same thread settings, one variable:

| turn | `environments` | observed items | model |
| --- | --- | --- | --- |
| control | omitted | `commandExecution` | runs `id -un` |
| recall | `[]` | none | reports no shell tool |
| next ordinary turn, same thread | omitted | none | still no shell tool (the empty selection is sticky) |
| next ordinary turn | thread environment re-sent | `commandExecution` | runs `id -un` again |

Implementation:

- A recall turn sends `environments: []` with `approvalPolicy=never` and the
  read-only sandbox, so the turn has no shell tool at all rather than a bounded
  one (`conversation.go`).
- `thread/start` and `thread/resume` responses are read for the thread's
  environment selection, and every non-recall turn re-asserts it. Without that,
  a single `/recall` would leave the rest of the conversation - including after
  a daemon restart, which resumes the same thread - without shell access.
- Regression tests: `TestUCTMRecallTurnForcesToolFreeBoundary` and
  `TestUCTMTurnsRestoreThreadEnvironmentAfterRecall`.

## 3. End-to-end on the live path

`TestLiveUCTMRecallTurnIsToolFree` (gated on `AO_CODEX_LIVE=1` and the UCTM
bridge environment) drives the real host, the real grant, and the upgraded
service: control turn runs a command, recall turn runs none and writes the
receipt, the following turn has its shell back. Passed in 15.6s.

Receipt `context-receipts/8050a9df-9b99-1e7f-9114-50cec0f900f0.json` (0600) -
schema `uctm.context-delivery.v1`, status `accepted_by_codex_host`, family
`019fbb5a-8de4-7570-8556-fe67d8a039a4`, slice `55d9e6eb1ab8145e`, provider model
`deepseek-flash`, 4 identity-only sources, no query and no excerpt. The grant
was renewed to `expires_at` 2026-09-19T18:00:00Z, still inside the 24-hour
ceiling both boundaries enforce.

Studio doctor now reports `cef_grant_enforced_by_service` true,
`cef_live_delivery_proven` true, `cef_live_pipeline_qualified` false,
`evidence_context_connected` false, gate still open on
`restart_cancel_checks` and `pre_hydration_no_read_proof`.

## 4. Not yet active

- The running daemon still executes the previous build. A rebuilt
  `frontend/daemon/ao` is staged (previous kept as `ao.pre-toolfree-20260918`),
  so the tool-free posture is not yet in effect in the desktop UI. Activating it
  requires restarting Studio, which ends every AO session under that daemon;
  that restart is a human decision, not an implied consequence of this change.
- WS1.3 restart/cancel checks and WS1.4 pre-hydration no-read proof remain open.

## 5. Non-claims

Grant enforcement constrains who may resolve what. It is not a claim that the
delivered evidence is true, that the model understood it, or that any authority
downstream of context admission is live. `authority_promoted`, `writes_enabled`,
and `live_pipeline_qualified` stay false, and admission still conveys neither
execution nor training authority.
