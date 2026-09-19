# AO-F2 — read-only UCTM projection surface

Status: **implemented and verified locally; no UCTM service is wired and the
integration is off by default.**

This closes the first half of `INTERFACE_ABSORPTION_PLAN.md` §16 AO-F2 in the core
daemon instead of in a workspace. The contract at
`INTEGRATION_ENDPOINTS.v0.json` described the endpoint and package ownership; this
receipt records what now exists, what does not, and which invariants stop a
failure from being displayed as a success.

## What was built

| Layer | File | Role |
| --- | --- | --- |
| Domain | `backend/internal/domain/uctm.go` | Mode, projection kinds, freshness, authority ceiling, required wire metadata, projection record, read result |
| Port | `backend/internal/ports/uctm.go` | Outbound read contract and projection-store contract |
| Adapter | `backend/internal/adapters/uctm/client.go` | Loopback-pinned HTTP transport with strict response validation |
| Service | `backend/internal/service/uctm/service.go` | Mode gate, read-through cache, freshness derivation |
| Storage | `backend/internal/storage/sqlite/migrations/0111_uctm_projection.sql`, `queries/uctm.sql`, `store/uctm_projection_store.go` | Durable projection cache with write-boundary validation |
| HTTP | `backend/internal/httpd/controllers/uctm.go`, `controllers/dto.go` | Eight read routes under `/api/v1/uctm` |
| Wiring | `backend/internal/daemon/uctm_wiring.go`, `config.UCTMConfig` | `UCTM_MODE`, `UCTM_API_BASE_URL`, `UCTM_API_TOKEN`, `UCTM_REQUEST_TIMEOUT` |
| Contract | `backend/internal/httpd/apispec/openapi.yaml`, `frontend/src/api/schema.ts` | Generated; `schema.ts` verified byte-identical to a fresh generation. The spec it was generated from is uncommitted (see the caveat in `READINESS_CONTRACT.json`), so this holds as of a run, not as of a commit. |

Routes (all `GET`, all with an optional `?projectId=` projection namespace):

```
/api/v1/uctm/status            /api/v1/uctm/receipts
/api/v1/uctm/program           /api/v1/uctm/families
/api/v1/uctm/lanes             /api/v1/uctm/adjudication/queue
/api/v1/uctm/gates             /api/v1/uctm/evaluations
```

## Invariants enforced

1. **Off means off.** `UCTM_MODE` unset resolves to `off`. In `off`, no transport
   is constructed and no request is attempted; every route answers
   `freshness: disabled`, `reason: mode_off`. A malformed `UCTM_MODE` stops the
   daemon at boot, because silently picking another authority level is the one
   failure this integration cannot afford.
2. **Loopback or nothing.** The transport is loopback-only: a DNS name, a
   non-loopback address, a missing explicit port, embedded credentials, a path, a
   query, or a fragment is refused before the first read. Redirects are never
   followed. Environment proxies are disabled, so `HTTPS_PROXY` cannot route a
   loopback read through a third party.
3. **Provenance or nothing.** Every response must carry the seven required
   metadata fields (schema version, source commit/freeze identity, generated-at,
   historical/current, authority ceiling, receipt reference, content hash/ETag).
   Unknown top-level fields are rejected: a contract change must be reviewed, not
   silently dropped.
4. **A claimed content address is verified.** A `sha256:` claim that does not
   match the payload bytes fails closed; a bare ETag is recorded as opaque.
5. **Over-claiming is refused, not downgraded.** A response claiming an authority
   ceiling above `interface_read_only` — `proposal_only`, `human_adjudication`,
   `training`, `downstream_effect`, or any unrecognised label — is not stored and
   not displayed; the route reports `service_rejected`.
6. **Failure derives stale or unknown, never healthy.** An unreachable, refusing,
   or silent service yields `stale` when a projection survives and `unknown` when
   none does. An abstention (HTTP 204) never overwrites a surviving projection.
7. **Unknown states carry no payload.** Provenance fields and payload are omitted
   unless AO actually holds a projection, so an empty display cannot read as a fact.
8. **Projections are a cache, never truth.** Rows are content-addressed by AO;
   identical content written twice does not look like a change. Display status is
   derived at read time from `observed_at`/`expires_at`, never stored as a column.
9. **No UCTM route on the mobile listener.** `/api/v1/uctm` is in
   `lanControlBlockedPrefixes`; the LAN socket answers 404 as if the prefix were
   never mounted.
10. **The bearer never leaves the daemon.** `UCTM_API_TOKEN` is environment-only,
    is not returned in a DTO, and is not included in any adapter error message.

## Evidence

Repository checks:

```
cd backend && go build ./... && go vet ./...                     # clean
go test ./internal/domain/ ./internal/adapters/uctm/ \
        ./internal/service/uctm/ ./internal/httpd/... \
        ./internal/config/ ./internal/storage/sqlite/... \
        ./internal/daemon/                                        # all ok
backend/internal/httpd/apispec                                    # spec drift + route/spec parity ok
frontend: tsc --noEmit                                           # ok (regenerated schema.ts)
```

The negative controls are tests, not prose: loopback/DNS/redirect/oversize refusals,
every missing metadata field, unknown fields, hash mismatch, all five over-claims,
mode-off isolation (zero upstream calls), abstention non-overwrite, and the
projection-store write boundary.

Live smoke, against a purpose-built loopback peer on a second daemon instance with
`AO_DATA_DIR=/tmp/uctm-smoke2/data` (the running Studio daemon was not restarted):

| Control | Observed |
| --- | --- |
| `UCTM_MODE` unset | `mode: off`, `freshness: disabled`, `reason: mode_off`; peer log empty |
| `read_only` + loopback peer | `freshness: fresh` with metadata, `sourceHash` equal to the payload sha256, `expiresAt` = `observedAt + 120s` from `Cache-Control` |
| Repeat read inside the window | one upstream request per kind; repeated reads served from the projection |
| `UCTM_API_BASE_URL=http://uctm.internal:18010` | startup ERROR log, `mode: read_only` preserved, route reports `transport_not_configured`, no packet sent |
| Peer claiming `authority_ceiling: training` | `freshness: unknown`, `reason: service_rejected`, nothing stored |
| `UCTM_MODE=readonly` | daemon exits 1 with `invalid UCTM mode "readonly": want one of off, read_only, shadow, human_gated` |

## Deliberate omissions

- **No CDC invalidation.** `change_log.event_type` is a closed CHECK list rebuilt
  by migration 0103; adding an event type rebuilds the table and every trigger
  that writes it. There is no consumer until a UCTM service is qualified, so the
  rebuild is deferred to v1 rather than taken on unverified. The projection table
  is read through the existing routes.
- **No v1 proposal routes**, no v2 human-gated routes, no `uctm_event_cursors`,
  no `UCTM_PROJECT_MAPPING`, no frontend view (AO-F3).
- **No service transport.** `UCTM_API_BASE_URL` has no assigned endpoint, so a
  `read_only` deployment reports `transport_not_configured` until one is pinned.

## Non-claims

- No UCTM service is connected. Nothing in this surface has ever read a real UCTM
  fact, and `UCTM_MODE` is unset in the UCTM Studio launch environment.
- The projection table records what a service published, never that anything was
  true. AO projection rows are not UCTM truth.
- Nothing here grants authority: no route proposes, decides, trains, merges,
  spawns, deploys, or sends. Reading a claim never promotes a layer.
- The deployed daemon was not rebuilt or reinstalled, so the binary-custody
  finding in `CONTEXT_PIPELINE_GATE_2026-09-18.md` (C11) is unchanged by this work.
- `evidence_context_connected` and `uctm_spine_connected` remain false.

## Next gate

Assign a loopback endpoint for a UCTM service, pin it in the integration manifest,
and perform one live read with `UCTM_MODE=read_only`. That is the prerequisite for
AO-F3 (frontend), and for the CDC increment in §"Deliberate omissions".
