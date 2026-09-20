# CLI session bridge — SPEC v0 (2026-09-19, draft pending approval)

Goal: UCTM CLI chat/coding sessions (`~/.uctm/sessions/*.jsonl`) visible in
Studio desktop, the way AO sessions are. Tonight's driver: the DeepSeek
handoff thread exists and answers, but is invisible in the UI.

## Source format (observed, not assumed)

- One JSONL file per session, hash-chained: every event carries
  `{body{kind, seq, prev, time_ns, data}, sha256}`; chain head rules —
  broken chain = show `unverified`, never silently repair.
- Kinds seen: `session` (context_binding, policy/route digests, project),
  `turn` advisories, prompt-log entries. Bodies may reference secrets by
  handle only (keychain); display must preserve that property.

## Projection shape (read-only, v1)

New read kind `cli_session` on the existing projection surface:

- `id`: filename stem (e.g. `s-1789871591559392000-86768`).
- `display`: first user prompt truncated, else id. No model-generated titles.
- `message_count`: turn events; `last_activity_at`: max `time_ns`.
- `tail_digest`: sha256 of the chain head — the UI shows whether the file
  moved under it; `chain_ok`: bool.
- `project`: the session's bound project (from the `session` event).
- Transcript view: render turn events in order; never render raw key
  material (there is none by construction — handles only).

## Endpoint + UI

- `GET /api/v1/uctm/cli-sessions` (list, id/display/count/activity/chain_ok),
  `GET /api/v1/uctm/cli-sessions/{id}/transcript` (paginated, cap 200
  events, newest-first default).
- Studio: a "CLI threads" section beside Projects; clicking opens the
  transcript in the existing read-only UCTM view. v1 sends nothing — the
  thread continues in the terminal (`uctm chat --session ID`).

## Gates (non-negotiable)

1. Read-only: the daemon never writes `~/.uctm/sessions/`; file mode 0600
   respected, daemon runs as the owner (already true).
2. No secret expansion: handles stay handles in every rendered surface.
3. Broken chain or unreadable file degrades to `unverified`, never to
   reconstructed content.
4. v1 explicitly excludes sending/reviving CLI sessions from Studio (that is
   effect authority — a PACT-gated v2, not this spec).

## Acceptance

- Handoff session visible with correct count/activity/chain_ok.
- A deliberately corrupted copy (byte flip) shows `unverified`.
- 83-test baseline stays green; new tests: chain verification, cap/paging,
  secret-handle rendering.
- `uctm-orient --check` green.
