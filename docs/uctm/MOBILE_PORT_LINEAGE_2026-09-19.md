# Mobile port lineage: the iOS session board and the AO phone app are one rule set

Status: verified 2026-09-19; differential corrected and fixed, see the correction below. `packages/uctm-mobile-ios/Sources/SessionBoard.swift`
is a deliberate port of three AO phone-app view-model modules, and this document
names both sides so the evidence kernel can point at them. Placed because the whole
package was invisible to `--impact` before it: the code node set is exactly the
repository paths the indexed documents name, and no document named any of them.

Finding: scratch-9 (owns `packages/uctm-mobile-ios/**`), who raised the gap and
supplied the port mapping. Placed by scratch-11, which owns `docs/uctm` and the
kernel. The mapping is scratch-9's; the differential below was re-derived from the
sources by scratch-11 and is stated with the command that produced it.

## The port

| iOS (port) | AO phone app (origin) | what it carries |
|---|---|---|
| `packages/uctm-mobile-ios/Sources/SessionBoard.swift` | `packages/mobile/lib/sessionStatus.ts` | terminal statuses, the attention bucket fallback |
| | `packages/mobile/lib/agentsView.ts` | board zones, the zone fold |
| | `packages/mobile/lib/orchestratorView.ts` | orchestrator state, zone counts |

The Swift file says so in its own header: "Ported from the AO app's
`lib/sessionStatus.ts`, `lib/agentsView.ts` and `lib/orchestratorView.ts` so one
session reads the same way in both apps". Direction matters: the phone app is the
origin, the iOS app is the port.

## What verifiably agrees

- Terminal statuses: the same six strings in both (`killed`, `terminated`, `done`,
  `cleanup`, `errored`, `merged`); `isTerminalStatus` guards the empty string in both.
- Board zones: `action`, `merge`, `working`, `pending` in both, in the same display
  order, with `respond` and `review` folding into `action` in both.
- The fold is behaviorally the same: merge -> merge, pending -> pending,
  respond/review -> action, working/done -> working.

## What did not agree, and the fix each one received

**Correction, 2026-09-19 12:10Z: this section described a real state that no longer
exists.** All three differences below were true of the sources when this document was
written (10:19:52Z), and scratch-9 -- who owns the slice -- verified each one and fixed
all three at 10:24:52Z (`packages/uctm-mobile-ios/Sources/SessionBoard.swift`, mtime
10:24:52Z; port tests 26 -> 31, 32 with the UI journey). They are kept below rather
than deleted, because a claim that has moved is easier to trust when the superseded
reading is still legible. What is true now:

| # | was | is now |
|---|---|---|
| 1 | the Swift `attentionOf` ignored the server's bucket and always recomputed | it returns `AttentionLevel(rawValue:)` when the server sent one and recomputes only when absent or unrecognised (`SessionBoard.swift:88-89`) |
| 2 | the Swift enum had six members and no `action` | seven, including `action`, folded into the action board zone and counted under "need you", while `pillOrder` stays the phone's six (`:17-24`) |
| 3 | the Swift title chain walked two rungs | it walks all five before the id (`:101`, `:111`) |

**The fixes are pinned by fixtures because the paths cannot be reached any other way.**
`rg attentionLevel backend/` is **zero hits**: this daemon's wire type carries no such
field, so neither app's deference branch can be exercised by live data today. The three
fixes are therefore asserted against constructed sessions, not observed in a running
pair. That is the strongest test available here, and it is worth stating which one it is
— a green fixture proves the branches behave as written, not that a server ever sends
what they branch on.

**One deliberate divergence, recorded rather than smoothed away.** The fix does not make
the two readers identical, and should not. `packages/mobile/lib/sessionStatus.ts:17`
returns `s.attentionLevel as AttentionLevel` — a blind cast over a field the wire type
itself declares as `AttentionLevel | string | null` (`api.ts:39`), so whatever string
arrives is propagated as a level. The Swift side uses `AttentionLevel(rawValue:)`, a
failable initialiser: an unrecognised level yields nil and the port recomputes instead.
Treating garbage as working is not more faithful, just quieter — the phone would render
a bucket it has no label for, while the port falls back to a bucket it does have one for.
The asymmetry lives in the types and falls on the safe side; it is recorded because a
future reader comparing the two files will find it and should not read it as drift.

**Severity, corrected twice -- and this half was my error, not a stale reading.** The
line below that said "live today" was wrong when written. scratch-9 checked at the
field level: `rg attentionLevel backend/` is **zero hits**, because the daemon's wire
type carries no such field, so the phone app's deference branch is dead code too. The
divergence was therefore latent on *both* sides rather than live on one. The property
that mattered was still real -- the port agreed with the phone only by coincidence of
the rules, and would have disagreed the moment a server sent the field -- and that is
what the fixes made structural. The superseded reading follows.

1. *(superseded)* **Different trust model for the server's own bucket.**
   `attentionOf` in `packages/mobile/lib/sessionStatus.ts` returns
   `s.attentionLevel` first and only recomputes if the server sent none. The Swift
   `attentionOf` ignores the field entirely and recomputes from status and PR every
   time. The two apps therefore agree only while the server's rules and the iOS
   recomputation happen to produce the same bucket — which is a coincidence of the
   rules, not a property the port enforces. A server-side rule change reaches the
   phone immediately and the iOS app never.

2. *(superseded)* **The two type shapes are not mirrors.**
   `packages/mobile/lib/theme.ts` declares `AttentionLevel` with **seven** members,
   including `action`; the Swift enum has **six** and no `action` case. This is
   consistent with (1) rather than independent of it: `action` is only reachable in
   the phone app through the server field that iOS ignores. It is not a cosmetic
   mismatch — the union can represent a value the enum cannot, and the reachable
   path is the server.

3. *(superseded)* **The title fallback chains were different lengths.**
   `sessionTitle` in `sessionStatus.ts` walks five candidates
   (`displayName`, `issueId`, `issueTitle`, `userPrompt`, `summary`) and then `id`;
   the Swift version walks `displayName`, `issueId`, then `id`. They agree today
   because the middle three are hardcoded null by `mapSession`, and the TS comment
   says so. **Named trigger:** the day `mapSession` populates `issueTitle`,
   `userPrompt` or `summary`, the phone app retitles sessions and the iOS app falls
   through to `issueId` — the same session, two names. Both trim before comparing,
   so the whitespace rule ("a displayName of `" "` is not a name") does agree.

## What this buys

Either end now reaches the other:

    node scripts/uctm-graph.mjs --impact packages/mobile/lib/sessionStatus.ts
    node scripts/uctm-graph.mjs --impact packages/uctm-mobile-ios/Sources/SessionBoard.swift

Each names this document, and this document names the other side, so an edit to the
AO attention rules surfaces the iOS port that has to be re-read.

## Non-claims

- The kernel records that one document names these four paths. It does not compare
  the implementations and cannot: nothing here proves the two still agree, only that
  a reader who edits one has a pointer to the other.
- There is no test asserting cross-language equivalence, and none is proposed here.
- The three differences above were read from the sources, not from running either
  app. All three are now fixed in the sources and the port's owner reports its test
  target green at 31 (32 with the UI journey); no iOS build and no phone build was run
  here, so "the sources agree, and the port's fixtures say so" is the claim — not "they
  agree on screen".
- Naming a path is not knowing it. This document also mentions
  `packages/uctm-mobile-ios/Sources/UCTMMobileApp.swift`,
  `packages/uctm-mobile-ios/Sources/StudioAPI.swift`,
  `packages/uctm-mobile-ios/Sources/PairingScanner.swift` and
  `packages/mobile/lib/theme.ts`, so those become reachable nodes — but only because
  these sentences are the thing that names them. Nothing here records what they do,
  and a node created by a passing mention carries no more authority than the mention.
  The package's test targets and every `packages/mobile/lib/*` module beyond the
  three ported above are still not nodes. The paragraphs added above do name two of
  them, and that did not make them visible: `--impact
  TestsUI/PairingJourneyTests.swift` and `--impact packages/mobile/lib/api.ts` each
  report no matching node, and the graph's unresolved count is unchanged at 52 — a
  mention becomes a node only when its token resolves inside this checkout, and `api.ts`
  is recorded as an *ambiguous relative name* rather than silently dropped.
