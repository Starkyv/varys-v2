# Pass-rate excludes baseline runs (Slice 17.5)

**Type:** AFK

## Parent

PRD: `prd/run-outcome-baseline-vs-verified.md` (DESIGN §10 — Slice 17). Covers Goal **G4**
(pass-rate measures verification only).

## What to build

Make the dashboard pass-rate KPI measure *verification* only. A baseline-establishment run and a
first run (pending baseline) are neither a pass nor a fail of a comparison, so they must not move the
rate. Recompute the KPI so the **denominator excludes** runs whose outcome is `baseline` or
`pending-baseline`, and the **numerator counts** `passed` runs. Apply the same definition to the
prior-window delta so the trend stays consistent, and update the documented definition of the field.

## Acceptance criteria

- [ ] The pass-rate denominator excludes runs whose derived outcome is `baseline` or `pending-baseline`; the numerator counts `passed` runs.
- [ ] The prior-window delta calculation uses the same (verification-only) definition.
- [ ] The documented definition of the pass-rate field is updated to "verifications only (baseline + pending-baseline runs excluded)".
- [ ] A window containing only baseline-creation / first runs yields an empty / 0 pass-rate, not 100%.

## Blocked by

- Slice 17.1 — Derived RunOutcome + Run Detail badge (`issues/outcome-1-derived-runoutcome-run-detail.md`).
