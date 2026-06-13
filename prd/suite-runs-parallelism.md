# PRD — Suite runs + parallelism (Slice 6)

> Slice 6 of the roadmap in `DESIGN.md` §14: **fan-out/fan-in, `suite × env(s)`, aggregated
> run reports** (§6 Playback infrastructure, §5 Organization model). Depends on slice 4
> (multi-environment, ✅ done) and slice 5 (suites, ✅ done).
> *Not published to an issue tracker — none configured; the `ready-for-agent` label could not
> be applied. This file is the artifact.*

## Problem Statement

I can organize tests into suites ("release 5.0", "Acme pre-deploy", "smoke"), but I can't
*run* one. Today the Run button executes exactly one test against exactly one environment.
Before a release I have to find every relevant test on the Tests tab and click Run on each,
once per environment — there's no single trigger for "run the release suite against staging",
no single place that answers "did the release suite pass?", and the runs land in the flat
history as disconnected rows I have to mentally regroup. On top of that, runs execute one at
a time, so a ten-test suite takes ten tests' worth of wall-clock even on an idle machine.

## Solution

A suite becomes runnable. From the Suites tab I pick one or more environments and hit Run;
Varys fans the suite out into one run per *(member test × environment)* and tracks them under
a single **suite run**. A suite-run report shows the aggregate verdict at a glance — counts
of passed / needs-review / failed, an overall status — and a per-test×env breakdown where
each cell links straight into the existing run view / diff viewer. The Runs tab shows the
suite run as one row with its aggregate status instead of a pile of disconnected children.
The worker executes runs **in parallel** (configurable concurrency, steps within a test
still strictly sequential), so suites finish in roughly the wall-clock of the slowest test,
not the sum.

## User Stories

1. As a release manager, I want to run an entire suite with one action, so that pre-release verification is a single trigger instead of N manual runs.
2. As a release manager, I want to run a suite against *several environments at once* (`suite × env(s)`), so that one trigger covers staging and every customer deployment.
3. As a QA engineer, I want a suite run to create one run per member test per environment, so that each test keeps its own status, error attribution, and diff review exactly as single runs have today.
4. As a QA engineer, I want an aggregated suite-run report (overall status + passed/needs-review/failed counts), so that I can answer "is the release good?" without opening every run.
5. As a QA engineer, I want the report to show a per-test×environment breakdown, so that I can see *which* test on *which* environment broke.
6. As a reviewer, I want each cell in the report to link to the existing run view / diff viewer, so that reviewing a suite-run diff is the same flow I already know.
7. As a QA engineer, I want the suite run to appear in the Runs history as a single aggregate row, so that history stays scannable instead of being flooded by its children.
8. As a QA engineer, I want a suite run's child runs *not* to clutter the top-level Runs list, so that one suite trigger doesn't bury my standalone runs.
9. As a reviewer, I want checkpoints from suite-run children to appear in Needs Review exactly like any other run's, so that the review inbox stays the one place where decisions happen.
10. As a developer, I want runs to execute in parallel with a configurable concurrency cap, so that a suite finishes in the wall-clock of its slowest tests, not their sum.
11. As a developer, I want steps *within* a test to stay strictly sequential in a fresh browser context, so that parallelism never changes a test's semantics.
12. As a QA engineer, I want the suite-run report to live-update while children execute, so that I can watch the suite converge without refreshing.
13. As a QA engineer, I want the suite run to snapshot the suite's membership at trigger time, so that editing the suite mid-run doesn't change what an in-flight run means.
14. As a QA engineer, I want each child pinned to its test's latest version at trigger time (same as single runs), so that a suite run is a coherent snapshot of "the tests as they were".
15. As a QA engineer, I want triggering an empty suite to be rejected with a clear error, so that I don't get a vacuous green report.
16. As a QA engineer, I want suite-run history to survive deleting or renaming the suite, so that past verdicts remain auditable.
17. As a QA engineer, I want a child run that errors to show its failed step (existing attribution), so that suite-run failures are as debuggable as single-run failures.
18. As a release manager, I want the environments I picked remembered for next time, so that the routine "run release suite on staging" is two clicks.
19. As a developer, I want to scale throughput by running more worker processes against the same queue, so that the pool grows horizontally without code changes.
20. As a QA engineer, I want a suite run against an environment whose profile is missing a variable to fail per-test with the existing step-level error (not crash the whole suite run), so that one misconfigured value doesn't hide the other results.

## Implementation Decisions

**Domain model — parent/child, fan-in on read.**

- New **suite_runs** parent entity: references the suite (FK `ON DELETE SET NULL`) and
  carries a **denormalized suite-name snapshot**, so reports survive suite deletion/rename
  (same graceful-degradation precedent as environment deletion).
- The existing **runs** table gains a nullable **suite_run_id** reference. A child run is an
  utterly ordinary run — same statuses (`queued | running | passed | needs_review | failed`),
  same error/failed-step attribution, same checkpoints, same diff-review flow. Standalone
  runs keep `suite_run_id = null`. Additive DDL (`IF NOT EXISTS`), applied on API boot.
- **No aggregate state is stored.** Suite-run status and counts are **derived on read** from
  the children: all-queued → `queued`; any child queued/running → `running`; otherwise
  any `failed` → `failed`, else any `needs_review` → `needs_review`, else `passed`.
  Deriving on read eliminates fan-in races and counter-update bugs entirely; report reads
  are one aggregate query over the children.

**Trigger semantics.**

- Trigger takes the suite plus **zero or more environment ids**. One child run is created
  per *(member test × selected environment)*; with no environments selected, one child per
  test with no environment (baselines under `"default"`), mirroring today's optional-env
  single run.
- Membership is **resolved once at trigger time** (snapshot) and each child is pinned to its
  test's **latest test_version at trigger time** — later suite edits or test re-records do
  not mutate an in-flight or historical suite run.
- Guards: unknown suite or unknown environment id → not-found; **empty suite → bad request**
  ("suite has no members"). Children are created and enqueued in one transaction-then-enqueue
  sequence reusing the existing single-run creation path.

**Queue & worker — the worker stays suite-agnostic.**

- Fan-out reuses the **existing pg-boss `run` queue and job shape** (`{ runId }`). The
  worker does not know suites exist; there is no parent job, no completion callback, no
  orchestrator. Fan-in happens purely in the read-model. This keeps the runner untouched.
- **Parallelism is a worker-side concurrency option**: the queue package's run-subscription
  gains a concurrency parameter (jobs fetched in batches and processed concurrently,
  each in its own fresh browser via the existing per-run launch); the worker reads it from
  an env var (default 2). Steps within a test remain sequential — parallelism is only
  *across* runs (DESIGN §6: test-level fan-out, steps sequential).
- Horizontal scale falls out for free: additional worker processes on the same queue
  (pg-boss `SKIP LOCKED`) raise the pool cap with zero code changes.

**API contract (shared review-contract types alongside the existing run types).**

- Trigger: create-suite-run action on a suite, body `{ environmentIds?: string[] }` →
  `{ suiteRunId }`.
- `SuiteRunSummary` (listing, newest first): id, suite name (snapshot), trigger time,
  environment names, derived status, counts `{ total, queued, running, passed, needsReview,
  failed }`.
- `SuiteRunView` (report): the summary plus child rows — each child's run id, test name,
  environment name, status, error — ordered for a stable test×env grid. Cells link via the
  existing `?run=<id>` deep link.
- The flat runs listing **excludes suite-run children server-side**; suite runs are listed
  through their own aggregate listing. Needs Review is untouched — it queries checkpoints
  and therefore already includes children's diffs/seeds.

**Web UI (same SPA patterns: `?view=` tabs, deep links, TanStack Query 3s polling).**

- **Suites tab** gains the Run affordance slice 5 deliberately withheld: per suite, an
  environment multi-pick (defaults remembered in localStorage, like the Tests tab's
  last-used env) and a Run button (disabled for empty suites) that triggers and navigates
  to the report.
- **Suite-run report** at a new deep link (`?suiteRun=<id>`): header (suite name, when,
  aggregate status, counts), grid/list of test × environment cells with per-child status,
  error preview, and link into the run view / diff viewer; polls while any child is
  non-terminal.
- **Runs tab** interleaves suite-run aggregate rows (linking to the report) with standalone
  single runs by recency; children appear only inside the report.

**Hard rules carried forward:** new NestJS controllers use explicit `@Inject(Service)`
(esbuild emits no decorator metadata); DDL is additive and applies on boot — **restart
`pnpm dev` after the schema change**; organization/run metadata stays relational, never in
definition jsonb; API never returns secret values. Ports: API :4000, web :5200, PG :5433.

## Testing Decisions

- A good test pins **externally observable server behavior through the highest existing
  seam** — the HTTP API against a real Postgres — and never inspects implementation details
  (no asserting on queue internals, no poking service privates).
- **Chromium-free API E2Es** (supertest + full app module on Testcontainers Postgres; prior
  art: `suites.e2e.spec.ts`, `folders.e2e.spec.ts`), run per-file. They pin, per the agreed
  seam sketch:
  - **Fan-out shape:** triggering a suite with M tests × N selected environments creates one
    parent and M×N children, each child pinned to the right test version and environment;
    children are excluded from the flat runs listing.
  - **Fan-in/aggregation:** the report derives status and counts from child statuses
    (all-queued → queued; mixed terminal states → failed/needs_review precedence; survives
    suite deletion via the name snapshot).
  - **Guards:** empty suite → bad request; unknown suite/environment → not found.
- Without a worker in the E2E, children legitimately stay `queued` — terminal-state
  aggregation is exercised by completing children through the same database the app runs on,
  not by booting chromium.
- **Worker parallelism is manual-verified** (trigger a suite, watch multiple runs go
  `running` concurrently) — per direction, no automated chromium/parallel-execution tests.
- **No UI/component tests** (standing direction); the Suites-tab Run affordance, report
  view, and Runs-tab interleaving are the manual click-through gate.

## Out of Scope

- **Scheduling/cron triggers and Slack/in-app notifications** — slice 8 (`(suite) × (env(s))
  × (when)` rides on this slice's trigger).
- **Dashboard** — test × environment status matrix, activity feed, trend sparklines (slice 7,
  builds on this read-model).
- **CI/webhook triggers** — slice 12 (same rail, extra doorway).
- **Error retries** (retry-errors-once, never-retry-diffs — DESIGN §6): deliberately not in
  this slice; today's single-attempt behavior is unchanged for children.
- **Cancellation** of an in-flight suite run (no single-run cancellation exists either).
- **Dynamic (tag-query) suite membership** — still deferred from slice 5; suite runs snapshot
  explicit membership only.
- **Pool autoscaling / multi-viewport / cross-browser** — explicitly deferred post-MVP items.

## Further Notes

- The motivating workflow (from user discussion): tags mark every grouping a test belongs to
  (`release:5.0`, `customer:acme`, `feature:forecasting`); a suite turns one grouping into a
  runnable selection; this slice makes that selection executable per environment — e.g.
  "release 5.0 regression × staging" or "Acme pre-deploy × acme-prod" as one trigger.
- Aggregate-on-read means a suite run's verdict can *improve* after the fact: a child's
  `needs_review` flipping to approved/passed is reflected the next time the report is read.
  That is intended — the report mirrors the live review state, like Needs Review does.
- A deleted environment mid-flight degrades the same way single runs already do (env name
  resolution falls back to `"default"` for display; children keep their recorded ids).
- Slices 7 (dashboard) and 8 (scheduling) both consume this slice's parent/child read-model;
  the aggregate listing is designed to be the dashboard's feed.
