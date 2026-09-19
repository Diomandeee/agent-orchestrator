# AO-F5 — the evidence-to-code hop: which claims does this file change invalidate?

Status: **implemented and verified locally.** The evidence kernel now resolves the
repository paths and Go test names the indexed receipts write, so a file another
session just edited names the claims that have to be re-read. Nothing was
deployed, no route was added, and no authority was widened.

## The gap this closes

AO-F4 ended with a recorded limit, quoted from its own report: *"Edges cover
documents and session artifacts only. A receipt naming a `backend/` path or a
test name produces no edge yet — that is the next gate, and it is the join the
spine's occurrence-to-graph item actually needs."*

That was the join that mattered. Every session in this workstream verifies with
the same three sentences — *"`TestBuild_MatchesEmbedded` passes"*, *"`go
vet ./...` is clean"*, *"I did not touch `internal/service/session/lineage.go`"* —
and none of them produced an edge. So the most common question a reorienting
session has, **"someone changed a file; do I need to re-read anything?"**, still
had to be answered by reading receipts and grepping them by hand.

## What was built

| Piece | Contract |
| --- | --- |
| `collectCode()` in `scripts/uctm-graph.mjs` | reads only indexed documents, extracts path-looking and `Test*` tokens, and resolves them against the checkout |
| `code` node role | a path an indexed document named that exists in this checkout |
| `test` node role | a Go test name exactly one scanned file declares, with its source span |
| `declares` edge | the file declares the test; `cites` gains the document→path and document→test forms |
| `observations` stanza | the content addresses of those nodes, **outside** `graph_id` |
| `--check --strict` | exit 0 current, exit 4 when a named code path or test has moved |
| `impactOf()` | now walks `declares` forward and `cites` backward, and accepts a bare test name |

Resolution has two steps and no walk. A token resolves exactly, from the checkout
root; failing that, as a **unique suffix of the repository file index**
(`git ls-files --cached --others --exclude-standard`, so untracked-but-not-ignored
files are included and `.gitignore` is honoured). That is what makes a receipt
that writes `specgen/build.go` mean
`backend/internal/httpd/apispec/specgen/build.go`, without the kernel ever
guessing: two matches resolve to neither and are recorded as ambiguous.

## Invariants declared here

1. **Existence is identity; content is observation.** Adding or removing a file a
   receipt names moves `graph_id`. Editing one moves only
   `observations.observed_id`. A live checkout is edited continuously, so an
   identity that moved on every keystroke could never report "nothing moved" —
   the one answer that makes re-orientation free. The cost is stated, not hidden:
   `--check` is therefore a *structural* verdict, and `--check --strict` (exit 4)
   or `--stale` is the gate for content.
2. **A `cites` edge means the document wrote that name.** A file that entered the
   graph because a document named a test it declares is reached *through* the test
   node, never through a direct `cites` edge — the text names a test, not a path,
   and an edge that overstated it would be a reading the evidence does not support.
3. **A name resolves only when it is unambiguous.** Exact path, or a unique suffix
   of the repository index. Anything else is recorded as unresolved with its
   reason, never dropped and never guessed.
4. **An unread dimension is not an empty one, here too.** `scan.root_state`,
   `scan.repo_index_state`, `scan.truncated` and `unresolved_by_reason` are part
   of the artifact; a missing git index is `unavailable`, not "no files".
5. **A test is a span, not a name.** A `test` node's content address covers the
   bytes from its `func <Name>(` line to the next column-0 `}`, so a test whose
   body changed moves and a test with a declaration inserted above it says so
   (`moved_within_the_declaring_file`) rather than reporting the same thing.

## Measured

`node scripts/uctm-graph.mjs --write`, 2026-09-19T08:22Z, branch
`codex/uctm-interface-v0` @ `26f88b09d93c` — the counts in the `now` column are
from that write, and see the note under the table about why they were already one
edit old when you read this:

| | v0 (AO-F4) | now |
| --- | --- | --- |
| nodes / edges | 142 / 194 | **165 / 235** |
| `cites` / `declares` | 109 / 18 | **144 / 24** |
| code / test nodes | 0 / 0 | **51 / 7** |
| observable content addresses | 99 | **157** (99 in the identity, 58 outside it) |

`graph_id sha256:be628be1042bb2abf05b52160fdd7be310f326a97c339db08ad49e806d46d511`,
`observed_id sha256:76912fe5b4a8536890f0e31845f2bf4036c23bf2950fc2c0cb3a1c7083269565`
at that write. Resolution: 26 from the checkout root, 20 by unique suffix, 5
because a named test declared them. Scan: 14 documents, 2818 index entries, 105
test files, `truncated: false`. 15 names did not resolve and are listed with
reasons — including
`scripts/hybrid_context_recovery.py`, which the plan cites and this checkout does
not hold, and ten paths (`src/service.rs`, `mcp_server/…`) that belong to the
spine rather than to Studio.

**This receipt is itself an indexed document**, so adding it added a node: the
graph immediately after this file existed reads **170 nodes / 246 edges, 15
documents**, and 151 `cites`. That is not drift and not an error — an artifact
that describes the index becomes part of it, and its own measurements are
therefore one edit behind by construction. The same is true of the live counts
above: the artifact counts move as other sessions write into their workspaces.
Citing an absolute count without the write it came from is the mistake this
workstream has already recorded once, which is why the timestamp and command are
here and the ids are labelled as of one write rather than as current.

The load-bearing invariant was proved on the real tree, not only in a fixture:
one byte-level edit to `scripts/uctm-graph.mjs` (a file three receipts name) left
`graph_id` **unchanged** and moved `observed_id`; the file was restored
byte-identically (`sha256:04d1a9f0a6a80eb3…`) and both ids matched the recorded
artifact again.

The answer the hop exists to give, 2026-09-19T08:21Z:

```
$ node scripts/uctm-graph.mjs --impact backend/internal/httpd/apispec/specgen/build.go
target code:backend/internal/httpd/apispec/specgen/build.go
  depth 1  document:docs/uctm/AO_F3_FRONTEND_PROJECTION_2026-09-19.md
  depth 1  document:docs/uctm/INTEGRATION_ENDPOINTS.v0.json
  depth 1  document:docs/uctm/READINESS_CONTRACT.json
  deeper   22 more at depth 2..3 (document 5, action 17) -- --json for the full closure
```

`--impact TestBuild_MatchesEmbedded` answers to the bare name a session reads in a
receipt. Depth 1 is printed whole and the transitive hull is summarised: printing
the closure in full buried the answer in documents that cite documents.

## Evidence

| Check | Result |
| --- | --- |
| `node --test scripts/*.test.mjs` | **72 passed, 0 fail** (was 61; 11 are new, kernel now 34) |
| `node scripts/uctm-graph.mjs --write` twice on an unchanged world | byte-identical (`6fab3453cc50722d…`) |
| `--check` | exit 0, `observations: 58 of 58 unchanged` |
| `--check --strict` | exit 0; exit 4 is the moved case, pinned by test |
| `--stale` | re-hashes the code and test nodes too (`observed 58 code/test nodes`) |
| card | 2240 bytes, mode 0600, one absolute path, under the 8192-byte cap |
| `go test ./internal/session_manager/` with `UCTM_ORIENTATION_CARD_PATH` set | ok — the daemon's own reader accepts the regenerated card |
| `go build ./...`, `go vet ./...` | clean |

## Non-claims

Two limits of `--impact` were named by scratch-10 rather than by me, and both are
recorded here and in the graph's own `non_claims` because a reader will meet them
before they meet this document:

- **An indexed artifact is a pointer, not a body.** A session receipt's own
  cross-references are not extracted, so `--impact <path>` will not name the receipt
  that quotes that path -- only the session that produced it. The invariant is
  working (foreign bodies are never parsed), and the consequence is that the closure
  omits the class of artifact most likely to go stale, including the record of the
  change being asked about.
- **`--impact` is not "what breaks if this moves".** A test file that no indexed
  document names is absent from the closure even when it pins the file in question.
  Inferring an edge from a `<name>.test.mjs` convention would close the practical gap
  and violate the rule that made this kernel useful, so v0 records the non-claim
  instead: the closure is a reading list, not a test plan.

- A `code` node is a name that resolved here. An unresolved name is recorded with
  its reason, but the scan is bounded to the documents the packet indexed, so
  absence proves nothing about a file in another repository.
- A `test` node is `func <Name>(` at the start of a line. It is not a build
  result, not a passing run, and not evidence the test ever executed.
- Impact is "may need re-reading", never "is wrong". A moved occurrence proves
  bytes moved and nothing else.
- The hop is one direction: claims name code. It does not say the code
  implements the claim, and no test result is attached to any edge.
- Go test names only. `vitest` and Playwright specs are named in the receipts and
  still produce no node.
- The repository index is read from `git`. A checkout without git resolves exact
  paths only, and says `repo_index_state: unavailable` rather than resolving
  relative names wrongly.

## Next gate

1. The same hop for the frontend suites: `vitest` describe/it names and Playwright
   spec titles are cited in receipts exactly as Go test names are.
2. Attach a *result* to a test node — the last run and its outcome — so "this
   claim's test is green" stops being prose. That is a runtime record, not an
   index, and it needs a contract of its own.
3. Let a claim name a *line*: `build.go:158` already appears in these receipts,
   and a span occurrence would collapse "the file moved" to "the thing moved".

## Amendment 2026-09-19 — a bare filename is a citation too, and widening the pattern found a self-reference

**Why it changed.** The extractor's pattern required at least one `/`, so the hop could
only see `specgen/build.go` and never `build.go`. That is the wrong trade for this
repository: the receipts write the bare name far more often than the full path, which
made the hop blind to exactly the files under discussion. Measured over the 15 indexed
documents before changing anything: **107** bare tokens, of which **38** resolve by
unique suffix and **1** exactly from the root, **29** are ambiguous, and **39** point
outside this checkout. The new edges the resolver would gain included `build.go`,
`package.json`, `uctm-graph.mjs`, `styles.css`, `deepseek_proxy.py` and six of the
`text-accent` sites — the files sessions actually edit.

**The change is one character of meaning.** The directory part of the path pattern went
from `(?:[\w.@-]+/)+` to `(?:[\w.@-]+/)*`: optional, not required. The resolver is
untouched, so a bare name is resolved by the same two bounded steps as any other token —
exact from the root first, then a unique suffix of the git file index — and a bare name
that two files could mean is recorded as ambiguous rather than resolved to the likelier
one. The lookbehind is what makes this safe: a token preceded by `/`, `.`, `@`, `-` or a
word character still cannot match, so a bare name can never be carved out of the tail of
a longer path.

**The bug widening created, caught by `--check` on the live tree rather than by reading.**
`GRAPH.v0.json` is not the string the packet excludes — `docs/uctm/GRAPH.v0.json` is — so
the token passed the exclusion, resolved to the graph's own file, and became a
`code:docs/uctm/GRAPH.v0.json` node. That is an index that is an input to itself: every
write would move its own observation, `--check --strict` could never be green again, and
the failure mode is the same one §"Invariants" records twice already. The guard now runs
on what a token **resolved to**, not only on the token — `alreadyNodes.has(path) ||
EXCLUDED_DOCUMENTS.has(path)` inside `placePath` — which also stops a packet document or
a session artifact from acquiring a second node under a code role. Two tests were added:
one for a bare name resolving exactly from the root and by unique suffix, one asserting
that a name resolving to a derived index or to a document yields no node and no
`unresolved` entry.

| | before this amendment | after, `2026-09-19T08:55Z` |
| --- | --- | --- |
| nodes / edges | 171 / 248 | **180 / 265** |
| `cites` / `declares` | 152 / 24 | **169 / 24** |
| code / test nodes | 51 / 7 | **60 / 7** |
| `unresolved` records | 15 | **50** (38 not in this checkout, 8 ambiguous, 4 undeclared tests) |
| `node --test scripts/*.test.mjs` | 72 passed | **74 passed, 0 fail** |
| `graph_id` | `a59656c6c1741c5b…` | `97e53886de08c940…` |

The `unresolved` list is the honest cost, and it is stated rather than trimmed: it now
carries every bare name a receipt uses that this checkout cannot settle — `manager.go`
(six files could mean it), `service.go` (ten), `openapi.yaml` (two, the spec and a cloud
contract), plus the Rust CEF service and the planned `Uctm*.tsx` components, which live
in another repository entirely. Those are recorded, not guessed, which is the same rule
the relative-name path already followed.

**Provenance note, because this file is itself indexed.** The numbers above describe the
world at the moment they were measured, before this section existed. Writing them moved
the graph again, for the reason recorded in `scratch-11`'s `REPORT.md` §14a: a document
cannot carry the content address of the world that contains it. Read the numbers as a
past measurement with a timestamp; run `--check` for the current answer.

## Amendment 2026-09-19 (2) — the kernel's own fail-open: "cannot look" reported as "gone", and as "clean"

scratch-10 reproduced this against a readable workers root holding one workspace
directory this process cannot list (`mkdir -p $ROOT/scratch-1 && chmod 000 $ROOT/scratch-1`).
Two of the three findings were in this file's kernel:

| command | before | now |
| --- | --- | --- |
| `uctm-orient.mjs --check --workers-root $ROOT` | uncaught `EACCES` from the recursive walk, **exit 1** with a stack trace where the moved-path list belongs | `partial`, names the unreadable session, **exit 3** with `incomplete:` — fixed by the partial-scan work before this amendment; re-verified, not assumed |
| `uctm-graph.mjs --workers-root $ROOT` | **exit 0**, no warning, artifact-poor graph | names the root state on stderr, and a packet recorded over a partial root is named too |
| a path this process may not read | filed under `missing` | filed under `unreadable`, and the verdict becomes `incomplete_unreadable` |

**Why it matters more than a wrong label.** Exit 1 is the drift code, so a crash read
as "something moved"; `missing` is a claim the scan did not make; and a verdict built
on either reports a dimension nobody read as clean. That is the fail-open direction,
inside the tool built to close it.

**What changed.** `isUnreadableError()` separates `EACCES`/`EPERM` from everything
else; `verifyGraph` and `verifyObservations` carry an `unreadable` list beside `moved`
and `missing`; `verifyGraph().state` gains `incomplete_unreadable`; the CLI prints
`unreadable` lines and returns **3** with `incomplete:` when any named path could not
be read, in `--check` and in `--stale`, so a partial verdict can never present as
exit 0. `packetRootWarning()` names a packet recorded over a `partial`, `missing` or
`unreadable` root — necessary because the kernel reads the packet rather than rescanning
the workers root, so a partial packet used to yield a silently artifact-poor graph.
And `workersRootState()` in `scripts/uctm-orient.mjs` now answers the resolver's own
vocabulary — `read | unreadable | missing` — instead of `present | missing`, which
could not see a permission failure at all: one function, one answer.

**Verified.** 87 JS tests pass (2 new). The new test was shown to fail before being
trusted: forcing `isUnreadableError` to `false` gives
`✖ a permission failure is not a deletion, at either level` / 38 of 39 in that file.
End to end: an unlistable root now warns `session workspace root is unreadable`;
a packet temporarily marked `partial` produces the packet warning (packet restored
byte-identically, sha256 unchanged); `workersRootState(<unlistable>)` returns
`unreadable`. The orient-side repro exits 3 with `partial` and `incomplete:`.

**Not claimed.** Nobody has run this against a root whose *permissions* are broken in
production; the evidence is a synthetic `chmod 000` tree. And the graph's exit 3 now
collides with nothing today, but a caller that treats "non-zero" as "drift" must read
the code: 1 is drift, 3 is incomplete, 4 is strict content movement.
