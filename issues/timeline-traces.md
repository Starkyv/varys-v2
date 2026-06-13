# Issues — Varys v2 Slice 9: Timeline + traces

> Tracer-bullet issues for the timeline-traces slice (`prd/timeline-traces.md`).
> Two vertical slices; each is demoable on its own.
> *Not published to an issue tracker — none configured; the `ready-for-agent` label could not
> be applied. Build order = order below.*
>
> **Testing posture (per user direction):** no UI/component tests anywhere; API E2Es only
> where a real server guarantee is worth pinning — exactly **one E2E file** in the whole
> slice (`traces.e2e`, **chromium required** — the subject *is* replay behavior; prior art
> `runs.e2e.spec.ts`). Issue 1 creates it (trace toggle guarantees); Issue 2 folds its
> step-timeline assertions into the same file (the folders/tags precedent). Run E2Es
> per file.
>
> **Hard rules that bite here:** retention is **per-trigger on demand only** — no automatic
> keep on failure/seed (deliberate deviation from DESIGN §9, decided in the PRD; update the
> DESIGN slice-9 row when this ships). Tracing must not start unless requested (untraced runs
> pay zero overhead); a traced run keeps its zip on **every** outcome incl. the failure path,
> where stop/upload is best-effort and must never mask the replay error. Step rows are run
> *output* — relational, never in the versioned definition. New/changed controllers need
> explicit `@Inject(Service)`. DDL is additive (`IF NOT EXISTS`); **restart `pnpm dev` after
> schema changes**. Worker/runner stay suite-agnostic. Ports: API :4000, web :5200, PG :5433.
>
> **Dependency shape:** 1 → 2 *(2 is independent in principle, but edits the same runner
> step-loop and E2E file — build second).*
>
> **Status: 🟢 Both issues implemented — `traces.e2e` 3/3 (trace toggle/capture/CORS +
> folded step-timeline assertions); typecheck 27/27; web build + 18 web unit green;
> regression runs.e2e 10/10, suite-runs.e2e 3/3. The trace toggle (Tests + Suites),
> "Open timeline" link, and per-step durations on the failed-run view are the manual
> click-through gate — restart `pnpm dev` once for the runs.trace / trace_artifact_key
> / run_steps DDL.**
>
> | Issue | Status |
> |---|---|
> | 1 — On-demand trace: toggle → capture → "Open timeline" (full stack) | 🟢 Implemented — `traces.e2e` 3/3; typecheck + web build green; UI manual click-through pending |
> | 2 — Step timeline foundation (every run) | 🟢 Implemented — folded into `traces.e2e` 3/3; typecheck + web build green; UI manual click-through pending |

---

# Issue 1 — On-demand trace: toggle → capture → "Open timeline" (full stack)

**Type:** AFK · **Blocked by:** none · **Status: 🟢 Implemented — `traces.e2e` 3/3; typecheck 27/27; web build + 18 web unit + suite-runs.e2e 3/3 green; UI manual click-through pending.**

## Parent

`prd/timeline-traces.md` (Slice 9 of the roadmap in `DESIGN.md` §14).

## What to build

Make runs traceable on demand. Both trigger actions gain an optional **trace flag** — the
single-run trigger and the suite-run trigger (the flag fans out to every child run) —
persisted on the run row at creation (default off; queue job shape unchanged, worker stays
suite-agnostic). When the flag is set, the runner wraps the replay in Playwright tracing
(screenshots + DOM snapshots), started right after context creation and stopped before
context close **including on the failure path** (best-effort there — never mask the replay
error); the zip uploads through the existing `StorageAdapter` under the run's artifact
prefix and the run row records the trace artifact key. A traced run keeps its trace on
*every* outcome; an unflagged run never starts tracing at all.

The run read-model gains a nullable **trace URL**. The run view (DiffViewer) header shows
**"Open timeline"** when present — linking to Playwright's hosted Trace Viewer with the
absolute trace-artifact URL (the user's browser fetches the trace; content never transits a
third party). The artifacts route gains permissive **CORS on GET** (token-addressed
artifacts are already link-access — no new exposure). UI triggers: a remembered "keep trace"
checkbox on the Tests tab Run action and the Suites tab Run panel (localStorage, same
pattern as the remembered env selection).

## Acceptance criteria

- [x] Single-run and suite-run triggers accept the trace flag; suite children all inherit it; the flag persists on the run row; default off. *(`RunsService.create` takes an options object now; suite trigger threads `trace` to every child.)*
- [x] Flagged runs store a trace zip (every outcome, incl. failed); unflagged runs never start tracing and have a null trace URL. *(Runner starts tracing only when flagged; stop+upload+persist in `finally`, best-effort, never masks the replay error.)*
- [x] Run view exposes `traceUrl`; "Open timeline" renders only when non-null and opens the trace viewer with the absolute artifact URL; artifacts route sends CORS headers on GET (`Access-Control-Allow-Origin: *`). **Viewer is self-hosted** at `/trace-viewer` (API serves the `playwright-core` bundle, proxied in dev) — same-origin as the artifact, since the hosted `trace.playwright.dev` can't fetch a localhost artifact (browser public→local block). *(Manual click-through for the viewer roundtrip pending — no UI tests.)*
- [x] "Keep trace" checkbox on both trigger surfaces, remembered in localStorage (shared `varys:keepTrace` key). *(Manual click-through pending — no UI tests.)*
- [x] One new E2E file (`traces.e2e`, chromium, run per-file, 3/3) pinning exactly: traced run → terminal with non-empty (PK-magic) zip artifact + CORS header; untraced run → null traceUrl; traced *failed* run still keeps its trace. No other automated tests.
- [x] DDL additive (`runs.trace` + `runs.trace_artifact_key`); **restart `pnpm dev`** to apply; CORS `@Header` on the artifacts controller (no new controllers needed — trigger routes reuse the existing run/suite controllers with explicit `@Inject`).

## Blocked by

None — can start immediately.

---

# Issue 2 — Step timeline foundation: per-step rows for every run

**Type:** AFK · **Blocked by:** Issue 1 *(same runner step-loop + same E2E file)* · **Status: 🟢 Implemented — folded into `traces.e2e` 3/3; typecheck 27/27; web build + 18 web unit + runs.e2e 10/10 + suite-runs.e2e 3/3 green; UI manual click-through pending.**

## Parent

`prd/timeline-traces.md` (Slice 9 of the roadmap in `DESIGN.md` §14).

## What to build

Record the data skeleton the future custom timeline UI will render — for **every** run,
traced or not. A new **run_steps relation**: one row per *executed* step — run reference,
step index, label (the existing `describeStep` vocabulary), checkpoint name when the step is
a screenshot step (the join point to `run_results`), started-at, duration, outcome
(`passed` / `failed`). The runner inserts rows as steps complete; the failing step's row is
marked `failed` with its duration-to-failure; steps never reached have no row ("didn't run"
stays derivable from the definition, exactly as the failed-run view derives it today).
`runs.failedStepIndex` and the error-message format are untouched — rows are additive.

The run read-model exposes the step timeline for all runs alongside checkpoints (the
existing failed-run `steps` labels stay for back-compat until the custom-timeline slice
rationalizes the two). Thin visible payoff so the slice is demoable: the failed-run step
sequence in the viewer shows per-step durations for the steps that ran.

## Acceptance criteria

- [x] Every run (traced and untraced) records one run_steps row per executed step with index, label, checkpoint name (screenshot steps), started-at, duration, outcome; failing step marked `failed`; unreached steps absent. *(Runner accumulates rows in the loop + the failing step in catch, persists once in finally, best-effort.)*
- [x] Run read-model exposes the step timeline (`RunView.timeline: StepRun[]`) for all runs; existing failed-run `steps`/`failedStepIndex` behavior unchanged.
- [x] Failed-run step sequence in the viewer shows durations for executed steps. *(Manual click-through pending — no UI tests.)*
- [x] Step-timeline assertions folded into Issue 1's `traces.e2e` file (timing present and monotonic; failing step marked at index 0; recorded even for untraced runs; checkpoint step joins to its name). No new test files.
- [x] DDL additive (`run_steps`); **restart `pnpm dev`** to apply; step rows are run output — relational, never in the versioned definition.

## Blocked by

- Issue 1 — On-demand trace *(edits the same runner step-loop and E2E file; build second to avoid conflicts).*
