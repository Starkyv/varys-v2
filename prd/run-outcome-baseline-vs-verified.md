# PRD — Varys v2 Slice 17: Run outcome — test-runner status model

> Extends **DESIGN.md §4 (Baseline lifecycle)** and **§8 (Diff viewer)**. Varys previously collapsed
> several very different runs onto two overloaded stored statuses: a run that *established/updated golden
> baselines* and a run that *verified the app against existing baselines* both stored `status="passed"`
> and rendered an identical green pill; and a screenshot **diff** sat in an ambiguous "needs review"
> limbo rather than reading as a plain pass/fail the way engineers expect from a test runner. This slice
> introduces a derived **`RunOutcome`** that follows the **test-runner model** and surfaces it everywhere a
> run is shown, and lets a reviewer **set any actual as the new baseline** (including a passing one).
> **Depends on:** Slices 1–3, 7 (review loop, baselines, dashboard). Touches contract + API read paths +
> the web status vocabulary; **no change to the record→replay→diff capture loop** and **no mandatory DB
> migration** (the distinction is derivable from data already stored).
>
> **Scope is bounded by four locked decisions (design interview, this slice):**
> 1. **Test-runner model.** Once a baseline exists, a capture that **differs** (or a replay crash) is
>    simply **`failed`** (red) — there is no "needs review" wait state and **no Reject**. A real bug is left
>    red and fixed in the app; the only action is to set the new actual as the baseline.
> 2. **A first run has no baseline to fail against**, so it is **`pending-baseline`** (amber — *awaiting your
>    approval*), **not** a failure. Approving the capture seeds the golden and the run reads **`baseline`**.
> 3. **"Set as baseline" is a per-checkpoint action** available on a failed/pending checkpoint *and* on a
>    passing one (re-anchor). `approveAll` is unchanged and **never** touches a passing checkpoint implicitly.
> 4. **Pass-rate excludes `baseline` and `pending-baseline` runs** — it measures *verification only*
>    (numerator = `passed`); a baseline-establishment or first run is neither a pass nor a fail of a comparison.
>
> **Outcome is derived, not stored.** The coarse `runs.status` column (`queued|running|passed|needs_review|
> failed`) is **unchanged** — kept for the worker, filters, and back-compat. A pure `deriveRunOutcome()`
> helper in `@varys/review-contract` maps a run's checkpoints (`reviewState` + `resolution`, both already
> stored) + `runs.error` into the finer **`RunOutcome`**. One helper, every consumer agrees.
>
> **Testing posture (per established direction):** **one compact chromium-free API E2E** that pins (a) the
> approve-from-`passed` path replaces a baseline + audits it + deletes the old blob, (b) a first run reads
> `pending-baseline` and a re-baselined run reads `baseline`, and (c) `deriveRunOutcome` returns the right
> outcome across the rollup matrix below. **Zero UI/component tests** — the badges, the "Set as baseline"
> affordance, and the dashboard are the **manual click-through gate**. Prior art: `apps/api/test/runs.e2e.spec.ts`.

---

## Problem Statement

A Varys run resolved to one of a handful of overloaded stored statuses, and the display couldn't tell
apart situations that mean very different things:

- **Baseline-creation vs verification both read "passed".** A first replay seeds `pending-baseline`
  checkpoints; the reviewer approves them — which *writes the golden baselines* — and the run flips to
  stored `passed`, identical to a later run whose pixels actually *matched* an existing baseline. One
  "accepted the screenshots as truth"; the other "verified and held." Indistinguishable in the Runs table,
  the run header, the dashboard matrix, suite children, and a test's history.
- **A diff sat in "needs review" limbo.** Engineers think in pass/fail: if a baseline existed and the
  capture differs, the test **failed**. The old model parked it as an amber "needs review" awaiting an
  approve/reject decision, which read as neither pass nor fail.
- **A passing actual couldn't be promoted.** Approving was rejected for a `passed` checkpoint, so there was
  no way to re-anchor the golden to the current look (accepted within-threshold drift) without forcing an
  artificial diff.

## Goals

- **G1.** Every surface that shows a run distinguishes **Pending baseline** (first run, awaiting approval),
  **Baseline** (this run set/updated the reference), **Passed** (matched), **Failed** (diff or crash),
  Queued/Running.
- **G2.** A reviewer can **set any actual as the new baseline** from the run viewer — a failed/pending
  checkpoint, or a passing one (re-anchor) — with the same audit + irreversible confirm (DESIGN §4, §8).
- **G3.** A **test's run history** lets you tell a baseline-creation run from a real run at a glance.
- **G4.** Pass-rate reflects *verification only* (`baseline` + `pending-baseline` excluded).
- **G5.** No regression to the capture/replay/diff loop; no mandatory migration; one derivation helper
  shared by all consumers.

## Non-goals

- Re-introducing baseline **history/rollback** (DESIGN §4 accepted-risk #1 stands: replace is destructive,
  no undo).
- Changing the **stored** `runs.status` enum or the worker's status write.
- A **Reject** / explicit-regression flow — a real bug is left red and fixed in the app (deliberately
  dropped from the earlier review-queue design).
- A bulk "re-baseline all" run-level action (per-checkpoint only; can be a fast-follow).
- Per-environment/-viewport changes — the existing `(testId, checkpointName, environment, viewportKey)` key
  is untouched.

---

## The model

### `RunOutcome` (derived, display + metrics)

```ts
// @varys/review-contract — pure, no db
export type RunOutcome =
  | "queued" | "running"
  | "passed"            // a baseline existed and the capture matched — a real verification pass
  | "baseline"          // this run set or updated the golden baseline (first approval or "set as baseline")
  | "pending-baseline"  // first run — no baseline yet, awaiting approval (NOT a failure)
  | "failed";           // a baseline existed but the capture differs, or the replay crashed
```

### Per-checkpoint classification (the atoms) — `(reviewState, resolution)`

Fully determined by stored columns:

| reviewState | resolution | Classification | Baseline write? | Reads as |
|---|---|---|---|---|
| pending-baseline | null | First capture, awaiting approval | — | 🟠 pending |
| pending-baseline | approved | Baseline established | ✅ insert golden | 🔵 baseline |
| diff | null | Differs from baseline — failed | — | 🔴 failed |
| diff | approved | Change accepted as new baseline | ✅ replace golden | 🔵 baseline |
| passed | null | Matched the baseline | — | 🟢 passed |
| passed | approved | Re-baselined a passing capture | ✅ replace golden | 🔵 baseline |
| diff/pending | rejected | *legacy only — no Reject in this model* | — | 🔴 failed |
| passed | rejected | *disallowed → 400* | — | — |

### Run rollup — `deriveRunOutcome(checkpoints, { status, error })`, precedence top→down

1. `status` is `queued`/`running` → same.
2. `error != null` → **`failed`** (a crash; reviewing partial checkpoints never flips it).
3. any unaccepted **`diff`** (or legacy **`rejected`**) → **`failed`** (a baseline existed and changed).
4. any unresolved first-capture **`pending-baseline`** seed → **`pending-baseline`** (awaiting approval).
5. any **baseline write** (`pending-baseline|diff|passed` & `approved`) → **`baseline`**.
6. else (all matched) → **`passed`**.

A **diff outranks a pending seed** (step 3 before 4): a real failure against an established baseline is more
urgent than approving a brand-new checkpoint. This is a strict refinement — every outcome maps back to a
stored `status` in `{passed, needs_review, failed}`, so filters keyed on `status` keep working.

---

## Test-case matrix (run-level, "consider all cases")

| # | Checkpoints in the run | **Derived outcome** | Notes |
|---|---|---|---|
| 1 | all `passed`, none resolved | **passed** | the real green pass |
| 2 | all `pending-baseline`, unresolved | **pending-baseline** | first run — awaiting approval, not a failure |
| 3 | all `pending-baseline`, approved | **baseline** | seeds approved → goldens created |
| 4 | `diff`, unaccepted | **failed** | a baseline existed and changed |
| 5 | `diff` set as baseline | **baseline** | change accepted |
| 6 | `diff` rejected (legacy data) | **failed** | confirmed change stays red |
| 7 | `passed`, one re-baselined | **baseline** | re-anchor; rest matched |
| 8 | mix: `passed` + a seed approved | **baseline** | a baseline was written, nothing red |
| 9 | pending seed + unaccepted `diff` | **failed** | diff outranks pending (step 3 before 4) |
| 10 | one seed approved, another still unapproved | **pending-baseline** | still awaiting approval |
| 11 | `diff` rejected + a `diff` still unaccepted | **failed** | any red → failed |
| 12 | execution error, no checkpoints | **failed** | `error` set |
| 13 | partial checkpoints, then crash | **failed** | reviewing partials never flips it |
| 14 | re-run after baselining → all match | **passed** | the baseline run's successor is a real pass |

Edge / interaction cases:

- **Re-baseline a pixel-identical pass** (diffScore ≈ 0): allowed; near-no-op on bytes; still updates audit +
  resolution. UI shows an "already matches the baseline" hint before confirm.
- **Re-judge flips verdict** (MaskTuning live re-diff): `approve()` reads the *current* `reviewState`, so
  "Set as baseline" always acts on the live verdict.
- **Per-env independence**: baselining env A leaves env B's matrix cell untouched.
- **Suite rollup** (`suite-runs.service.ts`): bar counts stay coarse (stored status); each **child row**
  shows its fine outcome.

---

## Changes by layer

### Contract — `packages/review-contract/src/index.ts`
- `RunOutcome` (`queued|running|passed|baseline|pending-baseline|failed`) + pure
  `deriveRunOutcome(checkpoints, { status, error })`.
- `outcome: RunOutcome` on `RunView` and `RunSummary`; `MatrixCellStatus` =
  `passed|baseline|pending-baseline|failed|running|none`; `outcome` on `SuiteRunChild`.

### API — `apps/api/src/runs/runs.service.ts`
- **`approve()`**: accepts `reviewState === "passed"` → reuses the `diff` replace branch (a passing
  checkpoint always has a baseline). Same destructive-replace + audit. `approveAll` still selects only
  unresolved `pending-baseline|diff` → a passing checkpoint is never re-baselined implicitly.
- **`reject()`**: refuses a `passed` checkpoint (`400`). (The UI no longer offers Reject; the endpoint
  remains for legacy/audit and is a no-op in the happy path.)
- **Read paths** (`getById` → RunView; runs-list → RunSummary; dashboard matrix; suite children) call
  `deriveRunOutcome`. Stored `status` + `recomputeRunStatus` untouched.
- **Dashboard pass-rate**: denominator excludes `baseline` + `pending-baseline` outcomes; numerator =
  `passed`. *(Slice 17.5.)*

### DB — `packages/db/src/schema.ts`
- **None required.** *Optional audit (deferred):* `baselines.sourceRunId` for "baseline set by this run".

### Web
- **`apps/web/src/lib/status.tsx`** (single source of truth): outcomes render as `passed` (success ✓),
  `baseline` (info, `Layers`), `pending-baseline` (**warning/amber** — distinct from baseline blue), `failed`
  (danger ✗). Every run surface renders `run.outcome`, not raw `status`.
- **`RunDetail` `DecisionBar`**: **no Reject button**. A pending checkpoint → **"Approve baseline"**; a diff →
  **"Set as baseline"** (with "this run failed — set it if correct, else fix the code"); a passing one → an
  optional re-anchor "Set as baseline".
- **Runs table, `TestDetail` "Recent runs", Dashboard `StatusMatrix` + activity feed, SuiteRuns report**: all
  render `outcome`. Matrix legend: **Passed · Baseline · Pending · Failed**.

---

## Rollout slices (status)
1. ✅ Derived `RunOutcome` + Run Detail badge + `deriveRunOutcome` unit table.
2. ✅ Outcome on the runs list + a per-test "Recent runs" history.
3. ✅ Outcome in the dashboard matrix + suite-run children.
4. ✅ Re-baseline a passing actual (`approve()` accepts `passed`; "Set as baseline" UI; API E2E).
   *(Model then pivoted from the review-queue design to this test-runner model — diff → failed, Reject
   dropped, first run → pending-baseline.)*
5. ✅ Pass-rate excludes `baseline` + `pending-baseline` (numerator = `passed`).
6. ◻️ *(deferred)* `baselines.sourceRunId` audit + TestDetail "baseline set by" summary.

## Testing
- **`apps/api/test/runs.e2e.spec.ts`:** first run reads `pending-baseline`; approve → re-run reads `passed`;
  reject a passing checkpoint → 400; re-baseline a passing checkpoint → golden artifactKey equals the actual,
  audited, old blob deleted, run outcome `baseline`. Plus the `deriveRunOutcome` unit table (matrix rows 1–14).
- **Zero UI/component tests.** Manual click-through: the four pills, the "Set/Approve as baseline" confirm,
  pass-rate, and TestDetail history.
- Do **not** run the suite unless asked (established testing posture).

## Out of scope / deferred
- Baseline history & rollback (accepted-risk #1 stands).
- A Reject / explicit-regression flow, and a run-level "re-baseline all".
- Notifications when a baseline changes.
- Changing the stored `runs.status` taxonomy or worker status write.

## Accepted risks
- Setting an actual as baseline is **destructive** (replaces + deletes the old golden, no undo) — guarded by
  the irreversible confirm (DESIGN §4 / §8).
- A real bug left "failed" stays red on every subsequent run until the app is fixed — intended in a
  test-runner model, but a long-lived known bug keeps the dashboard red (no "acknowledged bug" state).
- `outcome` is derived on read (extra grouped query for lists); acceptable, mirrors the matrix aggregation.
