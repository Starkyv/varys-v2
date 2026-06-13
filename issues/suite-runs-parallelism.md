# Issues — Varys v2 Slice 6: Suite runs + parallelism

> Tracer-bullet issues for the suite-runs slice (`prd/suite-runs-parallelism.md`).
> Three vertical slices; each is demoable on its own.
> *Not published to an issue tracker — none configured; the `ready-for-agent` label could not
> be applied. Build order = dependency order below.*
>
> **Testing posture (per user direction):** no UI/component tests anywhere; API E2Es only
> where a real server guarantee is worth pinning — exactly **one compact chromium-free E2E
> file** in the whole slice (Issue 1: fan-out shape incl. children-excluded-from-runs-list,
> aggregation derivation incl. suite-deletion survival, trigger guards). Issues 2 and 3 add
> **zero automated tests** (Issue 2's server guarantee is pinned by Issue 1's file; Issue 3
> is manual-verified per the PRD's agreed seams). Run E2Es per file.
>
> **Hard rules that bite here:** new NestJS controllers need explicit `@Inject(Service)`
> (esbuild emits no decorator metadata — green tests don't prove the dev server boots). DDL
> is additive (`IF NOT EXISTS`); **restart `pnpm dev` after schema changes**. No aggregate
> state is stored — suite-run status/counts are **derived on read** from children. The
> worker stays suite-agnostic: same `run` queue, same `{runId}` job shape, runner untouched.
> Ports: API :4000, web :5200, Postgres :5433.
>
> **Dependency shape:** `{1, 3}` can start immediately; `1 → 2`.
>
> **Status: 🟡 Issues 1–2 implemented — `suite-runs.e2e` 3/3 (fan-out shape incl.
> children-excluded-from-runs-list, derive-on-read aggregation incl. suite-deletion
> survival, trigger guards); typecheck green; web build + existing tests green;
> regression check `runs.e2e` 10/10, `suites.e2e` 2/2. UI (Run panel on Suites tab,
> `?suiteRun=` report, interleaved Runs tab) is the manual click-through gate —
> restart `pnpm dev` once for the `suite_runs` DDL. Issue 3 (worker parallelism)
> remains.**
>
> | Issue | Status |
> |---|---|
> | 1 — Suite run: trigger + fan-out + aggregate report (full stack) | 🟢 Implemented — `suite-runs.e2e` 3/3; typecheck + web build green; UI manual click-through pending |
> | 2 — Runs history integration | 🟢 Implemented — server half pinned by Issue 1's E2E; Runs tab interleaves aggregate rows; UI manual click-through pending |
> | 3 — Worker parallelism | 🔴 Not started |

---

# Issue 1 — Suite run: trigger + fan-out + aggregate report (full stack)

**Type:** AFK · **Blocked by:** none · **Status: 🟢 Implemented — `suite-runs.e2e` 3/3; typecheck 27/27; web build + existing tests green; regression `runs.e2e` 10/10 + `suites.e2e` 2/2; UI manual click-through pending.**

## Parent

`prd/suite-runs-parallelism.md` (Slice 6 of the roadmap in `DESIGN.md` §14).

## What to build

Make suites runnable. Triggering a suite against zero-or-more environments creates a
**suite_runs** parent (suite FK `ON DELETE SET NULL` + denormalized suite-name snapshot, so
reports survive suite deletion/rename) and fans out one **ordinary child run per
(member test × selected environment)** — each pinned to its test's latest version at trigger
time, enqueued through the existing single-run creation path onto the existing queue
(`runs` gains a nullable `suite_run_id`; no environments selected = one `"default"` child
per test, mirroring the optional-env single run). Membership is snapshotted at trigger;
later suite edits don't touch in-flight runs. Guards: unknown suite/environment → not found;
empty suite → bad request.

**No aggregate state is stored** — a suite run's status and counts derive on read from its
children: all-queued → `queued`; any queued/running → `running`; else `failed` >
`needs_review` > `passed`. New contract types: `SuiteRunSummary` (id, suite name, trigger
time, environment names, derived status, counts) and `SuiteRunView` (summary + child rows:
run id, test name, environment, status, error — stable test×env order).

UI: the Suites tab gains the Run affordance slice 5 withheld — per-suite environment
multi-pick (selection remembered in localStorage, like the Tests tab's last-used env) and a
Run button (disabled for empty suites) that triggers and navigates to a new **suite-run
report** deep link (`?suiteRun=<id>`, same routing pattern as `?run=`): header with suite
name / when / aggregate status / counts, per-child rows with status + error preview, each
linking into the existing run view / diff viewer via `?run=<id>`, polling while any child is
non-terminal. Needs Review is untouched — children's checkpoints flow in automatically.

## Acceptance criteria

- [x] Triggering a suite with M tests × N selected environments creates one parent + M×N ordinary child runs (right version pin, right environment each); zero envs → one `"default"` child per test; trigger returns the suite-run id.
- [x] Membership is snapshotted at trigger time; empty suite → bad request; unknown suite/env → not found (validated up front — no half-created fan-out).
- [x] Suite-run listing (newest first) and report derive status/counts on read per the precedence rules; the report survives suite deletion (name snapshot, FK SET NULL).
- [x] Children's diffs/seeds appear in Needs Review exactly like standalone runs' (needs-review queries checkpoints; untouched — verified by reading, no change needed).
- [x] Suites tab: env multi-pick (remembered, stale ids dropped) + Run (disabled when empty) → navigates to `?suiteRun=<id>` report; report shows aggregate header + child rows linking to `?run=<id>`; polls while any child is in flight. *(Manual click-through pending — no UI tests.)*
- [x] One compact chromium-free API E2E file (`suite-runs.e2e.spec.ts`, 3/3) pinning exactly: fan-out shape (incl. children excluded from the flat runs listing — Issue 2's server half), aggregation derivation (children completed via the DB, no chromium; suite-deletion survival), and trigger guards. No other automated tests.
- [x] New controller uses explicit `@Inject(Service)` (trigger route lives on the suites controller; read side on `suite-runs`); DDL additive (`suite_runs` + `runs.suite_run_id`); **restart `pnpm dev`** to apply.

## Blocked by

None — can start immediately.

---

# Issue 2 — Runs history integration: one aggregate row per suite run

**Type:** AFK · **Blocked by:** Issue 1 · **Status: 🟢 Implemented — typecheck + web build + existing tests green; UI manual click-through pending.**

## Parent

`prd/suite-runs-parallelism.md` (Slice 6 of the roadmap in `DESIGN.md` §14).

## What to build

Keep the Runs history scannable when suites fan out. The flat runs listing **excludes
suite-run children server-side** (standalone runs only); the Runs tab interleaves suite-run
aggregate rows (suite name, derived status, counts, "M tests × N envs", trigger time —
linking to the `?suiteRun=<id>` report) with standalone single-run rows by recency. Children
are reachable only through the report. Needs Review stays checkpoint-driven and untouched.

## Acceptance criteria

- [x] The flat runs listing returns standalone runs only — suite-run children are excluded server-side *(server guarantee pinned by Issue 1's E2E file — no new tests)*.
- [x] Runs tab interleaves suite-run aggregate rows with standalone runs by recency; aggregate rows (status badge, suite name + "suite" chip, counts, env names, time) link to the suite-run report; children appear only inside the report. *(Manual click-through pending — no UI tests.)*
- [x] A suite run's aggregate row reflects live derived status while children execute (both lists poll at 3s).

## Blocked by

- Issue 1 — Suite run: trigger + fan-out + aggregate report *(needs the parent entity, aggregate listing, and report deep link).*

---

# Issue 3 — Worker parallelism: concurrent runs, sequential steps

**Type:** AFK · **Blocked by:** none *(parallel with Issues 1–2)* · **Status: 🔴 Not started**

## Parent

`prd/suite-runs-parallelism.md` (Slice 6 of the roadmap in `DESIGN.md` §14).

## What to build

Make the pool actually parallel. The queue package's run subscription gains a concurrency
option (jobs fetched in batches, processed concurrently; one failing job must not sink the
batch); the worker reads it from `VARYS_WORKER_CONCURRENCY` (default 2). Each run keeps its
own fresh browser via the existing per-run launch; **steps within a test stay strictly
sequential** — parallelism is only across runs. The worker remains suite-agnostic, so this
speeds up standalone runs and suite fan-outs alike, and horizontal scale (more worker
processes on the same queue) keeps working unchanged.

## Acceptance criteria

- [ ] The run subscription processes up to N jobs concurrently, N from `VARYS_WORKER_CONCURRENCY` (default 2); one job's failure doesn't sink the others in its batch.
- [ ] Each concurrent run uses its own fresh browser/context; steps within a run remain sequential; runner code untouched.
- [ ] Manual verification: trigger a multi-test suite (or several single runs) and observe multiple runs `running` simultaneously, finishing in roughly slowest-test wall-clock. *(Per direction — no automated parallelism tests.)*

## Blocked by

None — can start immediately.
