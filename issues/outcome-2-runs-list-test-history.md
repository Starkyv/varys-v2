# Outcome on the runs list + a test's run history (Slice 17.2)

**Type:** AFK

## Parent

PRD: `prd/run-outcome-baseline-vs-verified.md` (DESIGN §4 — Slice 17). Covers Goals G1 and **G3**
(the literal ask: for a given test, tell a baseline-creation run from a real run at a glance).

## What to build

Surface the derived `outcome` everywhere runs appear as **rows**: the Runs history table and a
test's run history on the Test Detail page. Add `outcome` to the run-summary read-model; the
runs-list query derives it per run from that run's checkpoints using the **same**
`deriveRunOutcome` helper (no second implementation), and the rows render the outcome pill instead
of the raw status.

This is the slice that makes a test's history legible: "this run *defined* the baselines"
(**Baseline**) vs "this run *checked* against them and held" (**Passed**).

## Acceptance criteria

- [ ] The run-summary read-model carries `outcome`; the runs-list endpoint derives it per run via the shared `deriveRunOutcome` helper (no divergent logic).
- [ ] The Runs history table renders the outcome pill (Passed / Baseline / Pending baseline / Failed / Queued / Running) in place of the raw status.
- [ ] Test Detail's run history renders the outcome pill, so within one test's history baseline-creation runs are visibly distinct from verification runs.
- [ ] Any list filtering/sorting that keys on the coarse stored run status continues to work (outcome is a strict refinement, not a replacement).

## Blocked by

- Slice 17.1 — Derived RunOutcome + Run Detail badge (`issues/outcome-1-derived-runoutcome-run-detail.md`).
