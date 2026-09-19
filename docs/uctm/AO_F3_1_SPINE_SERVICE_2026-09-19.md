# AO-F3.1 — UCTM spine read-only projection service, and the first live read

Status: **the spine service exists and is verified; the Studio read surface has
read real UCTM facts once, on a second daemon instance. The deployed desktop
runtime is unchanged and `UCTM_MODE` is still unset where Studio launches.**

This closes WS3.1 and WS3.2 of `CONNECTION_PLAN_2026-09-18.md` — the spine half
that `AO_F2_READONLY_PROJECTION_2026-09-19.md` named as its next gate. AO-F2
built the reader and the contract; this receipt records the writer that answers
it, the first end-to-end read, and what is still not true.

## What was built

| Layer | File | Role |
| --- | --- | --- |
| Spine service | `~/Developer/UCTM/src/service.rs` | Loopback-only, read-only `/v1/*` projection service with the required response metadata |
| Subcommand | `~/Developer/UCTM/src/main.rs` | `uctm service --port PORT [--create-token]`, allowlisted and documented in `--help` |

The service publishes what the spine can derive from durable local state and
abstains for everything else:

| Route | Behaviour |
| --- | --- |
| `/v1/status` | 200 — product, runtime, `runtime_capabilities`, redacted storage view, session count/bytes, advisory-router ledger presence, model/credential presence, service and effect statement, non-claims |
| `/v1/receipts` | 200 — the newest ≤4 sessions, each event reduced by the declared redaction rule; 204 when there is nothing to publish |
| `/v1/program`, `/v1/lanes`, `/v1/gates`, `/v1/families`, `/v1/adjudication/queue`, `/v1/evaluations`, `/v1/events` | 204 — explicit abstention: this service holds no facts for these kinds |

The wire envelope is the frozen v0 contract AO already validates: the seven
required metadata fields at the top level of the object plus `payload`, exactly
eight keys, `content_hash_or_etag` equal to `sha256:` of the compact payload
bytes, `authority_ceiling` always `interface_read_only`, and `Cache-Control:
max-age=30`. `generated_at` lives in the metadata, never in the payload, so the
payload's content address is stable while the state it describes is stable and
AO's "identical content is not a change" rule keeps holding.

## Invariants enforced

1. **Loopback or nothing, and the caller must prove it is the caller.** The
   listener binds `127.0.0.1` and an explicit unprivileged port; a `Host` header
   that is not that exact listener answers 404 as if the route did not exist, a
   missing or wrong bearer answers 401, and a non-`GET` answers 405. The token is
   compared with a content- and length-sensitive constant-time comparison.
2. **The token is a file, and a strict one.** `$UCTM_HOME/service-token` must be
   a regular file, not a symlink, mode `0600`, 32–256 printable characters. A
   loose or absent file refuses to start; there is no unauthenticated fallback.
   The service creates it only when `--create-token` is passed, and never echoes
   the value.
3. **Reads do not write.** No route writes, proposes, approves, executes, trains,
   or sends. There is no per-response journal, so the service cannot be used to
   grow state, and refusing that force is why `receipt_ref` is the payload's own
   content address rather than a durable receipt id.
4. **Abstention is not emptiness.** A kind with no facts answers 204, which AO
   renders as `unknown`/`no_facts`; a kind with no facts never answers an empty
   document that would read as "there are zero of these".
5. **A failed durable read is reported, not hidden.** A corrupt session or an
   unreadable config answers 500 with a stable code, so a caller can tell a
   refusal from a fact instead of inferring one from silence.
6. **Receipts are redacted, and the rule is declared.** `body.data.user`,
   `body.data.assistant`, and any string that is an absolute local path are
   removed, and every receipt response lists that rule and states that redaction
   breaks the event digest. Absolute paths from `storage::inspect` are removed
   from the status projection the same way, with `absolute_paths_redacted`
   recording that something was taken out.
7. **The kill switch works.** `SIGINT` stops the service in ~50 ms; a blocking
   accept could not observe cancellation until the next client connected, which
   is why the loop polls a non-blocking accept against the stop condition.
8. **`receipt_ref` is not overstated.** v0 keeps no per-response journal, so the
   strongest honest reference is the document's own content address. It proves
   integrity, not provenance. That limitation is written into the receipt, the
   payload, and this document rather than papered over with a generated id.

## Evidence

Spine crate:

```
cd ~/Developer/UCTM
cargo build            # clean, no warnings
cargo clippy           # clean
cargo test             # 31 passed, 0 failed (13 of them service::tests)
```

Live service, real spine home (`UCTM_HOME=~/.uctm`, token created once by
`--create-token` as `~/.uctm/service-token`, 0600, 64 hex characters):

| Control | Observed |
| --- | --- |
| `GET /v1/status` with the token | 200; `source_commit_or_freeze_id = dev-supervisor:cc48eea4…`, `authority_ceiling = interface_read_only`, `Cache-Control: max-age=30` |
| Content address | recomputed independently with Python over `json.dumps(payload, separators=(",",":"))`; identical to `content_hash_or_etag` |
| `GET /v1/receipts` | 200 with `redacted_projection: true` and the declared rule |
| `/v1/program`, `/v1/evaluations`, `/v1/gates` | 204 |
| wrong token, absent token | 401 |
| `Host: example.com` | 404 |
| `POST /v1/status` | 405 |
| unknown route, query string | 404, 400 |
| `--port 80` | refused (`service_port_must_be_unprivileged`) |
| `SIGINT` | process exited in 53 ms |

Live Studio read, second daemon instance (`AO_DATA_DIR=/tmp/ao-f2b/data`, port
13999, `UCTM_MODE=read_only`, `UCTM_API_BASE_URL=http://127.0.0.1:18010`,
`UCTM_API_TOKEN` from the token file). The deployed daemon (pid 77457) was not
rebuilt, restarted, or reconfigured:

| Control | Observed |
| --- | --- |
| `GET /api/v1/uctm/status` | 200, `freshness: fresh`, `reason: fresh_projection`, `sourceHash` equal to `contentHashOrEtag`, all seven metadata fields populated |
| `GET /api/v1/uctm/receipts` | 200, `freshness: fresh` |
| `program`, `evaluations`, `adjudication/queue`, `families`, `lanes`, `gates` | 200, `freshness: unknown`, `reason: no_facts`, no payload |
| two reads 2 s apart inside the window | identical `observedAt` — served from the projection, not re-fetched |
| service stopped, window elapsed | `freshness: stale`, `reason: service_unavailable`, payload survived |
| daemon started with a wrong `UCTM_API_TOKEN` | `freshness: unknown`, `reason: service_unavailable` |

## Assigned local endpoint

Machine-local, not part of the wire contract:

- `UCTM_API_BASE_URL=http://127.0.0.1:18010`
- `UCTM_API_TOKEN` read from `~/.uctm/service-token` (0600)
- `UCTM_MODE=read_only`

The port and token path are a local convention, not a protocol. Changing either
requires editing the launcher, which has not been done.

## Deliberate omissions

- **No launcher or deployment change.** `bridge/studio_launcher.py` does not
  start the service and does not export `UCTM_MODE`, `UCTM_API_BASE_URL`, or
  `UCTM_API_TOKEN`. The deployed `frontend/daemon/ao` predates the read surface,
  so wiring the launcher without rebuilding and restarting the deployed daemon
  would only produce `transport_not_configured` in the live app. Turning the
  integration on is a deployment action with its own gate; it is not taken here.
- **No frontend wiring to this service.** The AO-F3 view exists (see
  `AO_F3_FRONTEND_PROJECTION_2026-09-19.md`) but nothing in the deployed runtime
  points it at a service, because the deployed daemon neither carries the routes
  nor exports the transport.
- **No CDC invalidation**, no v1 proposal routes, no v2 human-gated routes, no
  `uctm_event_cursors`, no `UCTM_PROJECT_MAPPING`.
- **No new authority.** The service reads; nothing in this work proposes,
  adjudicates, trains, merges, deploys, spawns, or sends.

## Non-claims

- The spine service is a projection surface, not evidence that any UCTM layer is
  governed, connected, or qualified. Its own payload says so.
- Seven of the nine contract routes abstain. `/v1/status` and `/v1/receipts` are
  the only kinds with facts behind them, and both are statements about this
  local installation.
- `harness_router`, `learned_harness`, `graph_kernel`, `rag_plus_plus`, and
  `historical_evidence_recovery` are still reported as not connected to chat.
- `evidence_context_connected` and `uctm_spine_connected` remain false. A live
  read on a second daemon instance is not a claim about the deployed runtime.
- The spine source tree `~/Developer/UCTM` is not its own git repository, so this
  change has no commit identity; the service records
  `dev-supervisor:<binary sha256 prefix>` as its freeze id instead of inventing a
  commit.

## Next gate

1. Human decision: rebuild and redeploy the Studio daemon, then decide whether
   `UCTM_MODE=read_only` is exported for the real desktop launch.
2. AO-F3 is now implemented
   (`frontend/src/renderer/routes/_shell.projects.$projectId_.uctm.tsx`): the
   view renders `disabled`/`unknown`/`stale`/`fresh` honestly before it renders
   any payload, and is reachable from the command palette. What it still needs
   is a deployed daemon that can answer it.
3. Then the projection `change_log` CDC increment, which finally has a live
   publisher to invalidate against.
