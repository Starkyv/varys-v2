# PRD — Timeline + traces (Slice 9)

> Slice 9 of the roadmap in `DESIGN.md` §14 (§9 Timeline UI, §7 artifacts). Depends only on
> slice 1 (MVP, ✅) — independent of the suite-runs slice and of the skipped worker-parallelism
> issue. **Deliberate deviation from DESIGN §9, per user decision:** trace retention is
> **per-trigger on demand only** ("keep trace" toggle at run time) — *not* the design's
> automatic retain-on-failure + retain-on-seed. Nothing is kept unless asked for.
> *Not published to an issue tracker — none configured; the `ready-for-agent` label could not
> be applied. This file is the artifact.*

## Problem Statement

When a replay does something surprising, I have almost nothing to look at. A failed run gives
me one error message and the index of the step that broke; a diff gives me three images. I
can't see what the page looked like *between* steps, what the network was doing, what the
console said, or how long each step took. And when my future custom timeline UI arrives
(checkpoints and action markers on a scrubbable time axis — the DESIGN §9 vision), there will
be no recorded data for it to render: today's runs persist no step timing and no trace of the
replay session at all.

## Solution

Runs become traceable on demand. When I trigger a run — a single test or a whole suite — I
can flip a **"keep trace"** toggle. A traced run records Playwright's full trace during
replay (per-step before/after screenshots, DOM snapshots, network, console — all timestamped)
and stores the zip as a run artifact; the run view then shows an **"Open timeline"** link
that opens the trace in Playwright's hosted Trace Viewer (the interim viewer — my own
timeline UI replaces the link later, consuming the same data).

Independently of the toggle, **every run now records a step timeline**: each executed step's
index, label, start time, duration, and outcome. This is the data skeleton the custom
timeline UI will render (checkpoint markers included, joined to the existing checkpoint
read-model) — and it immediately upgrades failed-run debugging from "which step" to "which
step, when, after how long".

## User Stories

1. As a QA engineer, I want a "keep trace" toggle when I trigger a run, so that I can capture full replay detail exactly when I expect to need it.
2. As a QA engineer, I want the same toggle on a suite-run trigger, so that one decision applies to every child the fan-out creates.
3. As a QA engineer, I want my toggle choice remembered between triggers, so that a debugging session doesn't require re-checking it every run.
4. As a developer, I want a traced run to store the full Playwright trace (screenshots, DOM snapshots, network, console, timestamps), so that I can replay-debug without re-running.
5. As a developer, I want an "Open timeline" link on a traced run's view, so that one click shows me the scrubbable session in Playwright's Trace Viewer.
6. As a developer, I want the trace link on a *failed* traced run especially, so that I can see the page state right before the failing step.
7. As a reviewer, I want a traced diff run's timeline available from the same run view I review in, so that I can check what led up to a visual change before approving it.
8. As a QA engineer, I want untraced runs to carry zero trace overhead and zero storage, so that the default fast path stays fast and lean.
9. As a developer, I want every run (traced or not) to record per-step timing and outcome, so that slowness and flakiness are visible per step, not just per run.
10. As a future-timeline builder, I want step rows (index, label, start, duration, outcome) exposed in the run read-model, so that my custom timeline UI renders from the API without parsing trace zips.
11. As a future-timeline builder, I want checkpoint steps identifiable in the step timeline, so that checkpoint markers can sit on the time axis joined to their images and review state.
12. As a QA engineer, I want the failed-run view's step sequence (ran / failed / never ran) to keep working exactly as today, so that the timeline foundation doesn't regress my debugging flow.
13. As a developer, I want the trace stored through the same storage adapter as every other artifact, so that the later cloud-storage slice covers traces with no extra work.
14. As a suite user, I want each traced child run to have its own trace and timeline link in the suite-run report's child views, so that fan-out debugging works per test × environment.
15. As a security-conscious user, I want the trace fetched by *my browser* into the hosted viewer (data not uploaded to a third-party server), so that internal app content stays local.
16. As an operator, I want traces excluded from no cleanup this slice (retention enforcement is slice 11), so that an on-demand trace stays until I deal with retention deliberately.
17. As a QA engineer, I want a clear absence (no link) on runs without a kept trace, so that I'm never chasing a timeline that was never recorded.

## Implementation Decisions

**Retention = the trigger's choice, nothing automatic (deviation from DESIGN §9, decided).**

- Both trigger actions gain an optional **trace flag**: the single-run trigger and the
  suite-run trigger (the flag fans out to every child). Default off.
- The flag is persisted on the run row at creation; the worker reads it from the run — the
  queue job shape is unchanged and the worker stays suite-agnostic.
- Tracing **starts only when the flag is set** (no capture-then-discard): untraced runs pay
  nothing. A traced run keeps its trace on *every* outcome — passed, needs_review, failed —
  because the user explicitly asked for it; there is no automatic keep on failure or seed.

**Capture (runner).**

- Tracing wraps the existing replay: started on the browser context right after creation
  (screenshots + DOM snapshots on), stopped before context close — *including on the failure
  path*, where the trace is most valuable; stop/upload failures there are best-effort and
  must never mask the original replay error.
- The trace zip is written to a temp file, uploaded through the existing `StorageAdapter`
  under the run's artifact prefix, and the run row records the trace artifact key. The
  storage seam means the later Azure/S3 adapters cover traces for free.

**Step timeline (every run, traced or not) — the custom-timeline foundation.**

- A new **run_steps relation**: one row per *executed* step — run id, step index, label
  (same `describeStep` vocabulary the failed-run view already uses), checkpoint name when the
  step is a screenshot step (the join point to `run_results`), started-at timestamp,
  duration, and outcome (`passed` / `failed`). Steps never reached have no row — the
  definition still supplies the full step list, so "didn't run" stays derivable exactly as
  the failed-run view derives it today.
- The runner inserts rows as steps complete (the failing step's row records `failed` with
  its duration-to-failure). `runs.failedStepIndex` and the existing error-message format are
  unchanged — the new rows are additive.
- The run read-model exposes the step timeline for **all** runs alongside checkpoints; the
  existing failed-run `steps` labels remain for back-compat until the custom timeline slice
  rationalizes the two.

**Read-model & viewer.**

- The run view gains a nullable **trace URL** (artifact route via `getUrl`; null = no trace
  kept — the UI shows nothing rather than a dead link).
- Interim viewer (decided): **"Open timeline" links to Playwright's hosted Trace Viewer**
  with the absolute trace-artifact URL as its query parameter. The hosted viewer is static
  client-side code: the user's own browser fetches the trace from Varys, so trace content
  never transits a third party. Requires (a) the artifacts route to send permissive CORS
  headers on GET — token-addressed artifacts are already link-access, so this adds no new
  exposure — and (b) the SPA to build an absolute URL from its origin. Requires internet;
  replaced wholesale by the custom timeline UI later (same stored data, no migration).
- The trace link renders in the run view (DiffViewer) header for any run with a trace —
  reachable from Runs, Needs review, and suite-run report child links alike.

**UI trigger surfaces.**

- Tests tab Run action and the Suites tab Run panel each gain a **"keep trace" checkbox**,
  remembered in localStorage (same pattern as the remembered environment selection).

**Schema.** Two additive changes (`IF NOT EXISTS` DDL, applied on boot — **restart
`pnpm dev`**): the runs table gains the trace-request flag and the trace artifact key; the
new run_steps table references runs. Per-step data is relational run *output* — never part
of the versioned definition.

**Hard rules carried forward:** explicit `@Inject(Service)` in any new/changed controllers;
worker/runner stay suite-agnostic; API never returns secret values (traces are capture of the
*page*, same exposure class as the screenshots already stored). Ports: API :4000, web :5200,
Postgres :5433.

## Testing Decisions

- A good test pins externally observable behavior at the highest existing seam and never
  asserts on internals (no poking trace-zip internals beyond "non-empty zip", no asserting
  runner privates).
- **One new compact E2E file at the runs-E2E seam** (full app + real worker + fixture server
  + chromium — prior art `runs.e2e.spec.ts`; chromium is unavoidable here because the
  subject *is* replay behavior). Run per-file. It pins:
  - A run triggered with the trace flag reaches a terminal state with a trace URL, and the
    artifact downloads as a non-empty zip with CORS allowed (the hosted-viewer contract).
  - A run triggered without the flag has a null trace URL (nothing stored).
  - A traced *failed* run still keeps its trace, and its step timeline records the executed
    steps with the failing step marked — timing present and monotonic.
  - The step timeline is recorded for untraced runs too (foundation is unconditional).
- **No UI tests** (standing direction): the toggle, the link, and the hosted viewer roundtrip
  are manual click-through.

## Out of Scope

- **The custom timeline UI itself** — a future slice; this slice lays its data (run_steps +
  trace zips) and keeps the interim hosted-viewer link cheap to replace.
- **Video capture** (per-test toggle, DESIGN §7) — separate concern, deferred.
- **Retention enforcement/cleanup** (tiered deletion — slice 11). On-demand traces persist
  until that slice.
- **Automatic retention policies** (retain-on-failure / retain-on-seed) — explicitly decided
  against in favor of the per-trigger toggle; revisit only if on-demand proves insufficient.
- **Server-side trace parsing** (extracting network/console into the API) — the custom
  timeline slice decides whether it needs this; the zip preserves everything meanwhile.
- **Self-hosting the Trace Viewer assets** — only worth it if offline/airgapped viewing
  becomes a requirement.

## Further Notes

- DESIGN §9's "trace retention: retain-on-failure + every baseline-seed" is superseded by
  this PRD's per-trigger toggle (user decision); update the design doc's slice-9 row when
  this ships.
- The step timeline deliberately gives the future custom timeline three layers to compose:
  step rows from the API (markers + durations), checkpoint images/review state already in the
  run view (the "checkpoints and stuff"), and the trace zip for deep detail (DOM snapshots,
  network, console). The custom UI can ship its first version from layers 1–2 without ever
  parsing a zip.
- A suite-run child is an ordinary run, so traced children get timeline links in the existing
  run view with zero suite-specific code.
- Hosted-viewer compatibility tracks the pinned Playwright version; if a viewer/trace format
  mismatch ever appears, pinning the viewer URL version or self-hosting are the escape
  hatches.
