# AO-F4 — orientation at spawn: the evidence kernel, and a session that starts oriented

Status: **implemented and verified locally.** The orientation index now has an
occurrence graph (`docs/uctm/GRAPH.v0.json`), a bounded spawn card, and an
injection path in the daemon's prompt assembly. Nothing was deployed: the Studio
daemon binary was not rebuilt or restarted, no route was added, and no authority
was widened.

## The cost this removes

Mohamed, 2026-09-19: *"the graph kernel / evidence recovery starts to come in
because we can be reorienting ourselves at every given time … it doesn't make
sense for the onboarding to be really as long. That needs to be solved."*

The previous session built the index and left one hole, recorded as next-action 8
of the connection plan: *a session had to already know the script existed.* The
index made orientation cheap; nothing made it **automatic**, and nothing gave it
the occurrence identity that makes "what moved since I looked?" a set difference
rather than a re-read. Both are addressed here.

The spine's own open item names the same gap from the other side:
`UCTM/ACTIVE_IMPLEMENTATION.md`, "Still open" §3 — *"CEF still lacks native
occurrence-to-graph IDs."* This is a real kernel with real occurrence IDs, scoped
to this workstream's orbit. It is not CEF, and it does not claim to be.

## What was built

| Piece | Path | Contract |
| --- | --- | --- |
| Evidence graph kernel | `scripts/uctm-graph.mjs` | Pure function of the packet; `--write`, `--check`, `--stale`, `--impact`, `--card`, `--json` |
| Kernel tests | `scripts/uctm-graph.test.mjs` | 37 tests, including the four invariants that broke for real |
| Graph artifact | `docs/uctm/GRAPH.v0.json` | Pointers, occurrences, edges; no prose |
| Spawn card emitter | `scripts/uctm-graph.mjs` `--card`, `UCTM_ORIENTATION_CARD_PATH` | ≤8192 bytes, mode 0600, exactly one absolute path |
| Core injection | `backend/internal/session_manager/manager.go` | Appends the card in the `UCTM_STUDIO=1` block, after the user-context card |
| Injection tests | `backend/internal/session_manager/orientation_card_test.go` | 6 tests, including fail-closed and the cross-language read |
| Launch wiring | `bridge/studio_launcher.py` | `UCTM_ORIENTATION_CARD_PATH` + `state_dir` in the doctor; state dir resolves through `AO_DATA_DIR`/`UCTM_STATE_DIR` so a rewritten `$HOME` cannot silently export the card empty |

### The two handles

Every node carries an identity and an occurrence:

- `id` — `role:key`, e.g. `document:docs/uctm/READINESS_CONTRACT.json`. Stable
  while the thing exists, and deliberately **not** a content digest.
- `occurrence` — `occ:<hex32>` over the identity plus the recorded content
  address. A file whose bytes change keeps its `id` and gets a new `occurrence`.

That split is the whole point: a session that recorded the occurrence set can
answer "did anything I depend on move?" by comparison, and `--impact <path>`
walks the `cites` edges to say who has to be re-read because of it.

### What the card actually says

The card is the delivery mechanism. It carries the `orientation_id` to compare
against, the one command that performs the comparison, the evidence kernel's
`graph_id`, the worktree head and dirty count, and the instruction to **stop
reading** when the id matches. It carries no session name, no document list and
no other session's workspace: the emitter refuses to write a card that names any
absolute path other than the checkout root, and a test asserts it.

The injection is the same shape as the existing bounded user-context card
(`AO_F2`/`LOCAL_HOST_QUALIFICATION_2026-09-18.md`): absolute path, regular file,
mode 0600, at most 8192 bytes, and a configured-but-unreadable card **fails the
spawn** rather than silently disappearing. Both cards are read through one shared
bound -- two thin per-card wrappers, `readUCTMContextCard` (`manager.go:3632`) and
`readUCTMOrientationCard` (`:3641`), both delegating to `readPrivateCard` (`:3649`),
which is where absolute / regular / `Perm&0o077 == 0` / `Size() > 8192` are enforced.
One shared bound, two call sites: the two cards cannot drift apart in what they
accept, and a reader who needs to know which card was rejected reads the label
`readPrivateCard` was given.

## Invariants, including the two that were learned the hard way

1. Identity is not content. A moved file keeps its `id`, changes its `occurrence`.
2. The address is a function of the world, never of the clock. `generated_at` is
   outside `graph_id`; two derivations of one packet are byte-identical.
3. **The graph is not an input to itself.** `GRAPH.v0.json` is not a node.
4. **Derived indexes are not inputs to each other.** `DERIVED_INDEX_PATHS` is one
   list in `uctm-orient.mjs`; the packet excludes the graph from its document scan
   *and* its dirty digest, and the graph excludes both. This is the fix for a real
   divergence: before it, `--write` on each file made the other stale, forever —
   the same permanent-drift bug the orientation index hit when it digested itself,
   one layer down. Three consecutive writes of each are now byte-identical.
   *(Amended 2026-09-19: the packet half of this was **claimed and not true** — it
   excluded the graph from the *hash* while still listing it in `dirty`,
   `dirty_count` and `dirty_id`, so a write still moved its own id. See the
   correction section below.)*
5. No dangling edges, no duplicate node ids: the builder throws instead of
   dropping an edge.
6. Pointers, not prose. No document or artifact body is copied into the graph;
   action nodes carry a ≤160-character label so the query is usable, and the
   non-claims say the plan is the text.
7. Verification never widens the scan. `--stale` re-hashes only paths the packet
   named; it cannot discover a file. A file the packet did not name cannot become
   a citation target either.
   *(Amended 2026-09-19: this now governs the session dimension too. A root that
   could not be read may not be turned into a `removed` line, and a dimension that
   was not compared may not be reported as verified.)*
8. "Not checked" and "checked and unchanged" are different claims, so the worktree
   and session nodes are reported as skipped with a reason rather than counted as
   verified.
9. Drift is reported by role. On a shared checkout with other sessions writing,
   a non-empty moved list is normal, so both reports end with
   `by role  artifact 2` — which answers "is any of this mine?" without walking
   the ids.

## Evidence

| Check | Result |
| --- | --- |
| `node --test scripts/*.test.mjs` | **53 passed** (23 new kernel + 30 pre-existing index/pod-gate) |
| Kernel convergence | `ORIENTATION.v0.json` and `GRAPH.v0.json` written three times each, byte-identical from the second write; both `--check` exit 0 |
| `--stale` on the live checkout | `recorded_digests_match`, 0 moved, 0 missing; the worktree and the eight session nodes are reported skipped with a reason, not counted as verified |
| `--impact docs/uctm/READINESS_CONTRACT.json` | a two-depth reader closure over real cross-references, including this receipt |
| Drift probe | appending one byte to an indexed document made `--stale` exit 1 and name exactly `document:docs/uctm/TEST_BASELINE.v0.json`; the probe was reverted and `--stale` returned to 0 |
| Live drift, caught unplanned | while this receipt was being written, `--stale` reported two moved **artifacts** (`scratch-5/…/MISTAKES.md`, `scratch-5/…/DELEGATION_LINEAGE_RECEIPT.md`) and nothing else, and `uctm-orient --check` named the same two paths. Another session's live writes were detected by digest, with no scan of their prose. |
| The card's command, run for real | from `cwd=/tmp`, `cd "/Users/mohameddiomande/Developer/UCTM-Studio" && node scripts/uctm-orient.mjs --check` exited 1 and printed exactly three paths — `scratch-5/living-architecture/LIVING_ARCHITECTURE.md`, `scratch-5/living-architecture/evidence.json`, `scratch-5/verification/evidence-pipeline-receipt.json`. That is the whole onboarding answer for a session with no context: three paths, all another session's, and no receipts read. |
| The same mechanism, one minute later | the next run reported `scratch-11/PLAN.md` and `scratch-11/REPORT.md` — this session's own files, moved by this session while writing this receipt. Same tool, same exit code, opposite answer, and the `by role` line said `artifact 2` both times. |
| Card | mode `0600`, under the 8192-byte cap, exactly one absolute path (asserted by `absolutePathsIn`) |
| `go build ./...` | ok |
| `go vet ./internal/session_manager/` | clean |
| `go test ./internal/session_manager/ -count=1` | ok (full package, 23s) |
| Cross-language contract | `UCTM_ORIENTATION_CARD_PATH=/tmp/orientation-card.md go test -run TestConfiguredOrientationCardIsReadable` → PASS: the Node emitter's card is a card the Go reader accepts |
| `gofmt -l` on changed Go files | empty |

The index itself recorded the change as designed: this receipt is a new document,
and regenerating the packet moved `orientation_id` while `--stale` kept reporting
that every *recorded* digest still matched.

The injection block is already live in the running AO instance — this session's
own system prompt carries the permitted user-context card, which the same
`UCTM_STUDIO == "1"` block produces — so the orientation card rides a path that
is known to reach a session's prompt. What the deployed `frontend/daemon/ao`
predates is only the second read, which is why the effect begins at the next
Studio launch rather than now.

## Non-claims

- The kernel is not CEF, not the graph/RAG provider the spine is waiting for, and
  not connected to the spine.
- An edge means a document names a path. It is not an author's acknowledgement,
  an approval, or a declared dependency. Impact means "may need re-reading".
- The card is a pointer set, not evidence. A digest proves a pointer moved.
- `--check` on the kernel answers "does the kernel match the packet on disk?", not
  "has the world moved?"; the kernel prints that scope, and `uctm-orient --check`
  remains the gate for the world.
- The card cannot be delivered by a Codex hook. scratch-6 probe-verified that the
  hooks under `~/.codex/hooks/` do not execute for AO-spawned sessions at all —
  they are untrusted and silently skipped — so a hook-delivered card would never
  fire. A silent skip is the worst mechanism for an artifact whose whole job is to
  say what the world looked like, which is why the delivery path is
  `manager.go` + `UCTM_ORIENTATION_CARD_PATH` and not a hook.
- The packet can never be the card: `docs/uctm/ORIENTATION.v0.json` is two orders of
  magnitude over the reader's bound and group/world-readable, so it would be rejected
  on two counts. Cite the bound and not the bytes -- the packet is regenerated on
  every write, so a size pinned here goes stale within minutes; measured for the
  record, it was 68,091 B and the card 3,591 B, both at 2026-09-19T09:51:22Z. The
  `orientation.md` card exists as a separate artifact for exactly that reason, and the
  two cards use separate environment variables so a missing orientation card can
  never take the permitted-context card down with it.
- Nothing here is a live service. The daemon was not rebuilt or restarted, and the
  card takes effect at the next Studio launch.
- The `manager.go` append is uncommitted: `git status` shows it modified in the
  working tree while the last commit that touched the file is still an older one, so
  "quiet since" is true of the commit and false of the tree. Read the file, not the log.
- The index cannot be current while other sessions are writing, and that is not a
  defect to be papered over: `--check` will usually exit 1 in this checkout, and
  the answer is the moved list, which is bounded and already filtered to the paths
  that actually moved.

## Next gate

1. **Mohamed:** rebuild/redeploy the Studio daemon so the injection ships, and
   decide whether the orientation card is generated at launch (cheap, but the card
   may lag the world) or by the worker that edits an indexed artifact (current
   design, and the card says how to check itself).
2. Record the observed `orientation_id` per session, so `--since` is answered from
   a remembered id instead of a previous packet file.
3. Extend the kernel's edge extraction beyond documents and session artifacts —
   receipts name `backend/` paths and test names, and that is the join the spine's
   occurrence-to-graph work actually needs.

## Correction — the session dimension, and three false signals (2026-09-19)

scratch-5 audited `--check` from an AO worker shell and reported that it exits 1
with 33 `removed` lines, and that `--write` run from that same shell persists a
packet with `sessions: []` over one holding 34 artifacts. They were right about
the defect, and scratch-6 and scratch-10 reported the same failure independently.
It is resolved below, in their favour.

**Resolved: all three reporters were right, and the resolution is scratch-10's.**
The failure does not reproduce for me because the resolver had already been
repaired in this checkout before I ran it. It did reproduce, though, in the worker
sessions that ran the pre-fix default while `$HOME` was the harness home: scratch-10's
03:05 run reported `removed=34 added=0 changed=1`, and their 03:09 matrix recorded 37
false deletions alongside `session_scan_through_harness_home`. The passwd-home
fallback -- scratch-10's own fix -- is what now masks it, so "not reproduced here"
is a statement about the repaired file, never about the original report.
scratch-10 fixed `scripts/uctm-orient.mjs`
at 03:11 — roughly 35 minutes before this session's first edit to that file. **That
clock is inherited rather than measured**: scratch-10's receipt and the script are
both outside the shared checkout, so a third party can re-run the behaviour but
cannot re-derive the timestamp, and scratch-5 recorded it on exactly that basis.
Their fix is still in place, not overwritten: `workersRootState()`, the two
`refusing to write` strings and the "wins if it exists" resolution order are all in
the current file. The suite arithmetic corroborates it. Their receipt records
"13 tests, was 11" for `scripts/uctm-orient.test.mjs`, and graph 23 + orient 13 +
pod-gate 17 = 53, which is exactly the baseline this session inherited; the orient
file now carries their two regression tests inside its 21.

The decisive detail is in scratch-10's receipt: the pre-fix default had **no**
passwd-home candidate at all, it was `join(homedir(), suffix)` and nothing else.
The fallback this section originally cited as evidence that their report was
environment-dependent is *their own fix*. So the earlier versions of this section
were wrong twice: the trigger is not unresolved, and **environment-dependent is the
wrong word for it**. The property is **version-dependent**, and scratch-5 supplied
that term: the pre-fix default had exactly one candidate, `join(homedir(), suffix)`
and nothing else, so it failed *deterministically* for every AO worker rather than
on some machines -- which is why three peers reported it independently and why the
same command cannot reproduce it now that a fallback exists. "Version-dependent"
describes both facts; "environment-dependent" describes neither, and it is the
word that made a certain defect sound like a flaky one.

Two things make this resolvable on disk rather than a matter of testimony, and both
are in files rather than in anyone's recollection: `scripts/uctm-orient.mjs`
documents the pre-fix derivation in its own comment -- "This was derived from
`homedir()` alone" -- and `scripts/uctm-orient.test.mjs` pins the post-fix property
in a test titled "the session root does not follow `$HOME` into the harness", which
asserts the missing root is the whole bug. The defect is therefore not unresolved;
it is unreproducible by construction, because the code that had it is gone and the
test that replaced it is the evidence of what was removed.

It was **fixed under me**, by the session that reported it, and I
tested a repaired file while three peers tested the broken one. The falsified
premise came from this session's own handoff, which described the post-fix
resolver as though it had always been there — a reminder that a handoff is a
claim, not a baseline.

What this session added on top of their fix is the third state. Their
`workers_root_state` was `present | missing`; a root that stats but cannot be
listed is neither, so it is now `read | missing | unreadable` — and a dimension
that was not read exits 3 with `incomplete:` rather than being compared as if it
were empty. scratch-10's verifier, run unchanged against the current file, prints
the improvement directly: scanning through the harness-home root now reports
**0 false deletions** (all 34 before), `missing_root` check exit 3 / write exit 2,
and the write-over-unchanged-world row byte-identical.

What is not in doubt is the defect underneath, which reproduces on demand: the
silent swallow turns any unreadable or missing root into "every artifact was
deleted". Forcing the root to the harness-home path today gives exit 3, an
`incomplete:` line and zero `removed` lines; comparing the session dimension anyway
gives 60. `--where` exists because three reports deserved one command that answers
the question instead of an argument about shells.

**Confirmed, and reproducible here: the silent-empty read.** `collectSessions`
ended in `catch { return [] }`, so "this process cannot read the root" and "there
are no sessions" produced the same value. Both consequences reproduce:

- a *missing* root diffed every recorded artifact as `removed` —
  `UCTM_WORKERS_ROOT=/nonexistent/workers node scripts/uctm-orient.mjs --check`
  printed them before this fix;
- `--write` from such a shell persisted a packet with `sessions: []`, and the next
  correct-root `--check` then reported all of them as `added`. That second false
  alarm is against an artifact that is genuinely wrong, which makes it worse than
  the first.

Their first suggestion — throw on an unreadable root — was rejected in favour of
their second, the dimension-skipping design, because a throw leaves a sandboxed
worker with no recourse and no information about which root to name. The honest
primitive in every shell is "this dimension is unknown"; the place to be fatal is
the write, not the read. Their third suggestion, defaulting from the AO data dir
rather than `homedir()`, is implemented: the root is now resolved
explicit > `UCTM_WORKERS_ROOT` > `AO_DATA_DIR` > `$HOME` > passwd home, so a shell
whose `$HOME` is a lie still lands on the daemon's data dir.

**Two more false signals found while fixing it, in the same channel.** A drift
report is only worth reading if every word in it is true, so these are recorded
even though nobody reported them:

- `diffOrientations` compared artifact pointers, while `orientation_id` also
  covers the worktree dirty digest, the next-actions list and the machine-local
  block. `--check` therefore printed `oriented:` while the id had moved — a false
  negative that is worse than noise, because the reader is told to stop looking.
- `diffOrientations` returned `reason: "part_digests_moved"` with empty
  `changed`/`added`/`removed` and `unchanged: true`. A caller reading only
  `reason` was told digests had moved and could not name one.
- the amendment to invariant 4 above: the packet listed the derived indexes in its
  dirty set, so writing an index moved the index's own content address, and the
  next `--check` reported "the worktree dirty set moved" about the tool's own
  write. `uctm-graph.mjs` already documented the correct rule and filtered
  `!entry.self` itself; the packet did not.

### The contract, stated once

| Command | Exit | Meaning |
| --- | --- | --- |
| `--check` / `--since` | 0 | every dimension was compared and matched |
| `--check` / `--since` | 1 | drift; the paths that moved are printed |
| `--check` / `--since` | 3 | a dimension could not be read here: printed as `incomplete:`, never as `oriented` |
| `--where` | 0 / 3 | the recorded root matches this run / differs from it |
| `--write` | 2 | refused, because it would erase session pointers or silently change the recorded root |

`--where` prints the resolved root, its state (`read` / `missing` / `unreadable`),
the recorded root with `(same)` or `(DIFFERENT …)`, and every candidate in order.
The spawn card and `AGENTS.md` now carry all three exit codes, because a worker
that only knows "0 means oriented" reads an unread dimension as a clean bill.

### Evidence for this correction

| Check | Result |
| --- | --- |
| `node --test scripts/*.test.mjs` | **61 passed** (was 53; +8 covering the read states, the skipped dimension, the id-moved reason, the root-change refusal, candidate order, the derived-index dirty set, and two end-to-end CLI fixtures) |
| `UCTM_WORKERS_ROOT=/nonexistent/... --check` | exit 3, `incomplete:`, **zero** `removed` lines |
| unreadable root (mode 0000) | `readSessions` → `unreadable` (`EACCES`); `--write` → exit 2 refusal; the packet on disk still holds its session |
| `--write` then `--check` on a commit-backed fixture | exit 0, `content_address_matches`; the index it wrote is absent from its own dirty set |
| both `--check` after regenerating in order | `oriented: … (content_address_matches)` and `kernel current`, both exit 0 |

To reproduce: `node --test scripts/uctm-orient.test.mjs`, then
`node scripts/uctm-orient.mjs --where`, then
`UCTM_WORKERS_ROOT=/nonexistent/workers node scripts/uctm-orient.mjs --check`.

### What is still open

- The derived-index dirty fix re-keys `orientation_id` once. That is the cost of
  making the packet's own claim true, and it does not recur.
- `--check` still exits 1 in this checkout whenever another session writes. That
  is correct and is the case this tool was built for; the answer is the bounded
  moved list, not a quiet pass.

## Amendment 2026-09-19 (2) — the daemon read is a paired control, because the package verdict hides the skip

`go test ./internal/session_manager/` prints `ok` whether or not the configured-card
test ran: `TestConfiguredOrientationCardIsReadable` skips when
`UCTM_ORIENTATION_CARD_PATH` is unset, so two different facts produce an identical
verdict. That is how "the daemon reads the card" can be reported as verified while
nothing exercised the card — the same class as a `schemaNames` entry that can never
match, and it is the reason this section exists rather than a note saying the suite is
green.

Reproduced independently (scratch-6 raised it; re-run here 2026-09-19T10:06Z):

| invocation | tests | package verdict |
| --- | --- | --- |
| `UCTM_ORIENTATION_CARD_PATH=<card> go test ./internal/session_manager/ -run Orientation -v -count=1` | 5 RUN, 5 PASS, including `TestConfiguredOrientationCardIsReadable` | `ok … 0.603s` |
| `env -u UCTM_ORIENTATION_CARD_PATH go test ./internal/session_manager/ -run Orientation -v -count=1` | 4 PASS + 1 SKIP | `ok … 0.317s` |

The claim is therefore only meaningful with the variable set **and** the skip count
read from `-v`. A future reader citing `ok` alone has cited nothing.
