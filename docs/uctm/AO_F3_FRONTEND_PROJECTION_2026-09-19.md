# AO-F3 — the project-scoped UCTM view, and what it refuses to say

Status: **implemented and verified against a live spine service on a throwaway
daemon. The deployed desktop runtime still serves neither the route's data nor
the transport, so the view is reachable but reads a disabled integration in the
real app.**

This closes AO-F3 of `INTERFACE_ABSORPTION_PLAN.md` and the display half of L3 in
`CONNECTION_PLAN_2026-09-18.md`. `AO_F3_1_SPINE_SERVICE_2026-09-19.md` recorded
the writer and the first live read; this receipt records the surface a human
actually looks at, the invariants it enforces, and one app-wide defect it found.

## What was built

| Layer | File | Role |
| --- | --- | --- |
| Projection logic | `frontend/src/renderer/lib/uctm-projection.ts` | Closed kind list, tone mapping, reason labels, provenance rows, payload text. Pure; no React. |
| Read hook | `frontend/src/renderer/hooks/useUctmProjection.ts` | One GET per kind through the real `api-client`; `retry: false`; `staleTime: 5s`. |
| Card | `frontend/src/renderer/components/uctm/UctmProjectionCard.tsx` | One kind: state first, provenance second, payload behind a disclosure. |
| Panel | `frontend/src/renderer/components/uctm/UctmProjectionPanel.tsx` | Loading and failure, neither of which is allowed to look like a UCTM state. |
| View | `frontend/src/renderer/components/uctm/UctmView.tsx` | All eight kinds on one read-only page, under a banner that says what it is not. |
| Route | `frontend/src/renderer/routes/_shell.projects.$projectId_.uctm.tsx` | `/projects/$projectId/uctm`. |
| Navigation | `frontend/src/renderer/lib/command-palette.ts`, `components/CommandPalette.tsx` | Command-palette entry "Project UCTM" in the current-project group. |
| i18n | `frontend/src/renderer/i18n/*.json` | 41 new `uctm.*` keys and `command.projectUctm`, in all eight locales. |

## Invariants this surface enforces

1. **State before payload.** Every card renders freshness, the machine reason
   code, and the seven metadata fields before the payload is reachable. A
   payload can never be the first thing read.
2. **Absence is stated, not drawn.** A kind with no facts renders "no payload is
   shown because AO holds no projection for this kind" rather than an empty box.
   An empty box reads as "the answer is nothing", which is a different claim.
3. **A failed read is not a UCTM state.** When the daemon does not answer, the
   panel renders an error against the view. It never invents a freshness for a
   fact nobody produced.
4. **An unrecognized reason code is printed, not translated.** The card shows
   `Unrecognized state code: <code>` instead of guessing at copy for a state
   this build does not know.
5. **Read-only by construction.** Every panel is a GET. The page holds no
   control that proposes, approves, trains, merges, deploys, spawns, or sends.

## Evidence

| Check | Command | Result |
| --- | --- | --- |
| Projection + card + read-only/no-telemetry tests | `npx vitest run --config vite.renderer.config.ts src/renderer/components/uctm src/renderer/lib/uctm-projection.test.ts` | 20 passed |
| Command palette tests | `npx vitest run --config vite.renderer.config.ts src/renderer/lib/command-palette.test.ts` | passes, including the new `current-project-uctm` case |
| Locale parity | `npx vitest run --config vite.renderer.config.ts src/renderer/i18n/instance.test.ts` | 12 passed |
| Types | `npm run typecheck` | clean |
| Live render, real browser | Playwright against `dev:web` on :5174 and a second daemon on :13999 in `read_only` behind the spine service on :18010 | 8 cards; `status`/`receipts` `fresh`, the other six `unknown`/`no_facts`; 0 page errors |
| Live navigation | Command palette → "Project UCTM" | URL becomes `#/projects/ao-demo/uctm`, 8 cards render, 0 page errors |
| Repository e2e spec | `e2e/uctm-view.spec.ts` | 1 passed against the live daemon, and passes with no daemon at all |

### Read-only and no-telemetry verification (AO-F3 step 5)

`uctm-readonly.test.tsx` drives the **real** `api-client` with a stubbed `fetch`
so the assertions describe what the app actually builds:

- exactly eight requests, one per kind;
- every request is a `GET`;
- every request stays on the daemon's own origin;
- every request carries `projectId`;
- **no telemetry event is emitted when the reads succeed**;
- when the reads fail, the only event is `ao.renderer.api_error`, and its
  payload never contains the project id.

A live capture of the same page agrees: 302 requests, 8 of them
`/api/v1/uctm/*?projectId=scratch`, **zero off-origin requests and zero non-GET
requests**. Failed reads travel the same seam every other API call uses; no
UCTM payload, projection content, or project identifier is captured.

## Defect found while verifying, and not fixed here

`text-accent` is unusable as a text colour in this theme, app-wide.

The compiled utility is `.text-accent { color: var(--accent) }`
(`src/renderer/styles.css?direct`, served by the renderer build), and `--accent`
is the shadcn *surface* token — `oklch(0.967 0.001 286.375)` in the light theme,
`oklch(0.274 0.006 286.033)` in the dark one. Measured in a real browser on this
card, the summary element painted at `rgb(244,244,245)` on a `oklch(0.985)` card:
about **1.05:1**, effectively invisible. The Tailwind theme key
`--color-accent` is correctly mapped to `--primary` (`tokens.css:106`, `:713`),
but the utility inlines the raw `--accent`, so the mapping never reaches it.

Fourteen call sites across `TerminalPane`, `ChatTimelineItems`, `TurnPlan`,
`BrowserPanel`, `NotificationCenter`, `ChatMarkdown`, and this card use
`text-accent`. This receipt fixes **only** the UCTM card, which now uses
`text-muted-foreground` (measured 4.8:1). The other thirteen are outside this
task's write scope, are in a shared checkout other sessions are editing, and a
global change to `--accent` would also repaint every `bg-accent` surface, so the
root fix is reported rather than improvised.

**CORRECTED 2026-09-19, after scratch-5 counted independently and got a different
list.** The paragraph above is kept for provenance; three of its claims are wrong
and one is incomplete. Corrected, and re-verified here by compiling the repo's own
`styles.css` with `@tailwindcss/node` 4.3 (emitted: `.text-accent { color:
var(--accent) }`, `.text-accent-foreground { color: var(--primary-foreground) }`)
and by recomputing the contrast from the token values through oklab → linear sRGB →
WCAG:

- **The count was 16 production usages in 10 files, not 13.** Five were missing
  from my list: `lib/workspace-file-status.ts` (a status→class map, so the defect
  is transitive through every surface that renders a file status),
  `SessionInspector.tsx`, `IntakeFields.tsx`, `CenterPane.tsx`, and
  `packages/product-ui/src/SessionsBoardView.tsx` — the last one missed by *both*
  scans until the `@source "../../../packages/product-ui/src"` directive at
  `styles.css:5` was checked. It pairs `bg-accent/12` with `text-accent`: 1.048:1
  light, 1.092:1 dark.
- **`NotificationCenter.tsx` is not a call site.** Its only match is
  `text-accent-foreground` over `bg-accent-strong` — the correct token. Counting
  it was my error.
- **This card holds zero real usages.** The two matches in
  `components/uctm/UctmProjectionCard.tsx` are the comment that documents the
  defect, which is what made the first count read one file too wide.
- **The defect is worse than reported: the dark theme is broken too.** The claim
  above measured only the light card. Dark resolves `--accent` to
  `oklch(0.274 0.006 286.033)` on `--card` `oklch(0.24 0.008 285.885)` =
  **1.106:1**, and `styles.css:13` states that dark is the primary theme while
  light is the override — so a light-only repair would leave the default theme
  broken. Independent recomputation reproduced both figures (1.054:1 light,
  1.106:1 dark) from the token values.
- **Reading the source would have concluded the opposite**, which is why the
  compile is the evidence: `--color-accent: var(--primary)` appears at
  `tokens.css:106` and `:713`, later in source order than the `@theme inline`
  block, but the inline directive bypasses the theme key and emits
  `var(--accent)` directly.

## Deliberate omissions

- **No deployment change.** The deployed daemon (pid 77457) was not rebuilt,
  restarted, or reconfigured, and `UCTM_MODE` is still unset where Studio
  launches. Finding C11 of `CONTEXT_PIPELINE_GATE_2026-09-18.md` stays open on
  purpose.
- **No live-data claim in the app.** In the real app the view reads the disabled
  integration and says so. The verified render used a throwaway daemon.
- **No proposal, adjudication, training, or effect surface.** v1 and v2 routes
  do not exist.
- **No per-project mapping.** One daemon answers every project id; the view
  passes `projectId` through and renders whatever the daemon reports.

## Non-claims

- These cards are AO's cached copies of what a UCTM service published. They are
  never UCTM truth, and the page says so above the fold.
- `harness_router`, `learned_harness`, `graph_kernel`, `rag_plus_plus`, and
  `historical_evidence_recovery` remain not connected to chat.
- `evidence_context_connected` and `uctm_spine_connected` remain false.
- A rendered card is not a governance claim. Nothing here is adjudicated,
  trained, merged, deployed, or qualified.

## A dead entry in my own specgen map, found by returning a favour (2026-09-19)

scratch-5 found that a `schemaNames` entry in their slice,
`SessionLineageEdgeSource`, could never fire: `LineageEdgeSource` is a named string
type the generator inlines into each property, so it never becomes a component and
the fixup is decoration. They then aimed the same test at the two entries this
session added — which is the useful part. Finding a dead entry in your own map is a
coin flip; a peer who has just proved the pattern elsewhere knows exactly where to
look.

Per entry, by removing it and regenerating (the only test that settles it):

| Entry | Spec after removal | Verdict |
| --- | --- | --- |
| `ControllersUCTMProjectionResponse` | every `$ref` moves to `ControllersUCTMProjectionResponse` | **live** |
| `ControllersUCTMProjectionQuery` | byte-identical; `UCTMProjectionQuery` appears **0** times in the spec | **dead — removed** |

`UCTMProjectionQuery` is only ever the query-parameter shape, so the generator
renders it inline as `schema: {description, type: string}` and no component is ever
created. The entry is removed and the reason is recorded in `build.go` where the
entry used to sit, rather than silently dropped, because an entry that can never
match is indistinguishable from one doing its job.

Measured, not argued: with the entry gone `openapi.yaml` is still
`e040107a85eb1d3e2ce40a044c6eba4d2fa3285335ad07bec711c027f3b2b8cd`, and
`TestBuild_MatchesEmbedded`, `TestRouteSpecParity` and
`TestDefaultLoadsEmbeddedSpec` all pass; `go vet ./internal/httpd/...` and `gofmt`
are clean; the rest of `./internal/httpd/...` is green.

**Standing rule, learned from two different maps in one hour:** a default→clean name
map is only trustworthy once you have proved at least one entry *per map* fires.
Removing an entry and regenerating costs seconds, and reading the map cannot tell
decoration from function.

### The unguarded hop, decided (2026-09-19)

scratch-5 asked which semantics the missing spec-vs-`schema.ts` guard should have.
There are two hops and only one of them is guarded:

| Hop | Guard |
| --- | --- |
| Go DTOs → `openapi.yaml` | `TestBuild_MatchesEmbedded` (embedded == file) and `TestRouteSpecParity` |
| `openapi.yaml` → `frontend/src/api/schema.ts` | **nothing** |

**Decision: staleness-only.** Regenerate to a temporary path and compare bytes. The
`cloud:check` shape (`generate && git diff --exit-code`) is wrong here because it
conflates *stale* with *uncommitted*, and this branch carries legitimately
uncommitted generated files — a check that is red for a reason unrelated to the
invariant is a check that gets ignored. In `frontend/package.json`, beside the
writer it guards:

```json
"api:check": "openapi-typescript ../backend/internal/httpd/apispec/openapi.yaml -o /tmp/ao-schema.check.ts && diff -q /tmp/ao-schema.check.ts src/api/schema.ts"
```

with the root delegating (`npm --prefix frontend run api:check`) so there is one
implementation rather than two.

**Precondition, and it is not optional:** this is only *a check* if exactly one
`openapi-typescript` can produce that file, or the same tree yields two verdicts
depending on which entry point ran. That is invariant 10 in
`INTEGRATION_ENDPOINTS.v0.json`, added alongside this decision.

**Met in the working tree, and this paragraph is the correction.** This section
originally stated the precondition as outstanding, on the state it was written
against: root pinned `7.4.4`, `frontend/` pinned `^7.13.0`, and CI installed the
root tree only. All three are true of the **committed** revision and none is true of
the working tree now. The duplicate pin is **removed** rather than aligned — the root
no longer declares `openapi-typescript` at all, `api:ts` and `api:check` both
delegate to `frontend/`, and the workflow installs `node_modules` where the one
generator actually lives:

    - run: npm ci --prefix frontend        # go.yml, so the single generator is real
    - run: npm run api:check

Verified rather than read, 2026-09-19T10:43Z: `npm run api:check` exits **0** and
its output names `openapi-typescript 7.13.0`, the version the frontend lock
resolves. `READINESS_CONTRACT.json` carries the discriminating measurement — the
same command exits **1** against a copy with one trailing newline added — so the
guard is not a check that always passes.

**Two consequences a reader needs.** First, aligning the root pin to `7.13.0`, which
is the other way to satisfy the precondition, would *re-create* the second generator
version this invariant forbids; the two entry points would agree until one of them
was updated alone. The removal is the stronger form and should not be undone by a
"harmless" re-pin. Second, CI measures the **committed** revision, so until this
working tree is committed the pipeline still runs the old shape; the workflow's own
path triggers already include `package.json` and `frontend/package.json`, so the
change is covered once it lands.

**A hazard worth naming, raised by scratch-5:** `openapi.yaml` and
`specgen/build.go` are both working-tree files, so committing one without the other
breaks `TestBuild_MatchesEmbedded` for whoever commits second — and the failure
reads as "stale spec" rather than "half a pair". They are committed together, or
not at all. Invariant 11.

Implemented by scratch-5 in `package.json` (their offer); this session recorded the
semantics and the contract lines rather than both of us editing one file.

## Next gate

1. Human decision: rebuild and redeploy the Studio daemon, then decide whether
   `UCTM_MODE=read_only` is exported for the real desktop launch. Until then the
   view is reachable but reads `mode_off`.
2. Decide the `text-accent` fix at the theme level, with the other sixteen call
   sites in scope and a light/dark contrast check per site.
3. Then the projection `change_log` CDC increment, whose only consumer (a live
   publisher) now exists.
