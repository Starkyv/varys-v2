# PRD — Varys v2 Slice 7: Run dashboard

> The hero landing surface: a **test × environment status matrix**, KPI summary, a recent-runs
> activity feed, and **per-checkpoint diff-trend sparklines** — every cell and row a drill-through
> into the existing run → checkpoints → diff viewer. Slice 7 of the roadmap in `DESIGN.md` §14
> (§10 Run dashboard). **Depends on:** slice 6 (suite runs ✅) for the run corpus; reads slices
> 1–6 data only — it adds **no new write path and no new table**.
>
> **Build posture:** the dashboard *UI already exists, fully built and mocked* (`apps/web` Dashboard
> view: `KpiCard`, `StatusMatrix`, `RecentRuns`, `DiffTrend`, `AlertsPanel`, all fed by a single
> `mock.tsx`). This slice replaces that one mock with a real **derive-on-read** API read-model and
> wires the drill-through. The visual design is locked (matches the provided reference); we are
> giving it real data, not redesigning it.
>
> **Testing posture (per established direction):** derive-on-read, no stored aggregates; **one
> compact chromium-free API E2E** (`dashboard.e2e`) pins the whole aggregation; **zero UI/component
> tests** — the dashboard render + drill-through is the manual click-through gate. Prior art:
> `runs.e2e.spec.ts`, `suite-runs.e2e.spec.ts`.
>
> **Scope cut (confirmed):** the **Alerts** widget is **deferred to slice 8** (notifications). Its
> panel stays in the layout as a neutral placeholder so the grid matches the design, but it is not
> wired to data here. Slack/in-app *push* delivery and scheduling are slice 8 by the roadmap.

---

## Problem Statement

A user with more than a handful of tests across several environments has no single place to answer
"is anything broken right now, and where?" Today they must open the Runs history and scan it
linearly, or page through the flat needs-review list — neither shows the **test × environment**
shape of health, neither surfaces a checkpoint that is *quietly drifting* run-over-run before it
trips the threshold, and neither gives an at-a-glance pulse (how many tests, what's the pass rate,
how much is pending, how many just failed). The result is that regressions and review backlogs are
discovered late, by manual scanning, instead of being the first thing the product shows you.

## Solution

A dashboard that is the product's landing surface and answers "what needs my attention?" in one
view:

- **KPI summary** — total tests (and how many environments they span), pass rate over the last 7
  days, checkpoints currently needing review, and failures in the last 24h — each with a
  trend delta against the prior comparable window.
- **Test × Environment status matrix** — one row per test, one column per environment, each cell the
  **latest run's outcome** for that pairing (passed / needs-review / failed / new-baseline / running
  / never-run). Clicking a cell drills straight into that run, then its checkpoints, then the diff
  viewer.
- **Recent runs feed** — the newest runs across all tests/environments, each a one-click open, with a
  "View all" into the full Runs history.
- **Checkpoint diff-trend sparklines** — per-checkpoint diff-score series over the last 14 days, so a
  checkpoint trending toward its threshold (or newly spiking) stands out before it fails.

All of this is **derived on read** from data slices 1–6 already persist (runs, run_results, run_steps,
baselines, tests, environments) — no new tables, no new write path, no background aggregation.

## User Stories

1. As a QA lead, I want a dashboard as the app's landing view, so that the first thing I see is the current health of my suite rather than a raw list.
2. As a QA lead, I want a "total tests" KPI, so that I know the size of my suite at a glance.
3. As a QA lead, I want the total-tests KPI to note how many environments those tests span, so that I understand the breadth of coverage in one line.
4. As a QA lead, I want a delta on total tests (e.g. "+6"), so that I can see growth against the prior window.
5. As a release manager, I want a "pass rate" KPI over the last 7 days, so that I can gauge overall stability without computing it myself.
6. As a release manager, I want the pass-rate KPI to show whether it improved or regressed versus the prior 7 days, so that I can tell the trend direction, not just the level.
7. As a reviewer, I want a "needs review" KPI counting checkpoints currently awaiting a decision, so that I know how much review work is queued.
8. As a reviewer, I want the needs-review KPI's delta against the prior window, so that I can see whether my backlog is growing.
9. As an on-call engineer, I want a "failures in the last 24h" KPI, so that I can immediately see if something broke recently.
10. As an on-call engineer, I want the failures KPI's delta versus the prior 24h, so that I can tell whether failures are rising or settling.
11. As a QA lead, I want a test × environment status matrix, so that I can see the health of every test in every environment in one grid.
12. As a QA lead, I want each matrix cell to reflect the **latest** run for that test+environment, so that the grid always shows the current state, not a stale one.
13. As a QA lead, I want a passed cell visually distinct (green/check), so that healthy pairings recede into the background.
14. As a reviewer, I want a needs-review cell distinct (amber/eye), so that a real visual diff awaiting my decision stands out.
15. As a reviewer, I want a new-baseline cell distinct from a needs-review cell (blue/baseline), so that "first capture, approve to seed" is not confused with "a diff to judge."
16. As an on-call engineer, I want a failed cell distinct (red/✕), so that an execution failure is unmistakable.
17. As a user, I want a running/queued cell to show an in-progress indicator, so that I know a result is still pending rather than missing.
18. As a user, I want a cell with no run yet to show a neutral "—", so that an untested pairing reads as "no data" rather than implying a pass or fail.
19. As a reviewer, I want to click a matrix cell and land on that exact run, so that I can go from "something's amber here" to the evidence in one click.
20. As a reviewer, I want clicking through a cell to reach the run's checkpoints and then the diff viewer, so that the drill path is matrix → run → checkpoint → diff with no detours.
21. As a QA lead, I want a legend on the matrix (passed / review / failed / baseline), so that the colour language is self-explanatory.
22. As a QA lead with many tests, I want the matrix to scroll without breaking the page layout, so that a large suite stays usable.
23. As a user, I want a recent-runs activity feed beside the matrix, so that I can see the latest run events chronologically regardless of test or environment.
24. As a user, I want each feed row to show the test name, environment, outcome, and relative time, so that I can triage it without opening it.
25. As a user, I want to click a feed row to open that run, so that the feed is a launch point, not just a log.
26. As a user, I want a "View all" control on the feed, so that I can jump to the full Runs history when the latest few aren't enough.
27. As a QA lead, I want per-checkpoint diff-trend sparklines, so that I can spot a checkpoint drifting toward its threshold before it fails.
28. As a QA lead, I want each sparkline labelled with the checkpoint name and its latest diff score, so that I can identify which checkpoint is moving and by how much.
29. As a QA lead, I want a worsening trend tinted as a warning/danger and a stable one as success, so that the dangerous trends draw the eye.
30. As a QA lead, I want the trend window fixed at 14 days, so that the sparkline is a consistent, comparable horizon across checkpoints.
31. As a user, I want the dashboard to refresh periodically (or on focus), so that what I'm looking at stays current while a run completes.
32. As a user, I want each widget to show a skeleton while loading and a friendly empty state when there's no data yet, so that a fresh install or a quiet period doesn't look broken.
33. As a user, I want each widget to degrade independently on error (one failing section doesn't blank the whole page), so that a partial data problem still leaves the rest usable.
34. As a new user with zero runs, I want the dashboard to render sensibly (zeros, empty matrix, "no runs yet" feed), so that the product's first impression is intact before I've recorded anything.
35. As an accessibility-reliant user, I want the matrix cells, feed rows, and KPI cards to be keyboard-reachable with clear focus and meaningful labels, so that I can navigate the dashboard without a mouse.
36. As a user who prefers reduced motion, I want the staggered entrance and sparkline animations to honour `prefers-reduced-motion`, so that the dashboard isn't distracting.
37. As a developer, I want the dashboard powered by a single read endpoint, so that the page makes one request and the aggregation is testable in one place.
38. As a developer, I want the dashboard read-model derived on read from existing tables, so that no new write path, table, or background job is introduced and there's nothing to keep in sync.

## Implementation Decisions

### Read-model & API seam

- **One new `dashboard` module** (NestJS controller + service) exposing a **single
  `GET /dashboard`** that returns a `DashboardView` read-model assembled **derive-on-read** from
  `runs`, `run_results`, `run_steps`, `baselines`, `tests`, `environments`. No new table, no
  migration, no aggregate state stored — consistent with the suite-runs "derived on read" decision.
- The new controller must use **explicit `@Inject(DashboardService)`** in its constructor (esbuild
  emits no decorator metadata in this repo; implicit DI silently fails to boot the dev server even
  when tests are green — see the suite-runs slice note).
- **`DashboardView` is a new type in `@varys/review-contract`** (the shared, DB-free contract).
  Reuse the existing `RunSummary` for the feed; reuse the existing `needsReview` derivation for the
  needs-review KPI rather than re-deriving it.

`DashboardView` shape (decision-encoding sketch; field names may be refined in code):

```ts
interface DashboardView {
  summary: {
    totalTests: number;
    environmentsCount: number;          // KPI sub: "across N environments"
    totalTestsDelta: number;            // tests created in the last 7d
    passRate: number;                   // 0..1, last 7 days (see definition below)
    passRateDeltaPct: number;           // signed pp change vs prior 7d
    needsReview: number;                // checkpoints awaiting a decision (now)
    needsReviewDelta: number;           // vs prior comparable window
    failures24h: number;                // runs with status "failed" in last 24h
    failures24hDelta: number;           // vs prior 24h
  };
  matrix: {
    environments: string[];            // column order (env names; "default" when none)
    rows: Array<{
      testId: string;
      testName: string;
      cells: Array<{
        environment: string;
        status: MatrixCellStatus;       // see taxonomy below
        runId: string | null;           // drill-through target; null when never run
      }>;
    }>;
  };
  recentRuns: RunSummary[];             // newest-first, small limit (~6–8)
  trends: Array<{
    checkpointName: string;
    testName: string;
    points: number[];                   // diff-score series over last 14d, oldest→newest
    latestScore: number | null;
    tone: "success" | "warning" | "danger";
  }>;
  // NOTE: no `alerts` field this slice — deferred to slice 8.
}
```

### Matrix cell status derivation (the one piece of real logic)

- A cell is the **latest run** for that `(test, environment)` pair (max `runs.created_at`), mapped to
  `MatrixCellStatus`:
  - latest run `failed` → **`failed`**
  - latest run `queued` | `running` → **`running`** (in-progress indicator)
  - latest run `passed` → **`passed`**
  - latest run `needs_review` → inspect its `run_results`: any checkpoint in `diff` → **`needs_review`**
    (amber); else (only `pending-baseline`) → **`pending-baseline`** (blue "baseline"). This is the
    distinction the design draws between "Review" and "Baseline".
  - no run for the pair → **`none`** (neutral "—")
- `environments` columns = the distinct environments that actually have runs (plus "default"); rows =
  tests that have at least one run. (A test never run anywhere simply doesn't appear — the matrix is a
  health grid, not a catalogue.)

### KPI definitions (pin these in the E2E)

- **Total tests** = count of `tests`; `environmentsCount` = distinct environments with runs (the
  "across N environments" sub); `totalTestsDelta` = tests created within the last 7 days.
- **Pass rate (7d)** = `passed` runs ÷ all *finished* runs (`passed` + `needs_review` + `failed`) with
  `created_at` in the last 7 days; `0` when there are no finished runs. Delta = this window's rate minus
  the prior 7-day window's rate, in percentage points.
- **Needs review** = checkpoints in `pending-baseline` | `diff` with no `resolution` (reuse the
  existing needs-review query); delta vs the count as-of the prior window boundary.
- **Failures (24h)** = runs with `status = "failed"` and `created_at` in the last 24h; delta vs the
  prior 24h.

### Trend derivation

- For each checkpoint with runs in the last 14 days, build the **diff-score series** ordered by run
  `created_at` (oldest→newest) from `run_results.diff_score`. Pick the **top N most relevant**
  checkpoints (e.g. worst latest score / largest recent rise) for display; `tone` from the latest
  score against a simple threshold band (success / warning / danger). The widget renders the series as
  an SVG polyline (the existing `DiffTrend` component already does this from a points string — feed it
  real series instead of the synthetic generator).

### Web wiring

- **Delete the single `mock.tsx`** and add a `useDashboard()` TanStack Query hook (`api.ts` fetcher +
  `queries.ts` hook + query key) with a modest `refetchInterval` (the Runs list already uses 3s; the
  dashboard can poll a little slower) so completing runs reflect without a manual refresh.
- The existing widgets stay; their props change from mock constants to read-model fields:
  - `KpiCard` ← `summary` (value/delta/dir/sub already match the mock's `Kpi` shape).
  - `StatusMatrix` ← `matrix`; each cell becomes a button that `navigate`s to the run when `runId` is
    set (it already imports `useRouter`; today it navigates from mock cells — point it at real
    `runId`s; a `none` cell is non-interactive).
  - `RecentRuns` ← `recentRuns` (`RunSummary[]`); rows open the run; "View all" routes to the Runs
    history.
  - `DiffTrend` ← `trends`.
  - `AlertsPanel` ← **placeholder this slice** (neutral empty/"arrives with notifications" state, no
    mock data); real feed in slice 8.
- Reuse `lib/status` (`StatusIcon`, `statusVars`, `statusLabel`, `TONE_VARS`) and `lib/format`
  (relative time, percentages) for consistent colour/label/format language. Keep the existing
  framer-motion staggered `Reveal` entrance and `prefers-reduced-motion` handling.
- Make the dashboard the **landing route**, with each widget loading/empty/error state handled
  independently so one failure doesn't blank the page.

### Constraints / environment facts

- Derive-on-read only; **no new table, no migration** (so no "restart dev after DDL" concern here).
- Ports unchanged: API `:4000`, web `:5200`, Postgres `:5433`.
- `EnvironmentView` secret values remain write-only and are irrelevant to this read surface.
- Repo rules: no `Co-Authored-By` trailer in commits; commit to `main` only when asked.

## Testing Decisions

- **What a good test pins here:** external, observable behaviour of the `GET /dashboard`
  read-model — *given a seeded corpus of tests/runs/run_results/run_steps across multiple
  environments and time windows, the endpoint returns the correct derived figures and shapes* — not
  the internal SQL or service method structure.
- **One module under test:** the new `dashboard` API module, via **a single chromium-free E2E**
  (`apps/api/test/dashboard.e2e.spec.ts`). It seeds directly through the DB/services (no browser, no
  worker) and asserts:
  1. **Matrix latest-per-cell** — with two runs for the same `(test, env)`, the cell reflects the
     newer one; the **review vs baseline** distinction (a `needs_review` run with a `diff` checkpoint →
     `needs_review`; with only `pending-baseline` → `pending-baseline`); a pair with no run → `none`;
     `running`/`failed`/`passed` mappings; `runId` present for drill-through, null for `none`.
  2. **KPI math** — `totalTests`/`environmentsCount`; `passRate` over the 7-day window with the exact
     numerator/denominator rule (incl. the no-finished-runs → 0 edge); `needsReview`; `failures24h`;
     and each delta against its prior window (seed rows on both sides of the boundary).
  3. **Recent runs** — newest-first ordering and the small limit.
  4. **Trends** — series ordering oldest→newest, the 14-day horizon boundary, and `latestScore`.
- **Prior art:** `apps/api/test/runs.e2e.spec.ts` and `apps/api/test/suite-runs.e2e.spec.ts` (the
  established chromium-free, server-guarantee E2E pattern — seed via services, assert the read-model).
- **No UI/component tests** anywhere in this slice (house posture). The dashboard render, the matrix
  drill-through (cell → run → checkpoint → diff), the feed/"View all" navigation, the sparkline render,
  loading/empty/error states, and reduced-motion are the **manual click-through gate**.
- Run E2Es per file. Regression check the existing `runs.e2e` / `suite-runs.e2e` still pass (the new
  module is additive and must not perturb them).

## Out of Scope

- **Alerts feed + notifications** — the `AlertsPanel` is a placeholder this slice. Deriving/persisting
  alert events, the in-app inbox behaviour, and **Slack/in-app push delivery** all belong to **slice 8
  (Scheduling + notifications)**, as does any cron/scheduled triggering.
- **Dashboard filtering/segmentation** — by folder, tag, suite, environment subset, or date range.
  This slice ships the global view; saved filters/segments are a later enhancement.
- **Configurable KPI windows / custom metrics** — the windows (7d pass rate, 24h failures, 14d trends)
  are fixed.
- **Drill-through *from* a sparkline** to that checkpoint's history view — the trend is informational
  this slice (linking a sparkline to a run is a nice-to-have, not required).
- **Auth/RBAC scoping** of dashboard data (slice 10) — the flat model shows the whole org's data.
- **Persisted/materialised aggregates, caching layers, or a metrics store** — explicitly avoided;
  everything is derived on read. Revisit only if the read proves too slow at real scale.
- **Re-design of the dashboard visuals** — the layout/components are locked to the approved design;
  this slice supplies data, not a redesign.

## Further Notes

- The dashboard UI is **already implemented and mocked** (`apps/web/src/views/Dashboard/**` with one
  `mock.tsx`). This is deliberately a thin slice: the bulk of the work is the read-model service +
  its one E2E, plus swapping the mock for the live hook and wiring real drill-through `runId`s. Read
  the existing `StatusMatrix`, `RecentRuns`, `DiffTrend`, `KpiCard`, and `mock.tsx` first so the
  read-model is shaped to what the widgets already consume (the mock's `Kpi`/`MatrixRow`/`FeedItem`/
  `Sparkline` interfaces are a faithful preview of the contract).
- The matrix's review-vs-baseline cell distinction is the one subtle derivation — it requires looking
  past the run-level `needs_review` status into the run's `run_results` review states. Keep that logic
  in the service and pin it in the E2E.
- Suggested build order: (1) `DashboardView` contract type → (2) `dashboard` service (derive-on-read) +
  `dashboard.e2e` → (3) controller + `useDashboard()` hook → (4) swap mocks / wire drill-through →
  (5) manual click-through (restart `pnpm dev` not required — no DDL).
- **Issue-tracker note:** no tracker is configured in this repo (no remote / `gh`), so the
  `ready-for-agent` label could not be applied — same situation as the suite-runs slice. This PRD lives
  at `prd/dashboard.md`; cut it into tracer-bullet issues with `/to-issues` (→ `issues/dashboard.md`)
  when ready to build.
