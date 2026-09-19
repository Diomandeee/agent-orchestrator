# UCTM Studio historical-context integration gate

Status: **synthetic end-to-end qualified; live personal-history recall not
activated**. The existing curated context card is independent of historical
recovery. The native Rust CEF service and the Studio `/recall` adapter are
installed and running, but there is no grant for protected-history search or
model egress. `evidence_context_connected` remains false.

Target path:

`Studio /recall turn -> explicit project/provider/family grant -> Evidence Recovery -> verified
native occurrence identity -> Graph Kernel signed slice + membership -> RAG++
graph-scoped rank -> CEF accept/review/abstain -> model-safe context ->
Codex untrusted turn context -> private source-identity delivery receipt`.

Spine/PACT/SQUID/Canonical effect governance remains a separately gated
downstream integration. Context admission does not imply that path is live.

Implementation: Evidence Recovery has a separate
`bind_turns.v1` direct-seek identity tool; the CEF Rust path builds a bounded
per-request Graph Kernel slice and RAG++ flat index; Studio's `/recall` path
requires a private expiring grant and consumes only CEF's model-safe response.
The CEF loopback service additionally requires a private bearer token for all
evidence-bearing routes; the Studio daemon reads it, but the Codex child
process does not inherit the token or its path. This protects against casual
unauthenticated localhost calls, not against a same-user process with direct
filesystem access to protected history.
CEF authenticates and now authorizes. `create_authorized_router` keeps the
constant-time bearer check on every evidence-bearing route and adds the same
private `uctm.recall-grant.v1` check the Studio boundary performs: schema,
expiry inside a 24-hour ceiling, window width, evidence-character ceiling, mode,
scope containment, active-thread exclusion, and the family selected by
resolution. A denial is a 403 carrying a stable code and no evidence. The
deployed service reports `grant_enforced: true` on its public health route, and
`bridge/studio_launcher.py` reports `cef_grant_enforced_by_service`. This closes
the earlier gap where any same-user process holding the 0600 `cef-token` could
resolve an ungranted family. Evidence and denial cases are recorded in
`RECALL_ENFORCEMENT_ACTIVATION_2026-09-18.md`; grant enforcement is a boundary
over who may resolve what, never a claim about the truth of what was resolved.
Ordinary chat is unchanged. A `/recall` turn additionally requires a private
receipt directory before any search. After Codex accepts the turn, its private
0600 receipt records source occurrence IDs, roles, digests, slice/family IDs,
and provider turn/model, but no query or excerpt. `accepted_by_codex_host` is
not a claim that the model understood or used every source.

The deployed daemon has been restarted with this path, and a live grant has
since been created and used: bounded personal-history evidence has been
delivered to DeepSeek under that grant, with an identity-only delivery receipt
and no excerpt or query stored. The grant is family- and window-scoped and
expires within 24 hours. Because historical evidence is admitted with
`execution_authorized=false`, a recall turn now runs with no environment at all,
which removes the shell tool from that turn instead of merely restricting it. The pre-hydration
RAG optimization remains unimplemented here:
Evidence Recovery first hydrates its own bounded candidate capsule, then
Graph Kernel and RAG++ restrict what can reach the model.

The existing derived recovery index had an unfinished SQLite DELETE journal.
SQLite transaction rollback restored read-only access without a history scan
or reindex. A bounded metadata-only query now runs, but its top indexed source
files have drifted (12/12 sampled user rows), so gated retrieval correctly
abstains with zero hydrated evidence. The recovery engine now rejects source
size/mtime drift before direct seek and fails closed on invalid UTF-8. A
bounded refresh or another unchanged source is needed for live recall proof;
neither has been silently performed. `CAPTURE_GATE=BLOCKED` remains unchanged.

Qualification receipt, 18 September 2026:

- Evidence Recovery Python suite: 45/45 passed.
- CEF focused Rust integration suite: 6/6 passed (MCP transport, native
  Graph Kernel/RAG++ with out-of-slice decoy, and HTTP service/auth).
- Studio chat-driver and session-manager Go suites passed.
- All-synthetic HTTP/MCP/Graph/RAG service journey passed: admitted one
  attested source, excluded the worker decoy, and abstained with HTTP 204 for
  an unrelated query. Unauthenticated evidence access returned HTTP 401.
- The actual Codex/DeepSeek path returned the marker found only in admitted
  synthetic evidence, and wrote an identity-only private delivery receipt.
- Installed Studio daemon SHA-256:
  `f87c094a9cd1ddfa447efada909d170bb881f0bd811a21f01f408444d3a97f8f`.
  Installed CEF service SHA-256:
  `563d46d04ff4312ddce266ac7adf9b9b070a575ad4d842493b87f2683fb391b3`.
- Studio doctor: desktop, daemon, DeepSeek, CEF service/auth, and receipt
  directory ready; grant absent, live evidence connection false, spine false.
  Environment note: this green report requires the real `HOME` and a
  `python3` >= 3.11 first on `PATH`. Under Python 3.9 the `bridge/codex`
  shim fails inside `hashlib.file_digest` and surfaces the generic
  `uctm_codex_host_unavailable`, which flips `deepseek_transport` to
  `unavailable` and `coding_harness_ready` to false. The shim should pin
  its interpreter or fail with an explicit version error.

Independent re-verification, 18 September 2026 (separate read-only session):

- Deployed daemon `frontend/daemon/ao` SHA-256 matches the recorded
  `f87c094a9cd1ddfa447efada909d170bb881f0bd811a21f01f408444d3a97f8f`. The
  preserved backup `frontend/daemon/ao.pre-cef-20260918` is present
  (`242a685b125b80a439061485332c6ece7aaeb13e7602f12a901857b741b2f2e2`) and
  unmodified.
- Installed `~/.ao/uctm-studio/cef-server` is byte-identical
  (`563d46d04ff4312ddce266ac7adf9b9b070a575ad4d842493b87f2683fb391b3`) to
  `debug/cef-server` and `debug/deps/cef_server-cf939eee547b5b55` in the build
  tree, tying the deployed service to a tested artifact.
- Live at verification time: `daemon/ao daemon` pid 4572, `cef-server` pid
  21726, `electron-forge start` pid 4059, `deepseek_proxy.py` pid 42708.
  Daemon `/readyz` returned `status: ready`; CEF `/health` returned
  `ready_bounded` with `writes_enabled=false`, `authority_promoted=false`,
  `live_pipeline_qualified=false`; proxy `/healthz` returned `ready: true`.
- Re-ran existing binaries rather than rebuilding: CEF `service` 4 tests,
  `recovered_native` 1, `mcp_transport` 1 — 6/6 reproduced. Evidence Recovery
  pytest: 45 passed. Studio Go `chatdriver/codexappserver` and
  `session_manager` passed. The first Go run used the session sandbox
  `HOME`, whose module cache lacked `modernc.org/sqlite`, so
  `chatdriver/opencodeacp` and `chatdriver/registry` failed at setup with no
  network route; re-running both with the host `HOME` passed (0.33s and
  0.56s). No Go package failed for a code reason.
- Not re-verified: the CEF test files `native_full_stack`, `http_adapters`,
  `pipeline`, `schemas`, and `native_adapters` have no built test binaries, so
  the 6/6 figure covers three binaries only.
- The empty `~/.ao/uctm-studio/context-receipts/` directory is expected: the
  synthetic delivery receipt was written under the Go test temporary directory
  and removed with it. No durable excerpt-free receipt is preserved; producing
  one requires the receipt writer to accept a durable output path and a
  re-run.

Separately tracked, not part of this gate (no evidence of resolution seen):

- Rotation of the previously exposed DeepSeek provider key.
- The `npm audit --omit=dev` production-tree advisories (2 high, 2 moderate)
  recorded in the local host qualification.

Activation gates, in order:

1. Native identity. Implemented (scoped): the Evidence Recovery
   `bind_turns.v1` direct-seek tool binds accepted search results to native
   turn IDs, rejects source size/mtime drift before direct seek, and fails
   closed on invalid UTF-8; covered by the recovery suite and
   `mcp_transport`. Open: a *versioned* native identity registry — no
   registry version, no host/session/turn/item identity plus digest witness
   for every selected occurrence, and no migration rule for ambiguous
   legacy records (those stay review). Never derive Graph Kernel UUIDs from
   line numbers or ranking.
2. Graph membership: verify the exact allowed-turn/content manifest against a
   signed slice, not a provider-returned `token_verified` boolean alone.
3. RAG++ read boundary: enforce the slice before search/fetch/hydration, with
   high-scoring out-of-slice decoy tests proving zero prohibited reads.
4. Model boundary: consume only CEF's model-safe endpoint. Diagnostic bundles,
   raw ranked candidates, rejected-family excerpts, and review/abstain results
   never enter the model payload.
5. Privacy: require a revocable, expiring grant naming project, source family,
   recipient provider, byte budget, and purpose before any protected history
   is searched or sent to DeepSeek. No grant exists for live Studio history.
6. Governance: route proposals and policy checks remain advisory until PACT,
   SQUID, Canonical, and Spine independently authorize the specific effect.
   Context admission alone never grants training or tool execution.
7. Qualification: the all-real-engine synthetic composition and provider
   delivery checks passed. A bounded live query with user-selected family and
   explicit egress grant, complete source manifest, restart/cancel checks, and
   pre-hydration no-read proof remain open.

Until the remaining live gate passes, `uctm doctor` must continue to report
`evidence_context_connected=false`. A running authenticated CEF service is
not evidence that protected history is approved for model delivery.
