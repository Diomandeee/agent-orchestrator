# PACT decision packet — DRAFT, unsigned (2026-09-19)

Status: **discussion draft, not a contract.** Nothing here authorizes any
effect. WS4.1 requires a signed contract before code, and WS0.1/WS0.4 require
Mohamed's written decisions. This packet exists so those decisions arrive as
checkboxes, not essays. Each item ends with a recommendation and a `[ ]`.

The working sequence from tonight: the recall-grant pattern
(`uctm.recall-grant.v1`: schema, expiry ≤24h, window, budget, family, purpose,
stable machine-code denials) ports directly to effect proposals. The denial
ladder (401/403/422, zero stray receipts) and the identity-only receipt
vocabulary are proven against the live stack.

## D1. Authority ceiling per layer (WS0.1)

Proposed table (to be signed):

| Layer | May cause | May never cause |
| --- | --- | --- |
| Studio daemon | spawn sessions, run turns, read projections, write identity-only receipts | training, deployment, merge, external send |
| CEF | admit bounded model-safe context under a live grant; deny everything else | any effect beyond the admitted payload |
| Spine service | publish read-only projections of durable local state | proposals, adjudication, effects |
| PACT/pPACT | validate a proposed effect against a frozen contract; emit valid/invalid + receipt | execute, approve-by-model-claim, open gates |
| Canonical/human | authorize a specific effect (typed confirmation, identity, idempotency) | standing pre-authorization |

- [ ] Recommendation: sign as-is. Decide: ______

## D2. May Studio ever hold canonical authority? (decision 3)

- [ ] Recommendation: **no, permanently.** Studio holds caches and copies;
  every projection carries `authorityCeiling: interface_read_only` already.
  Rationale: the whole receipts design assumes a reader that cannot promote
  itself.

## D3. PACT naming collision (WS0.4)

- [ ] Recommendation: bind to `Developer/pact` semantics and rename the UCTM
  governance layer reference to `pact-governance` in docs, keeping PACT for
  the existing system. Alternative: rename the existing system (rejected —
  larger blast radius).

## D4. pPACT contract freeze (WS4.1) — draft inputs/outputs

Proposed frozen I/O (to be signed before any WS4.2 code):

- Inputs: `proposal` (`uctm.effect-proposal.v1`: effect, scope, budget,
  expiry, authorizer set, receipt refs), `authority_budget`,
  `holdout_state`, `prior_receipts`.
- Outputs: `valid | invalid`, machine reason code, receipt. Invalid inputs
  leave no effect and still write the denial receipt.
- Rule: no gate opens on a model claim; model output is evidence, never
  authorization.

- [ ] Recommendation: freeze as-is. Decide: ______

## D5. M2 vs M3 interleave (decision 5)

- [ ] Recommendation: interleave — M2 hardening is read-only work and the
  plan already permits it in parallel; M3 build proceeds, M2 gates each
  promotion.

## D6. Claim promotion rule (decision 6)

- [ ] Recommendation: a claim moves partial → connected only on a dated
  receipt named in ORIENTATION.v0.json, per the verification matrix §4.
  No receipt, no promotion, no exceptions.

## What happens when this is signed

WS4.2 (deterministic validator) becomes buildable; WS4.3–4.5 follow in
order. Until then L4 stays Not started and every proposal stays advisory —
which is the current true state.
