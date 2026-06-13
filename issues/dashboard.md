# Issues — Varys v2 Slice 7: Run dashboard

> Tracer-bullet issues for the dashboard slice (`prd/dashboard.md`).
> Three vertical slices; each cuts through the shared `GET /dashboard` read-model down to a
> wired, demoable widget, and each is demoable on its own.
> *Not published to an issue tracker — none configured (no remote / `gh`); the `ready-for-agent`
> label could not be applied. Build order = dependency order below.*
>
> **Testing posture (per user direction): no automated tests in this slice — neither UI/component
> nor API E2E.** Acceptance criteria are **implementation checkpoints** verified by **manual
> click-through**. (This consciously drops the chromium-free read-model E2E the PRD had pencilled
> in; the read-model derivation is verified by hand, not pinned by an automated guarantee.)
>
> **Build posture:** the dashboard UI already exists, fully built and **mocked** (`apps/web`
> Dashboard view: `KpiCard`, `StatusMatrix`, `RecentRuns`, `DiffTrend`, `AlertsPanel`, fed by a
> single `mock.tsx`). This slice replaces that one mock with a real **derive-on-read** API
> read-model and wires drill-through. The visual design is **locked** (matches the approved
> reference) — supply data, do not redesign.
>
> **Hard rules that bite here:** new NestJS controllers need explicit `@Inject(DashboardService)`
> (esbuild emits no decorator metadata — the dev server silently fails to boot otherwise). This
> slice is **derive-on-read only: no new table, no migration, no write path** — so there is no DDL
> and no "restart dev after schema change" step. Ports: API `:4000`, web `:5200`, Postgres `:5433`.
> No `Co-Authored-By` trailer in commits.
>
> **Scope cut (confirmed):** the **Alerts** widget is deferred to **slice 8** (notifications). Its
> panel stays in the layout as a neutral placeholder so the grid matches the design; it is not
> wired to data here.
>
> **Dependency shape:** `1` starts immediately; `1 → 2` and `1 → 3` (2 and 3 are independent of
> each other and can run in parallel once 1 lands).
>
> | Issue | Type | Status |
> |---|---|---|
> | 1 — Dashboard read-model + KPI summary + recent runs (full stack) | AFK | 🔴 Not started |
> | 2 — Test × Environment status matrix + drill-through | AFK | 🔴 Not started |
> | 3 — Checkpoint diff-trend sparklines | AFK | 🔴 Not started |

---

# Issue 1 — Dashboard read-model + KPI summary + recent runs (full stack)

## Parent

`prd/dashboard.md` — Varys v2 Slice 7: Run dashboard.

## What to build

Stand up the dashboard's backbone end-to-end and wire the first two widget clusters to live data.

Introduce a new `dashboard` API module exposing a single **`GET /dashboard`** that returns a
`DashboardView` read-model **derived on read** from existing tables (`runs`, `run_results`, `tests`,
`environments`) — no new table, no migration, no stored aggregate. This slice populates the
`summary` (KPIs) and `recentRuns` portions of the read-model; `matrix` and `trends` are added by
Issues 2 and 3.

`DashboardView` is a new type in the shared `@varys/review-contract` package (DB-free). Reuse the
existing `RunSummary` for the feed and the existing needs-review derivation for the needs-review KPI.

On the web side, add a `useDashboard()` TanStack Query hook (with a modest `refetchInterval` so a
completing run reflects without a manual refresh), delete the `summary`/`recentRuns`/alerts portions
of the single `mock.tsx`, and wire the four `KpiCard`s + `RecentRuns` to live data. Make the
dashboard the landing route, with each widget handling loading (skeleton) / empty ("no runs yet") /
error independently so one failing section never blanks the page. The `AlertsPanel` becomes a
neutral placeholder (no mock data) pending slice 8. The matrix and trend widgets keep their mock
data until Issues 2/3 cut them over.

**KPI definitions (implement exactly):**
- **Total tests** = count of tests; sub-line "across N environments" where N = distinct environments
  that have runs; delta = tests created in the last 7 days.
- **Pass rate (7d)** = `passed` runs ÷ all *finished* runs (`passed` + `needs_review` + `failed`)
  with `created_at` in the last 7 days; `0` when no finished runs; delta = this window's rate minus
  the prior 7-day window's, in percentage points.
- **Needs review** = checkpoints in `pending-baseline` | `diff` with no resolution (reuse existing
  needs-review query); delta vs the prior comparable window.
- **Failures (24h)** = runs with `status = "failed"` and `created_at` in the last 24h; delta vs the
  prior 24h.

## Acceptance criteria

- [ ] New `dashboard` NestJS module (controller + service) with **explicit `@Inject(DashboardService)`**; `GET /dashboard` is reachable on the running dev server (`:4000`).
- [ ] `DashboardView` type added to `@varys/review-contract` with `summary` + `recentRuns` populated this slice (and placeholders/optionality for `matrix`/`trends` to be filled by Issues 2/3).
- [ ] `summary` returns the four KPIs with values **and** deltas computed per the definitions above (incl. the no-finished-runs → pass rate 0 edge).
- [ ] `recentRuns` returns newest-first `RunSummary[]` with a small limit (~6–8).
- [ ] Service derives everything **on read** — no new table, no migration, no stored aggregate; existing `runs.e2e` / `suite-runs.e2e` still pass (additive, no regressions).
- [ ] `useDashboard()` hook added (fetcher + query key + `refetchInterval`); dashboard is the landing route.
- [ ] Four `KpiCard`s render live `summary` data; `RecentRuns` renders live data, each row opens its run, and "View all" routes to the Runs history.
- [ ] `AlertsPanel` renders a neutral placeholder (no mock data); the `summary`/`recentRuns`/alerts portions of `mock.tsx` are removed (matrix/trend mock data remains for now).
- [ ] Each widget has independent loading / empty / error states; a fresh install (zero runs) renders sensibly (zeros, empty feed); `prefers-reduced-motion` is honoured.
- [ ] `pnpm --filter @varys/web build` is clean; the API dev server boots.
- [ ] **Verification is manual click-through** — no automated UI or API tests added (per direction).

## Blocked by

None — can start immediately.

---

# Issue 2 — Test × Environment status matrix + drill-through

## Parent

`prd/dashboard.md` — Varys v2 Slice 7: Run dashboard.

## What to build

Add the hero **test × environment status matrix** to the read-model and wire it to the live grid
with full drill-through.

Extend `GET /dashboard` with a `matrix` section: `environments` (column order — distinct envs with
runs, plus "default") and `rows` (one per test that has runs), each cell carrying a derived
`status` and the `runId` to open.

**Cell derivation (the one piece of real logic):** a cell is the **latest** run for that
`(test, environment)` pair (max `created_at`), mapped to a `MatrixCellStatus`:
- latest run `failed` → `failed`
- latest run `queued` | `running` → `running`
- latest run `passed` → `passed`
- latest run `needs_review` → inspect its `run_results`: any checkpoint in `diff` → `needs_review`
  (amber "Review"); else (only `pending-baseline`) → `pending-baseline` (blue "Baseline")
- no run for the pair → `none` (neutral "—", non-interactive)

Wire `StatusMatrix` to the live `matrix` data and remove its mock; each cell with a `runId` becomes a
button that navigates to the run, so the path is **matrix → run → checkpoints → diff viewer** in one
click (reuse the existing run detail + diff viewer). Reuse `lib/status` for cell colour/label/icon.

## Acceptance criteria

- [ ] `GET /dashboard` returns `matrix` with `environments` (correct column order) and `rows` (tests with runs), each cell carrying `status` + `runId`.
- [ ] Cell status reflects the **latest** run for the pair (a newer run supersedes an older one).
- [ ] The **review-vs-baseline distinction** is correct: a `needs_review` run with a `diff` checkpoint → `needs_review`; with only `pending-baseline` checkpoints → `pending-baseline`.
- [ ] `failed`, `running` (queued/running), `passed`, and `none` (no run) map correctly; `runId` is present for drill-through and null for `none`.
- [ ] `StatusMatrix` renders live data with the locked design's colour language (passed / review / failed / baseline / running / —) and its legend.
- [ ] Clicking a cell with a `runId` opens that run; a `none` cell is non-interactive; the matrix scrolls without breaking page layout for a large suite.
- [ ] The matrix portion of `mock.tsx` is removed.
- [ ] `pnpm --filter @varys/web build` is clean; existing `runs.e2e` / `suite-runs.e2e` still pass.
- [ ] **Verification is manual click-through** — no automated UI or API tests added (per direction).

## Blocked by

- Issue 1 (the `dashboard` module, `GET /dashboard`, and `useDashboard()` hook must exist).

---

# Issue 3 — Checkpoint diff-trend sparklines

## Parent

`prd/dashboard.md` — Varys v2 Slice 7: Run dashboard.

## What to build

Add **per-checkpoint diff-trend sparklines** to the read-model and feed the existing trend widget
real series instead of the synthetic generator.

Extend `GET /dashboard` with a `trends` section: for each checkpoint with runs in the last **14
days**, build the diff-score series ordered by run `created_at` (oldest→newest) from
`run_results.diff_score`. Select the **top N most relevant** checkpoints (worst latest score /
largest recent rise), and for each return `checkpointName`, `testName`, the `points` series,
`latestScore`, and a `tone` (success / warning / danger) derived from the latest score band.

Wire `DiffTrend` to the live `trends` data (it already renders an SVG polyline from a points series —
feed it the real series), label each row with the checkpoint name + latest diff score, and remove the
synthetic `spark()` generator. Whichever of Issues 2/3 lands last deletes the now-empty `mock.tsx`.

## Acceptance criteria

- [ ] `GET /dashboard` returns `trends` — per-checkpoint diff-score series over the **last 14 days**, ordered oldest→newest, with `checkpointName`, `testName`, `latestScore`, and `tone`.
- [ ] Only the **top N relevant** checkpoints are returned (deterministic selection — worst/most-moving), not every checkpoint.
- [ ] `DiffTrend` renders the live series with name + latest score per row; worsening trends read as warning/danger and stable as success; the 14-day horizon is consistent across rows.
- [ ] The synthetic sparkline generator and the trend portion of `mock.tsx` are removed; if this lands after Issue 2, `mock.tsx` is deleted entirely.
- [ ] `prefers-reduced-motion` is honoured for the sparkline animation.
- [ ] `pnpm --filter @varys/web build` is clean; existing `runs.e2e` / `suite-runs.e2e` still pass.
- [ ] **Verification is manual click-through** — no automated UI or API tests added (per direction).

## Blocked by

- Issue 1 (the `dashboard` module, `GET /dashboard`, and `useDashboard()` hook must exist).
