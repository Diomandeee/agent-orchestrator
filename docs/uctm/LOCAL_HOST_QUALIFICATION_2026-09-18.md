# UCTM Studio local coding-host qualification — 2026-09-18

Status: **coding UI qualified on this Mac; full UCTM architecture partial.**

`uctm` now opens a local Electron interface backed by the forked Agent
Orchestrator daemon, Codex app-server, and the DeepSeek Responses API.
`uctm doctor` reports this layer separately from the unconnected UCTM spine.
`uctm cli ...` retains the prior Rust supervisor. This is an installed local
development runtime, not a signed/notarized packaged release.

## Source and transport

- Checkout: `/Users/mohameddiomande/Developer/UCTM-Studio`, branch
  `codex/uctm-interface-v0` (fork of `Untrivial-ai/agent-orchestrator`).
- Codex executable: `/Users/mohameddiomande/.local/bin/codex`,
  `codex-cli 0.154.0-alpha.6.2`, SHA256
  `a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`.
  Provenance to the customized Codex source checkout is **not** established.
- DeepSeek now documents a native Responses API. Studio uses
  `base_url=https://api.deepseek.com`, `wire_api=responses`, `model=deepseek-flash`.
  The key remains in the existing macOS Keychain item. A loopback-only,
  token-authenticated `bridge/deepseek_proxy.py` forwards `/responses` and
  injects the provider key only into the upstream HTTPS request. Codex receives
  a locally generated proxy token, **never** the provider key. The bridge pins
  the Codex host binary hash and CODEX_HOME. A live shell-tool check returned
  `KEY_ABSENT`; an unauthenticated proxy request returned HTTP 401. The proxy
  token itself may appear in Codex shell snapshots and should be treated as a
  local runtime capability, not as an exportable secret.
- Studio state and Codex home live only under `~/.ao/uctm-studio/`, isolated
  from the user's normal AO and Codex state. Remote telemetry and Sentry are
  explicitly disabled for this launch.

## Verification receipts

1. Native Codex + DeepSeek Responses synthetic model call:
   `UCTM_HOST_RESPONSES=PASS` via `Developer/UCTM/bridge/codex_host_smoke.py`.
2. AO Codex app-server driver live test: start, stream, and resume the same
   thread across app-server restart, PASS (3.55 seconds).
3. Codex tool loop in a synthetic git repo: inspected files, edited only
   `slug.py`, ran two tests, both PASS, and produced the verified one-line diff.
4. Forked AO daemon and **actual Electron UI**: registered the synthetic
   project, started a Codex Chat session, observed a failing baseline, sent the
   bounded fix, verified the on-disk diff and two passing tests, restarted the
   desktop/daemon, and sent a follow-up through the restored UI. The answer
   correctly identified `slug.py` and the passing tests with no new edits.
5. Cold `uctm` launch returned `UCTM Studio is open (Codex + DeepSeek)`;
   accessibility inspection showed a `UCTM Studio` desktop window, the live
   project/session, and the conversation. `uctm doctor` returned
   `coding_harness_ready=true`, `desktop=ready`, `daemon=ready`, and
   `deepseek_transport=ready`.
6. Go tests: `./pkg/agentruntime`, `./internal/adapters/agent/codex`,
   `./internal/adapters/chatdriver/codexappserver` PASS. Frontend TypeScript
   typecheck PASS. Sidebar and TaskComposer Vitest suites: 106/106 PASS.
   `git diff --check` PASS.
7. After moving provider authentication behind the loopback proxy, a direct
   Codex shell-tool call and a resumed AO Chat shell-tool call both produced
   `KEY_ABSENT` from actual command output while DeepSeek responses still
   completed. Synthetic proxy contract tests passed 2/2. An unauthenticated
   POST to the proxy returned HTTP 401.

## Boundary and remaining work

- A subsequent Scratch prompt exposed a missing user-context path: the agent
  searched its empty worktree and concluded it knew almost nothing about
  Mohamed. Studio now accepts one bounded, private, explicitly scoped context
  card at `~/.ao/uctm-studio/permitted-context.md`. The daemon includes it in
  Codex start/resume instructions only when `UCTM_STUDIO=1`; ordinary AO is
  unaffected. The card contains only UCTM-conversation statements, identifies
  itself as non-memory, and grants no history, training, or external authority.
  This is curated context, **not** Evidence Recovery or full personal memory.
  Focused synthetic Go tests passed, including private-file, size, symlink,
  and ordinary-AO isolation checks. After rebuilding and restarting the
  local daemon, a fresh Scratch task (`scratch-2`) answered "What do you know
  about me?" using only the bounded card and stated its limits. The native
  Codex rollout recorded a developer-context message containing the card,
  `model_provider=deepseek`, and turn model `deepseek-flash`. `uctm doctor`
  reported `curated_user_context_configured=true` and
  `coding_harness_ready=true`. This is a live context-delivery check, not a
  full historical-recovery or personalization evaluation. The pre-restart
  Scratch task was terminated by the desktop shutdown; its saved conversation
  remains in Studio's local database.

- The app is a **functional local coding interface**, not the full UCTM
  architecture. Evidence Recovery, Graph Kernel, RAG++, Learned Harness,
  Harness Router, PACT/SQUID/Canonical, and training gates are **not** wired
  into Studio Chat. The older Rust CLI reports those independently and remains
  reachable with `uctm cli`.
- The current local desktop is an Electron Forge development runtime, not a
  signed release. Packaging, update identity, and long-term installation need
  a separate release gate. `npm audit --omit=dev` reported 4 production-tree
  advisories (2 high, 2 moderate) at install time; these require remediation
  before a distribution claim.
- In the synthetic repository, the AO restart recovery logged a missing
  preserved ref and left Python `__pycache__` files staged. The chat session
  and `slug.py` modification survived, but workspace restore cleanliness is
  **not** qualified. Do not infer the same behavior for real repositories.
- DeepSeek's account rate-limit API is not a Codex account API; Studio logs
  `account/rateLimits/read` as unavailable. This did not block chat or coding.
- The model is unknown to Codex's built-in metadata, so default model metadata
  may be suboptimal despite the passing live tool loop. Do not claim quality or
  performance benchmarking from this smoke test.
- A pre-proxy qualification revealed that Codex shell snapshots replayed the
  provider key into the model's shell tool despite `shell_environment_policy`.
  The first-party proxy removed the provider key from Codex's environment.
  The affected generated snapshots were absent after Codex cleanup, and a
  subsequent scan found no `DEEPSEEK_API_KEY=` assignment in this isolated
  Codex home. **Rotate the previously supplied provider key** because it was
  present in tool-visible environment and transient snapshot files. The
  proxy change prevents repetition; it cannot retroactively unexpose that key.

No protected history was hydrated, no training or external effects were
authorized, and no customized Codex checkout file was modified for this
working Responses path.
