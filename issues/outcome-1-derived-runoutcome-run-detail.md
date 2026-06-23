# Derived RunOutcome + Run Detail badge (Slice 17.1)

**Type:** AFK

## Parent

PRD: `prd/run-outcome-baseline-vs-verified.md` (DESIGN §4 / §8 — Slice 17). Covers Goals G1
(distinguish outcomes) and G5 (one shared derivation, no capture-loop regression).

## What to build

Introduce a **derived run outcome** (test-runner model) that refines the coarse stored run status:
a run that *set/updated a baseline* (**Baseline**) reads differently from one that *matched and held*
(**Passed**); a *first run with no baseline* is **Pending baseline** (awaiting approval, not a failure);
a *diff or crash* is **Failed**. Today every resolved run collapses onto green "passed".

Add a **pure** `deriveRunOutcome(checkpoints, { status, error })` to the shared contract package
(no db imports — it lives beside the other read-model verdict logic). It maps each checkpoint's
already-stored `reviewState` + `resolution`, plus the run's execution `error`, into a `RunOutcome`.
The run-detail read returns `outcome` on the run; the **single** status→tone/label/icon mapping
gains the new keys; the Run Detail header renders `outcome` instead of the raw status.

**No DB change.** The stored run-status column, the worker's status write, and the post-decision
`recomputeRunStatus` rollup are all untouched — `outcome` is a strict, derived refinement.

The type + precedence (the decision this slice encodes — **test-runner model**; from the PRD):

```ts
type RunOutcome =
  | "queued" | "running"
  | "passed"            // a baseline existed and the capture matched
  | "baseline"          // this run set or updated the golden baseline
  | "pending-baseline"  // first run — no baseline yet, awaiting approval (NOT a failure)
  | "failed";           // a baseline existed but the capture differs, or the replay crashed

// precedence, top → down:
// 1. queued/running                                          → same
// 2. execution error                                         → failed
// 3. any unaccepted diff (or legacy rejected)                → failed   (baseline existed & changed)
// 4. any unresolved first-capture seed (pending-baseline)    → pending-baseline
// 5. any baseline write (pending-baseline|diff|passed & approved) → baseline
// 6. else (all matched)                                      → passed
// (a diff outranks a pending seed: step 3 before 4)
```

## Acceptance criteria

- [ ] A pure `deriveRunOutcome` helper exists in the shared contract package (no db dependency), implementing the precedence above.
- [ ] It is unit-tested against the PRD's full rollup matrix (rows 1–14), including: a first run → `pending-baseline`; an unaccepted diff → `failed`; a diff outranks a pending seed → `failed`; a baseline write with nothing red → `baseline`; crash → `failed`.
- [ ] The run-detail API response includes `outcome` on the run; the stored status column, the worker write, and `recomputeRunStatus` are unchanged.
- [ ] The shared status vocabulary renders `passed` (success ✓), `baseline` (info, Layers), `pending-baseline` (**warning/amber** — distinct from baseline blue), `failed` (danger ✗).
- [ ] The Run Detail header renders the run's `outcome`: a first run reads **Pending baseline**; after approval a run reads **Baseline**; a matched re-run reads **Passed**; a diff or crash reads **Failed**.
- [ ] No change to the record→replay→diff loop; the existing run/baseline e2e suite stays green.

## Blocked by

- None - can start immediately.
