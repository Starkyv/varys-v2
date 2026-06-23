# Outcome in the dashboard matrix + suite runs (Slice 17.3)

**Type:** AFK

## Parent

PRD: `prd/run-outcome-baseline-vs-verified.md` (DESIGN §4 / §10 — Slice 17). Covers Goal G1
(distinguish outcomes on the aggregate surfaces).

## What to build

Surface the derived `outcome` on the two aggregate views: the dashboard **test × env status
matrix** and the **suite-run report's children**. The matrix already special-cases a first-capture
"pending-baseline" cell with its own ad-hoc derivation — replace that with the shared
`deriveRunOutcome` so there is one definition, and extend the cell vocabulary to also distinguish a
**baselined** latest run from a **passed** one (and a first-run **pending-baseline**). Add `outcome`
to suite-run child rows and render the pill there too.

Suite-run aggregate **counts/bars stay coarse** (stored status) — only the per-child rows show the
fine outcome.

## Acceptance criteria

- [ ] The dashboard matrix cell distinguishes a baselined latest-run from a passed one (and a first-run pending-baseline), and its previous ad-hoc pending-baseline derivation is reconciled with / replaced by the shared `deriveRunOutcome` helper.
- [ ] Suite-run children carry and render `outcome`; the suite bar and aggregate counts are unchanged (stay on coarse stored status).
- [ ] There is no second source of truth: matrix, suite report, runs list, and run detail all derive outcome from the same helper.

## Blocked by

- Slice 17.1 — Derived RunOutcome + Run Detail badge (`issues/outcome-1-derived-runoutcome-run-detail.md`).
