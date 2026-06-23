# Baseline source-run audit (Slice 17.6 · optional / deferred)

**Type:** AFK (optional — deferred; not required for the core ask)

## Parent

PRD: `prd/run-outcome-baseline-vs-verified.md` (DESIGN §4 — Slice 17). Audit enhancement.

## What to build

Record **which run** sourced the current golden baseline so the product can attribute it. Add a
nullable `sourceRunId` to the baselines table (additive, idempotent migration), set it whenever an
approve writes or replaces a golden (seed-approve, diff-approve, or a passed re-baseline from Slice
17.4), and null it if that source run is later deleted (the shared golden blob is still kept).
Surface "current baseline set by this run" on Run Detail and an "established / last updated by
{who} on {when}" summary on Test Detail.

This is the only schema-touching slice in Slice 17 and is intentionally deferred — re-baselining
already works without it; this only adds per-run attribution of the golden.

## Acceptance criteria

- [ ] `baselines.source_run_id` exists via an additive, idempotent migration, and is set on every approve that writes or replaces a golden.
- [ ] Deleting a run nulls any baseline `source_run_id` pointing at it; the shared golden blob is not purged.
- [ ] Run Detail and Test Detail surface which run + who/when established or last updated the current golden for a checkpoint.

## Blocked by

- Slice 17.4 — Re-baseline a passed actual (`issues/outcome-4-rebaseline-passed-actual.md`).
