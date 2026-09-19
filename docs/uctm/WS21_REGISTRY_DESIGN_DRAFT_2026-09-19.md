# WS2.1 versioned native identity registry — DESIGN DRAFT, unapproved (2026-09-19)

Status: **design proposal, no code.** Implementing it is M2 work; this draft
exists so the build starts from a frozen shape. Requirement (CONNECTION_PLAN
WS2.1): registry with version, host/session/turn/item identity + digest
witness per occurrence; migration rule for ambiguous legacy records (stay
`review`).

## Observed current state (what this replaces)

Identity today is scattered and versionless: delivery receipts carry
`source_occurrence_id` + `native_turn_id` + `content_sha256` (opaque strings,
no registry behind them); the twin WORM stores `source_path, byte_offset,
line_sha256, text_sha256` with no version and no host binding. Nothing answers
"which registry version minted this identity" or "what happens to records
that predate the registry."

## Proposed record (`uctm.native-occurrence.v0`)

| Field | Meaning | Required |
| --- | --- | --- |
| `registry_version` | `uctm.native-occurrence.v0`; bumped on any field change, old readers refuse newer versions | yes |
| `host_id` | stable machine identity (not hostname alone) | yes |
| `session_id` | native session (Codex thread, AO session) | yes |
| `turn_id` | native turn within the session | yes |
| `item_id` | item within the turn | yes |
| `source_path` | absolute source path at registration | yes |
| `byte_offset` | offset at registration | yes |
| `line_sha256` | digest of the source line(s) at registration | yes |
| `text_sha256` | digest of normalized text at registration | yes |
| `registered_at` | RFC3339 registration time | yes |
| `status` | `admitted` \| `review` | yes, default `review` |

## Witness rule (the point of the registry)

Every read re-resolves `source_path` + `byte_offset` and recomputes both
digests. Match → usable with the registry version cited. Mismatch or
unreadable source → the occurrence drops to `review`, never silently
re-admitted. This is the existing drift-rejection behavior (gate §1) with a
version and a name, so a reader can distinguish "registry v0 says admitted"
from "nothing vouches for this."

## Hard rules (from the gate, non-negotiable)

1. Never derive identity UUIDs from line numbers or ranking. The
   `source_occurrence_id` is minted once at registration (random v4) and
   stored; it is never recomputed from position.
2. Default-deny: any record missing any required field registers as `review`.
3. Legacy migration: all pre-registry records (current receipts, WORM rows)
   import as `review` with `registry_version` set to the importing version
   and a `migrated_from` note. Promotion to `admitted` requires a fresh
   witnessed read, one occurrence at a time. No bulk promotion, ever.

## Placement (proposal)

Registry lives with the Evidence Recovery index (it mints identities at
ingest); CEF consumes it read-only at slice build and cites
`registry_version` in the bundle; the Studio receipt gains a
`registry_version` field. One writer per store (plan §M5): ER owns writes,
CEF and Studio read.

## Acceptance mapping

- Registry version present in every occurrence → schema requires it.
- Ambiguous fixtures stay review → migration rule + default-deny, covered by
  a fixture test with one legacy record per missing-field case.
- Out-of-slice decoy cannot cause a read → WS2.3's test, unchanged; the
  registry only strengthens what "admitted" means underneath it.
