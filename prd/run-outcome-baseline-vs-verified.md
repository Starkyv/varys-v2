# PRD — Varys v2 Slice 17: Run outcome — "Baseline" vs "Verified" (+ re-baseline a passed actual)

> Extends **DESIGN.md §4 (Baseline lifecycle)** and **§8 (Diff viewer)**. Today a run that merely
> **established/updated golden baselines** and a run that **verified the app against existing baselines**
> both end up stored as `status = "passed"` and render with the identical green "Passed" pill. They mean
> opposite things. This slice makes that difference **visible everywhere a run is shown**, and lets a
> reviewer **promote a passed actual to a new baseline** (today impossible). **Depends on:** Slices 1–3, 7
> (review loop, baselines, dashboard). Touches contract + API read paths + the web status vocabulary; **no
> change to the record→replay→diff capture loop** and **no mandatory DB migration** (the distinction is
> derivable from data we already store).
>
> **Scope is bounded by four locked decisions (design interview, this slice):**
> 1. **"Verified" vs "Baseline" are first-class, distinct outcomes.** A comparison pass renders as
>    **Verified** (green ✓); a run that set/updated goldens renders as **Baseline** (info/anchor). Added to
>    the one shared status vocabulary (`apps/web/src/lib/status.tsx`) so it propagates to every surface.
> 2. **Re-baseline from a passed run is a per-checkpoint action** ("Set as new baseline" on each passed
>    checkpoint). `approveAll` is unchanged and **never** re-baselines a passed checkpoint implicitly.
> 3. **Baseline-establishment runs are excluded from the dashboard pass-rate KPI.** Pass-rate measures
>    *verification*; a baseline run is neither a pass nor a fail of a comparison → dropped from the
>    denominator.
> 4. **A first-capture run (seeds awaiting approval, no diffs) gets its own run-level "Pending baseline"
>    badge**, distinct from "Needs review" (which is reserved for an unresolved `diff`).
>
> **Outcome is derived, not stored.** The coarse `runs.status` column (`queued|running|passed|needs_review|
> failed`) is **unchanged** — kept for the worker, filters, and back-compat. A pure `deriveRunOutcome()`
> helper in `@varys/review-contract` maps a run's checkpoints (`reviewState` + `resolution`, both already
> stored) + `runs.error` into the finer **`RunOutcome`**. One helper, every consumer agrees.
>
> **Testing posture (per established direction):** **one compact chromium-free API E2E** that pins (a) the
> new approve-from-`passed` path writes/replaces a baseline + audits it, and (b) `deriveRunOutcome` returns
> the right outcome for the rollup matrix below. **Zero UI/component tests** — badges, the per-checkpoint
> "Set as new baseline" affordance, and the dashboard are the **manual click-through gate**. Prior art:
> `apps/api/test/runs.e2e.spec.ts`.

---

## Problem Statement

A Varys run currently resolves to one stored status. Two structurally different runs collapse onto
`passed`:

- **Baseline-creation run.** A first replay against an environment has no golden to compare to, so every
  checkpoint is seeded `pending-baseline` (`packages/runner/src/index.ts:368`). The reviewer **approves**
  the seeds — which *writes the golden baselines* (`apps/api/src/runs/runs.service.ts:547`) — and
  `recomputeRunStatus` (`runs.service.ts:483`), seeing nothing left unresolved, flips the run to **`passed`**.
  Nothing was *verified*; the screenshots were *accepted as truth*.
- **Verification run.** A later replay finds existing baselines and the pixel-diff is within threshold →
  **`passed`** with no human action (`runner/src/index.ts:392`). This is the genuine "the app still looks
  right" pass.

Both render through the single mapping in `apps/web/src/lib/status.tsx` (`passed → success ✓ "Passed"`), so
in the Runs table, the run-detail header, the dashboard matrix, suite-run children, and a test's run
history they are indistinguishable. A reviewer cannot answer "was this run a *check*, or did it *define the
truth*?" — which is the difference between "trustworthy green" and "we just accepted whatever was on
screen."

Compounding it: `approve()` rejects a `passed` checkpoint (`runs.service.ts:591`,
`nothing to approve (reviewState=passed)`). So when a passed actual has drifted slightly (within
threshold) or a reviewer wants to re-anchor the golden to the current look, **there is no way to promote a
passed actual to a new baseline** without forcing an artificial diff.

## Goals

- **G1.** Every surface that shows a run distinguishes **Verified** (comparison pass), **Baseline** (this
  run set/updated goldens), **Needs review** (unresolved diff), **Pending baseline** (unresolved first
  seeds), **Regression** (rejected), **Failed** (execution error), Queued/Running.
- **G2.** A reviewer can **set a passed checkpoint's actual as the new baseline** from the run viewer, with
  the same audit + irreversible-confirm as any baseline write (DESIGN §4, §8).
- **G3.** A **test's run history** lets you tell a baseline-creation run from a real run at a glance (the
  user's literal ask).
- **G4.** Pass-rate reflects *verification only* (baseline runs excluded).
- **G5.** No regression to the capture/replay/diff loop; no mandatory migration; one derivation helper
  shared by all consumers.

## Non-goals

- Re-introducing baseline **history/rollback** (DESIGN §4 accepted-risk #1 stands: replace is destructive,
  no undo).
- Changing the **stored** `runs.status` enum or the worker's status write.
- A bulk "re-baseline all passed checkpoints" run-level action (decision Q2 chose per-checkpoint; can be a
  fast-follow).
- Per-environment/-viewport changes — the existing `(testId, checkpointName, environment, viewportKey)` key
  is untouched.

---

## The model

### `RunOutcome` (derived, display + metrics)

```ts
// @varys/review-contract — pure, no db
export type RunOutcome =
  | "queued" | "running"
  | "verified"          // had baseline(s), all matched, no human action
  | "baseline"          // this run established/updated golden baseline(s)
  | "pending_baseline"  // only first-capture seeds unresolved, no diffs
  | "needs_review"      // an unresolved diff
  | "regression"        // a rejected checkpoint
  | "failed";           // execution error (runs.error != null)
```

### Per-checkpoint classification (the atoms) — `(reviewState, resolution)`

Already fully determined by stored columns:

| reviewState | resolution | Classification | Baseline write? |
|---|---|---|---|
| pending-baseline | null | Awaiting baseline | — |
| pending-baseline | approved | **Baseline established** | ✅ insert golden |
| pending-baseline | rejected | Seed rejected (discarded) | — |
| diff | null | Needs review | — |
| diff | approved | **Baseline updated** | ✅ replace golden |
| diff | rejected | Regression | — |
| passed | null | Verified | — |
| passed | approved | **Baseline refreshed** *(NEW this slice)* | ✅ replace golden |
| passed | rejected | *disallowed → 400* | — |

### Run rollup — `deriveRunOutcome(checkpoints, { status, error })`, precedence top→down

1. `status` is `queued`/`running` → same.
2. `error != null` (or `status === "failed"` with an error) → **`failed`**. *(Checkpoints reviewed before a
   crash never flip it — preserves `runs.service.ts:477`.)*
3. any checkpoint **unresolved** (`resolution == null` && `reviewState ∈ {pending-baseline, diff}`):
   - if all such are `pending-baseline` **and** no `diff` anywhere → **`pending_baseline`**
   - else → **`needs_review`**
4. any `resolution === "rejected"` → **`regression`**
5. any **baseline write** (`pending-baseline|diff|passed` & `approved`) → **`baseline`** *(wins in a mixed
   verified+baselined run — a golden changed; UI may append "· N verified")*
6. else → **`verified`**

This is a strict refinement: every `baseline`/`verified`/`regression`/`pending_baseline` maps back to a
stored `status` in `{passed, needs_review, failed}`, so filters keyed on `status` keep working.

---

## Test-case matrix (run-level, "consider all cases")

| # | Checkpoints in the run | Stored status | **Derived outcome** | Notes |
|---|---|---|---|---|
| 1 | all `passed`, none resolved | passed | **verified** | the true green pass |
| 2 | all `pending-baseline`, none resolved | needs_review | **pending_baseline** | first run, awaiting approval |
| 3 | all `pending-baseline`, all approved | passed | **baseline** (established) | the old "looks passed but isn't" case — now clearly Baseline |
| 4 | `diff`, none resolved | needs_review | **needs_review** | regression candidate |
| 5 | `diff` approved | passed | **baseline** (updated) | intentional change accepted |
| 6 | `diff` rejected | failed | **regression** | confirmed bug |
| 7 | `passed`, one approved (re-baseline) | passed | **baseline** (refreshed) | NEW action; rest verified |
| 8 | mix: some `passed` (none resolved) + some `pending-baseline` approved | passed | **baseline** | baseline wins; "· N verified" |
| 9 | mix: some `pending-baseline` unresolved + some `diff` unresolved | needs_review | **needs_review** | diff present → not pending_baseline |
| 10 | some approved, some still unresolved | needs_review | **needs_review** / **pending_baseline** | unresolved wins (step 3) |
| 11 | some `diff` rejected + some unresolved | needs_review | **needs_review** | unresolved outranks rejected (step 3 before 4) |
| 12 | execution error before any checkpoint | failed | **failed** | `error` set, no checkpoints |
| 13 | partial checkpoints captured, then crash | failed | **failed** | reviewing partials never flips to passed |
| 14 | re-run after baselining → all match | passed | **verified** | the baseline run's successor is a real pass |

Edge / interaction cases:

- **Re-baseline a pixel-identical pass** (diffScore ≈ 0): allowed; near-no-op on bytes; still updates audit
  (`approvedBy/At`) + resolution. UI shows an "already matches the baseline" hint before confirm.
- **Re-judge flips verdict** (MaskTuning live re-diff, `runs.service.ts reEvaluate/persistMasks`):
  `approve()` reads the *current* `reviewState`, so "Set as new baseline" always acts on the live verdict.
- **Per-env independence**: baselining env A leaves env B's matrix cell untouched.
- **Delete a run that sourced a baseline**: the blob is already kept (shared key, `runs.service.ts:387`);
  with the optional `sourceRunId` audit column we null it on delete.
- **Suite rollup** (`suite-runs.service.ts`): bar counts stay coarse (baseline + verified both fall in the
  "passed" bucket); each **child row** shows its fine outcome.

---

## Changes by layer

### Contract — `packages/review-contract/src/index.ts`
- Add `RunOutcome` + `deriveRunOutcome(checkpoints, { status, error })` (pure; lives here per the file's
  "verdict computed here" charter).
- Add `outcome: RunOutcome` to `RunView` and `RunSummary`; extend `MatrixCellStatus` with `baseline` /
  `verified` (it already carries `pending-baseline`); extend `SuiteRunChild` with `outcome`.

### API — `apps/api/src/runs/runs.service.ts`
- **`approve()`**: accept `reviewState === "passed"` → reuse the existing `diff` replace branch (a baseline
  provably exists for a passed checkpoint). Same destructive-replace + audit + `recomputeRunStatus`.
  `approveAll` candidate query is unchanged (selects only `pending-baseline|diff` unresolved) → passed is
  never re-baselined implicitly.
- **Read paths** (`getById` → RunView; the runs-list query → RunSummary; `dashboard.service.ts` matrix;
  `suite-runs.service.ts` children) call `deriveRunOutcome`. Stored `status` + `recomputeRunStatus`
  untouched.
- **Dashboard pass-rate** (`dashboard.service.ts:803`): denominator = finished runs **excluding** those
  whose outcome is `baseline` (and `pending_baseline`); numerator = `verified`. Document the new definition
  in the field comment.

### DB — `packages/db/src/schema.ts`
- **None required.** *Optional audit (can defer):* `baselines.sourceRunId uuid` + idempotent
  `ALTER TABLE baselines ADD COLUMN IF NOT EXISTS source_run_id uuid;`, set on approve, to power a
  "current baseline set by this run" indicator and a TestDetail "baseline established/updated" summary.

### Web
- **`apps/web/src/lib/status.tsx`** (single source of truth): add keys `verified` (success ✓ "Verified"),
  `baseline` (info, `Layers`/anchor, "Baseline"), `regression` (danger ✕ "Regression"); keep
  `pending-baseline`, `needs_review`, `failed`, `queued`, `running`. Render `run.outcome` everywhere a run
  is shown instead of raw `status`.
- **`RunDetail`**: header badge from `outcome`; per-passed-checkpoint **"Set as new baseline"** secondary
  action → existing approve mutation (now valid for passed) → irreversible confirm reusing the §8 confirm
  copy; baseline-sourced checkpoints show "Baseline established/updated by {who} · {when}".
- **Runs table, Dashboard `StatusMatrix`, SuiteRuns rows/report, `TestDetail` run history**: swap to
  `outcome` (G3 — the test-level distinction).

---

## Rollout slices
1. **Contract + API (no UI):** `deriveRunOutcome`, `outcome` on read models, `approve()` accepts `passed`.
   Additive; old UI keeps reading `status`.
2. **Web vocabulary:** `status.tsx` keys + badge swap across Runs table, RunDetail, matrix, suite runs,
   TestDetail.
3. **Re-baseline action:** "Set as new baseline" on passed checkpoints + confirm.
4. **Pass-rate semantics:** exclude baseline runs.
5. *(optional)* `baselines.sourceRunId` audit + TestDetail "baseline set by" summary.

## Testing
- **`apps/api/test/runs.e2e.spec.ts` (extend):** approve a `passed` checkpoint → asserts the golden row's
  `artifactKey` now equals the run's actual + `approvedBy/At` set + old blob deleted + run outcome becomes
  `baseline`. Plus a unit table for `deriveRunOutcome` covering matrix rows 1–14.
- **Zero UI/component tests.** Manual click-through gate: the three pills (Verified/Baseline/Regression),
  the "Set as new baseline" confirm, dashboard pass-rate, and TestDetail run history.
- Do **not** run the suite unless asked (established testing posture).

## Out of scope / deferred
- Baseline history & rollback (accepted-risk #1 stands).
- Run-level "re-baseline all passed" bulk action.
- Notifications when a baseline changes.
- Changing the stored `runs.status` taxonomy or worker status write.

## Accepted risks
- Approving a `passed` actual is **destructive** (replaces + deletes the old golden, no undo) — same risk
  class as approving a diff; guarded by the same irreversible confirm (DESIGN §4 / §8).
- `outcome` is derived on read (extra grouped query for the runs list); acceptable, mirrors the matrix's
  existing per-run aggregation.
