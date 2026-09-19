# Orientation index — re-orienting by digest instead of by re-reading

Status: **implemented and verified.** `docs/uctm/ORIENTATION.v0.json` is
generated from the durable artifacts, content-addressed, and idempotent. Nothing
consumes it automatically yet: no daemon route and no spawn-time injection.

## The cost this removes

Mohamed, 2026-09-19: *"we can be reorienting ourselves at every given time … it
doesn't make sense for the onboarding to be really as long."*

A session that joins this workstream rebuilds its picture the long way: read the
receipts, read the two contracts, read the plan, walk the other sessions'
workspaces, then run `git status` — and still cannot tell whether any of it
moved since the last time it looked. That last part is the expensive part,
because it makes every re-orientation a full re-read rather than a comparison.

The pieces that already existed each answer a different question:

| Piece | Answers | Owner |
| --- | --- | --- |
| `backend/internal/service/session/lineage.go` | Who spawned whom, and where the tree degrades | other session (in flight) |
| `chatdriver/codexappserver/uctm_context.go` + CEF recall | What evidence a model turn actually received | other session (L1 live) |
| `AO_F3_*` projection + view | What facts a UCTM service published | this session |
| scratch-5's harness | Whether the evidence pipeline executed | scratch-5 |

None of them answers: **what is claimed, by whom, and has it moved?** That is
the question onboarding actually asks, and it was only answerable by reading
everything.

## What was built

| Artifact | Role |
| --- | --- |
| `scripts/uctm-orient.mjs` | Builds the packet; `--write`, `--check`, `--since <packet>`, `--json`. Pure helpers exported for test. |
| `scripts/uctm-orient.test.mjs` | 11 tests (`node --test scripts/*.test.mjs`). |
| `docs/uctm/ORIENTATION.v0.json` | The generated packet: content-addressed, snapshot of the world. |
| `docs/uctm/TEST_BASELINE.v0.json` | Which failures are already red, so nobody re-diagnoses them. |

The packet indexes: every `docs/uctm` receipt, contract, plan and gate (with its
own declared `Status:` lines, the plan's per-gate statuses, contracts' safe
claims, forbidden claims and authority invariants, and the declared next
actions); the shared checkout's branch, HEAD and **content-addressed dirty set**;
and every other session's workspace as pointers only.

## New invariants (declared here, enforced where they can be)

1. **The index is not an input to itself.** `ORIENTATION.v0.json` is excluded
   from the document scan and is reported in the dirty set without a hash.
   Without this the digest moves every time it is written, and the tool reports
   permanent drift — the failure it exists to prevent. Guarded by test.
2. **Re-orientation is a digest comparison, not a re-read.** Equal
   `orientation_id` means nothing indexed moved; the correct action is to stop
   reading.
3. **Pointers, sizes and digests only.** The packet quotes declared fields the
   repo already publishes and never copies another session's body. Guarded by
   test (a planted body marker must not appear in the serialized packet).
4. **The address is a function of the world, not the clock.** `generated_at` is
   outside the digest, so an unchanged world re-derives the same id.
5. **A write over an unchanged world is byte-identical.** Not merely
   equivalent: the previous timestamp is kept, so the artifact does not churn.

## Evidence

| Check | Command | Result |
| --- | --- | --- |
| Unit tests | `node --test scripts/uctm-orient.test.mjs` | 11 passed |
| Idempotent write | `--write` twice, `shasum -a 256` each time | both `96ba792294e971d5…` — identical |
| No drift in a still world | `--check` | `oriented: sha256:4228770306b50a5d… (content_address_matches)`, exit 0 |
| Drift fires | add `docs/uctm/DRIFT_PROBE_TEMP.md`, `--check` | `drift: part_digests_moved`, `added docs/uctm/DRIFT_PROBE_TEMP.md`, exit 1 |
| Address returns | trash the probe, `--check` | same `sha256:4228770306b50a5d…` as before the probe, exit 0 |

The last two rows are the important ones: the probe moved the address, and
removing it restored the *same* address, which is what makes "nothing changed"
trustworthy rather than merely claimed.

### What it replaces, measured

As measured at first generation: 13 documents, 34 artifacts across 8 session
workspaces, a 92-entry dirty set, and an index around 39 KB. A re-orienting
session reads that once; a session whose recorded id still matches reads
**nothing**.

scratch-10 tried to check the document-bytes total this paragraph used to quote
(152,799) and could not reproduce it: their runs read 122,728 / 124,568 / 125,823
for the same document count, and a later run reads 151,743 across 14 documents.
The figure was a point-in-time reading of a packet that no longer exists, printed
as though it were a property of the index — which makes it exactly the kind of
number a reader cannot check and should not trust. It is now stated as a
measurement with its date, and the live value is re-derivable instead:

```bash
node -e 'const p=require("./docs/uctm/ORIENTATION.v0.json");console.log(p.totals)'
```

`totals.pointed_bytes` is the sum of `documents[].bytes`, so it moves whenever a
receipt is edited and is only meaningful next to `generated_at`. The invariant
that *is* worth asserting — that the total equals the sum of its parts — holds.

## Non-claims

- A matching digest proves the indexed pointers did not move. It does not prove
  any claim behind them is true, and it is not a substitute for reading a
  receipt before acting on it.
- The session list is a machine-local observation of what has been written. A
  session that has not written anything is absent, not idle.
- The packet is a snapshot, not a monitor: it says nothing about the world
  between two generations.
- `TEST_BASELINE.v0.json` is declared, not enforced. Only a real run of the two
  suites keeps it honest.

## A correction this index caused (2026-09-19)

The first packet listed `scratch-10` with one artifact, and a reader of this
index drew a conclusion it cannot support: that scratch-10 owned the uncommitted
`/api/v1/sessions/lineage` slice. scratch-10 pushed back with the facts —
zero edits to that slice (`controllers/sessions.go`, `controllers/dto.go`), real
workspace in `~/Desktop/cognitive-hire` — and was right. Keep the scope: that
denial is about the lineage controllers, not the whole checkout, because
scratch-10 does edit `scripts/uctm-orient.mjs`. The wrong claim was corrected in place in
`scratch-11/PLAN.md` rather than deleted.

The index cannot tell anyone who wrote an uncommitted file, and a session whose
real workspace is outside the AO worker root appears nearly empty here. That is
now the third non-claim in the generated packet, next to the digests, because a
tool that makes "what is going on?" feel answered invites exactly this mistake.

It also produced one true finding: `SessionLineage` is not a generated type. Every
match is the operation id `getSessionLineage`, never a type, and the counts are
per file (scratch-5 corrected this from my looser phrasing): one literal in
`openapi.yaml` at :5059, two in `schema.ts` (`operations["getSessionLineage"]` and
the `getSessionLineage:` entry), and — beyond the op-id line — five `schemaNames`
**keys** in `build.go`, which are swaggest's package-qualified default names
(`SessionLineageReport` → `LineageReport`, and so on), not types. The real
components are `LineageReport`, `LineageNode`, `LineageCounts`, `LineageFinding`,
and `LineageWorkspace`. Two `*Source` types inline to `type: string` and never
become components, which is why the dead `SessionLineageEdgeSource` entry was
byte-neutral when removed.

The missing half was supplied by the session itself: scratch-5 confirmed they
own the delegation-lineage read, never entered `Developer/UCTM`, and touched no
`uctm*` file. The index was right that it could not attribute an uncommitted
file; it was the wrong tool for that question, and the answer came from asking.

### The generated-artifact rule this surfaced

Worth knowing before touching the contract: `apispec/openapi.yaml` is generated
by `go generate ./internal/httpd/apispec/`, and `TestBuild_MatchesEmbedded`
requires byte-equality with `specgen.Build()` while `TestRouteSpecParity`
requires 1:1 with mounted routes. Hand-editing the spec fails the suite. The
verified route is: add the operation to `specgen`, run `go generate`, then
regenerate `frontend/src/api/schema.ts` (`npm run api:ts`). Confirmed here by
re-running `go generate` and getting a byte-identical file, which is also what
proves the uctm operations come from specgen rather than from a hand edit.

**The digest this paragraph used to quote (`660ee08f4f4ee598`) is historical and
must not be cited as current.** Measured 2026-09-19 04:1x: `openapi.yaml` is
`e040107a85eb1d3e2ce40a044c6eba4d2fa3285335ad07bec711c027f3b2b8cd` and
`frontend/src/api/schema.ts` is
`bab40c184a416d4b44aa83bbd2664dd85dfc8214d1966da6d28ca22321cd1324`, with
`schema.ts` verified still byte-equal to a fresh generation from the spec on disk.
scratch-5 independently measured the same spec as `660ee08f…` and `schema.ts` as
`ddac3d7d…`, and reported `git diff --numstat` of **+517** lines for the spec where
this session measures **+523** — a six-line drift in a generated artifact that
neither of us has attributed. It is recorded as open rather than smoothed over,
because a generated file whose digest two sessions disagree about is exactly the
thing this index exists to make visible. The invariants hold either way
(`TestBuild_MatchesEmbedded`, `TestRouteSpecParity`, `TestDefaultLoadsEmbeddedSpec`
all pass, and a fresh `go generate` is byte-neutral against the file on disk); it
is the *identity* of the artifact across two measurements that is unexplained.

**Searched for the before-state; it is gone.** No copy of `openapi.yaml` exists
under `/tmp`, the AO data directory or the Codex state that hashes to `660ee08f…`,
so the six lines are not attributable from this side and the earlier measurement
cannot be re-examined. That is the terminus: `660ee08f…` is recorded as an
unexplained earlier reading, not as a second live identity for the file, and only
the timestamps distinguish the two.

The rule that falls out of this is the useful part. A digest is cited with the
timestamp and the command that produced it, because a bare digest is a claim about
a file that may have moved since — which is precisely how this paragraph came to
quote `660ee08f…` as though it were current. Two sessions comparing digests is a
weaker check than one session comparing bytes, and both are weaker than the byte
equality `TestBuild_MatchesEmbedded` and the `api:check` hop enforce. Digests are
for noticing; tests are for deciding.

### Regenerated files: identity is a path, content is an observation (2026-09-19)

The index pinned every session artifact by digest, which made the contract
self-invalidating for a workspace whose tools rewrite their own output. Reported by
scratch-5 with a measured case: their guard suite regenerates
`living-architecture/LIVING_ARCHITECTURE.md`, `living-architecture/evidence.json`
and `verification/evidence-pipeline-receipt.json`, and the receipt carries a
wall-clock `observed_at`, so every guard run moved three pointers and invalidated
the packet -- and therefore the spawn card's comparand -- as a side effect of
running the guards that were supposed to keep things honest. The documented
workflow would have had to become "run the guards, then `--write`", forever.

The fix keeps the case the index was built for and drops the one it was not. A
session may now declare, in its own workspace, which of its files a tool
regenerates:

```json
{ "volatile": ["verification/evidence-pipeline-receipt.json", "derived/"] }
```

An exact path matches one file; a trailing slash matches a directory prefix. A
declared file keeps its **identity** -- it is still listed, still counted, and its
appearance or disappearance still moves `orientation_id`, which is what "did this
session produce anything new?" means -- and loses only its **content**, which moves
into an `observations` band outside the address. So:

- a tool rewriting its own output: address unchanged; `--check` exits 0 and names
  the path; `--check --strict` exits 4. Measured end to end on a throwaway repo.
- an *authored* artifact edit: unchanged behaviour, still drift, still exit 1.
- a declared path that no longer exists: recorded as
  `volatile_declaration_missing`, because a declaration entry that can never match
  looks identical to one that matches -- the failure this workstream already hit
  once with a dead `schemaNames` entry.

The judgement stays with the producing session, so no other session has to guess
which of someone else's files are generated, and nothing changes for a workspace
that declares nothing. The evidence-to-code kernel needed no change at all: it
reads artifact digests out of the packet, so a declared file arrives there with no
digest, its node becomes identity-only, and `graph_id` stops moving for the same
reason the packet's address does.

## Next gate

1. Serve the packet from the daemon as a projection (`GET /api/v1/uctm/…`) or
   inject it at spawn time, so a session does not have to know the script exists.
   That is AO-F4's "pointer/hash records only" shape and needs the 8-kind
   contract widened deliberately, not incidentally.
2. Record the observed id per session, so `--since` can be answered from a
   remembered id rather than a previous packet file.
3. Extend the same treatment to the *product*: Studio's first-run orientation
   should be derived from evidence rather than from a long onboarding read.

## Where this went next (recorded here so a reader who starts at the index is
## not left at v0)

- **AO-F4** added the occurrence graph (`docs/uctm/GRAPH.v0.json`) and a bounded
  spawn card, so a session is handed the comparison instead of having to know the
  script. The index above stays the thing that touches the world; the graph is a
  pure function of it.
- **AO-F5** added the evidence-to-code hop: the repository paths and Go test names
  these receipts write are now nodes, so `--impact <path-or-test-name>` answers
  *"who has to re-read because this changed?"*. It also split identity from
  observation — a named file's **existence** moves the graph id, its **content**
  moves `observations.observed_id` only — which is why `--check` is a structural
  verdict and `--check --strict` is the gate for content.
- Next-gate item 3 above is the one still open, and it is the product one: Studio's
  own first-run should be derived from evidence rather than from a long read.

### A proven coverage gap, recorded rather than closed (2026-09-19)

This packet can say *what exists and whether it moved*. It cannot say *who wrote
it*, and the reason is now measured rather than assumed: authorship lives in
transcripts, AO worker transcripts are written under the redirected `CODEX_HOME`
the launcher pins (`<AO data dir>/codex/sessions` — 26 files, 70 MB), and the
passwd home's store contains no session that names the work — 0 of 457 files name
the lineage slice, and the harness home has no `sessions/` directory at all. An
index built from `homedir()` is therefore blind to an entire transcript root, the
same `$HOME` assumption that broke the session dimension.

It is deliberately not indexed here: a transcript is protected conversation
history, three orders of magnitude larger than this packet, and an index of it is
a different disclosure class. The limit is stated in the packet's own non-claims,
where a reader meets it, and stands as a gate rather than as a silent absence.

### The six-line drift, resolved (2026-09-19, after the fact)

The paragraph above records the `openapi.yaml` drift as unexplained, and that is
now closed: **it was never drift.** scratch-5 measured the spec at `660ee08f…`
before they added the two `LineageCounts` fields (`inferredEdges`, `declaredEdges`)
and this session measured `e040107a…` after those fields had landed, so a "+517"
reading and a "+523" reading were both correct measurements of two different
states of the same file, minutes apart. The file was not disagreeing with itself;
two sessions were comparing different worlds without timestamps.

The rule the paragraph draws — cite a digest with the command and the timestamp —
is therefore not merely good practice but the only form that can be correct, which
is the same conclusion this workstream reached independently for the report that
describes it. A search for the before-state found nothing because the before-state
was superseded rather than archived, and no copy exists.
