# PRD — Scheduling (Slice 8, PRD 1)

> Slice 8 of the roadmap in `DESIGN.md` §14: the **scheduling** half of "Scheduling +
> notifications" — **cron triggers** (§6 Playback infrastructure: "manual + scheduled (cron)").
> Depends on slice 1 (single-test runs, ✅) and slice 4 (environments, ✅).
>
> **Scope (product-owner direction):** scheduling is **per-test**, deliberately simpler than
> DESIGN §6's `(suite) × (env(s)) × (when)`. A test carries an optional **cron**; when it fires,
> that test runs as an ordinary single run. One optional environment per schedule (empty =
> default baseline); on/off is an enable toggle. **No separate Schedules UI** — the cron lives in
> the existing test-detail config surface. Suite-level / multi-env scheduling is not in this PRD.
>
> **Notifications** (Slack + in-app inbox on diffs/failures, §10) are a **sibling PRD** (Slice 8,
> PRD 2): scheduled results already land in the dashboard matrix, Runs history, and Needs Review
> (slices 6–7), so cron firing and alert *delivery* are independent. This PRD ships the firing;
> the notifications PRD fills the dashboard's reserved Alerts slot.
> *Not published to an issue tracker — none configured; the `ready-for-agent` label could not be
> applied. This file is the artifact.*

## Problem Statement

I can run a test (or a suite) on demand, but only when a human is there to click Run.
Regression coverage that matters most — the nightly run of a critical flow, the hourly smoke
against staging — still depends on someone remembering to trigger it at the right time. There's
no way to say "run this test every night at 2am" and walk away. The single-run path and its
results (history, Needs Review, dashboard) already exist; what's missing is the **when**. Without
it, the most valuable runs are the ones most likely to be forgotten, and "is this flow still
green overnight?" is a question no one is positioned to answer each morning.

## Solution

A test becomes schedulable. In the existing test-detail config surface I give a test a cron
cadence (with a timezone), optionally pin one environment, optionally keep a trace, and toggle it
on. Varys then fires it automatically. **Each fire is an ordinary single run**: it reuses the
exact single-run path, so scheduled results appear in Runs history, the dashboard, and Needs
Review identically to a manual run — no parallel result path, no new view. The Tests list shows a
"scheduled · next run" indicator; the config surface shows the next and last run (linking to the
last fire). Firing is **durable and single-shot**: it survives API restarts, never double-fires
across instances, and coalesces fires missed during downtime into one catch-up run rather than a
stampede.

## User Stories

1. As a QA engineer, I want to give a test a cron cadence (e.g. nightly), so that it runs automatically without anyone remembering to click Run.
2. As a QA engineer, I want each scheduled fire to produce an ordinary run, so that scheduled results show up in Runs history, the dashboard, and Needs Review exactly like a manual run.
3. As a QA engineer, I want to enable/disable a test's schedule without losing the cron, so that I can pause a noisy schedule during a known-broken window and resume later.
4. As a QA engineer, I want to edit the cron, timezone, environment, and trace toggle, so that I can adjust cadence without recreating anything.
5. As a QA engineer, I want to see the test's next run time and last run (with its outcome), so that I can tell at a glance whether automation is healthy and when it fires next.
6. As a QA engineer, I want to optionally pin one environment to the schedule, so that "run nightly against staging" works — and leaving it empty just runs against the default baseline.
7. As a developer, I want schedules to survive an API restart and never double-fire across multiple API instances, so that scheduled automation is reliable in production, not best-effort.
8. As a developer, I want a fire missed because the API was down to fire once on recovery, not once per missed slot, so that downtime doesn't cause a stampede of catch-up runs.
9. As a QA engineer, I want an invalid cron rejected with a clear error when I save, so that I never persist a schedule that silently never fires.
10. As a QA engineer, I want schedules expressed in a chosen timezone, so that "2am daily" means 2am local — DST included — not UTC.
11. As a QA engineer, I want a scheduled run attributed to whoever set the schedule, so that audit history shows who is responsible for an unattended run.
12. As a QA engineer, I want deleting a test to remove its schedule, so that nothing is left firing against a test that no longer exists.
13. As a QA engineer, I want to optionally keep a trace on scheduled runs, so that a failed nightly run is debuggable in the timeline without re-running it.
14. As a QA engineer, I want a schedule whose pinned environment was since deleted to degrade gracefully (run against default) rather than break the cadence, so that one misconfiguration doesn't silently stop automation.

## Implementation Decisions

**Domain model — a schedule is operational metadata on the test.**

- A test's schedule is `{ cron, timezone, enabled, environmentId?, keepTrace }`, stored in a
  **1:1 `test_schedules` table** (`test_id` PK/unique, FK `ON DELETE CASCADE` — the schedule
  dies with its test), plus `environment_id` (FK `ON DELETE SET NULL`), `next_run_at` (the
  due-check key, computed from the cron), `last_run_at`, `last_run_id` (FK `ON DELETE SET NULL`),
  and `created_by` (the actor — §11 audit). Additive DDL (`IF NOT EXISTS`), applied on boot.
- The cron is **"when-to-run" metadata, not part of the record→replay→diff `definition`** (§3).
  So it lives relationally — exactly like `tests.folder_id`/`status`/`origin`/`intent` — and is
  set through the **structural** test update (the rename/file path), which **creates no new
  `test_version`**. This is the deliberate contrast with `PUT /tests/:id/config` (waits +
  threshold), which *is* definition and *does* version.

**Firing mechanism — durable minute-tick + atomic claim, reusing the single-run path.**

- pg-boss is created today with `schedule: false, supervise: false`. This slice **enables pg-boss
  scheduling on the API's boss** and registers **one** internal recurring job — a
  `scheduler-tick` at `* * * * *`. pg-boss gives the hard parts for free: leader-elected,
  single-fire-across-instances, restart-durable cron. The worker's boss stays unchanged and still
  consumes only the run queue — **the worker never learns schedules exist.**
- The tick runs in the API process (where the run-trigger service lives). Each tick selects
  `enabled` schedules with `next_run_at <= now()`; for each, **atomically claims** it with a
  conditional update —
  `UPDATE test_schedules SET last_run_at = now(), next_run_at = :computedNext WHERE test_id = :id AND enabled AND next_run_at <= now()`
  — and fires only if one row changed. That conditional update is the concurrency guard:
  overlapping ticks or multiple instances can't double-fire, no explicit locking needed.
- **Firing reuses the single-run path verbatim**: `RunsService.create(testId, { environmentId, trace })`
  with the schedule's environment + keep-trace, threading `created_by` as the run actor. The run
  id is stored back as `last_run_id`. No scheduled-run table, no parallel result model — a
  scheduled fire is indistinguishable from a manual single run downstream.
- **`next_run_at` is computed with `cron-parser`** (already resolved via pg-boss) at save and
  after each fire, honoring `timezone` (DST-correct). Resolution is one minute — the tick cadence.
- **Missed-fire coalescing:** if the API was down across fire times, on recovery `next_run_at`
  is in the past, so the tick fires **once** and advances to the next *future* occurrence — never
  once per missed slot.
- **Graceful per-fire failure:** a since-deleted pinned env drops to the default baseline; an
  error firing one schedule never stops the tick from firing the others.

**Actor & audit (§11).** Scheduled runs are attributed to the schedule's `created_by`, threaded
through `RunsService.create` into the existing nullable `runs.created_by`, so an unattended run
still answers "who is responsible".

**API contract (shared `@varys/review-contract` types).**

- The schedule rides the **structural test update**: `{ schedule: { cron, timezone?, enabled?, environmentId?, keepTrace? } | null }` (`null` clears it; no new `test_version`). Save-time
  validation: bad cron → `400`, unknown `environmentId` → `404`.
- `TestSchedule` type (cron, timezone, enabled, environment name, keepTrace, `nextRunAt`,
  `lastRunAt`, `lastRunId`) added to the contract; surfaced on the test read-model /
  `GET /tests/:id/config`, and the tests list carries enough to render a "scheduled · next run"
  indicator. The API never returns secret values.

**Web UI (no new view — the existing test-detail config surface).**

- The test-detail config surface gains the schedule controls: a cron field (raw expression + a
  few presets — hourly / daily / weekly — with live validation and a plain-language summary), a
  timezone, an enable **Switch**, an optional environment picker (reusing the existing env list;
  empty = default), and a keep-trace **Switch**. It shows the next run time and a last-run chip
  linking to that run (`?run=<id>`).
- The **Tests list** shows a compact "scheduled · next run" indicator on scheduled tests. There
  is no separate Schedules tab.

**Hard rules carried forward.** Controller routes use explicit `@Inject(Service)` (esbuild emits
no decorator metadata); routes are protected by the global auth guard (slice 10), actor from
`@CurrentUser`. DDL additive, applied on boot — **restart `pnpm dev` after the schema change**.
The schedule rides the existing `/tests` prefix — **no new top-level route**, so no Vite-proxy
allowlist change (the CLAUDE.md gotcha applies only to new prefixes). Schedule config stays
relational, never in `definition` jsonb. Ports: API :4000, web :5174, PG :5433.

## Testing Decisions

- A good test pins **externally observable server behavior through the highest existing seam** —
  the HTTP API against a real Postgres — and never inspects implementation details (no asserting
  on pg-boss internals, no poking service privates).
- **Chromium-free API E2Es** (supertest + full app module on Testcontainers Postgres; prior art:
  `tests.e2e.spec.ts`, `folders.e2e.spec.ts`), run per-file, pinning:
  - **Config + no-version:** set/clear a schedule via the structural update creates **no new
    `test_version`** (version unchanged, `definition` untouched); bad cron → `400`, unknown env →
    `404`; the read-model returns the schedule + a computed `nextRunAt` honoring the timezone.
  - **Firing:** force a schedule due (`next_run_at` into the past), **invoke the tick directly**,
    and assert exactly one run appeared for the right test + environment, attributed to the
    creator, with `last_run_at`/`last_run_id` set and `next_run_at` advanced to a future slot.
  - **Atomic claim (no double-fire):** invoke the tick twice for one due schedule → exactly one
    run.
  - **Disabled + graceful:** a disabled / unscheduled test never fires; a since-deleted env drops
    to default; one failing schedule doesn't stop the tick firing the others.
- Tests **drive the tick directly** (a plain async method) rather than waiting real wall-clock
  minutes — the pg-boss `* * * * *` heartbeat + leader election are **manual-verified** (a
  once-a-minute schedule produces a run), per the standing "no flaky real-time timer tests"
  posture.
- **No UI/component tests** (standing direction); the test-detail schedule controls and the Tests
  list indicator are the manual click-through gate.

## Out of Scope

- **Notifications** — Slack + in-app inbox on diffs/failures (§10): the **sibling PRD** (Slice 8,
  PRD 2). Scheduled results are already visible via the dashboard / Runs history / Needs Review.
- **Suite-level scheduling and multi-environment fan-out per fire** — this PRD schedules a single
  test against at most one environment. (Suite × env(s) scheduling remains a possible later PRD;
  the suite-run trigger it would reuse already exists from slice 6.)
- **CI/webhook triggers** — slice 12 (same single-run rail, a different doorway).
- **Per-schedule overlap suppression** ("skip if the previous run is still going") and
  **auto-catch-up of every missed slot** — fire-anyway and coalesce-to-one are the chosen defaults.
- **Error retries** (retry-errors-once, never-retry-diffs — §6) — unchanged from today.
- **A rich visual cron builder** — a raw cron field with validation + a few presets, not a
  graphical scheduler.

## Further Notes

- This realizes DESIGN §6's "scheduled (cron)" trigger at the **test** grain, per product-owner
  direction — a conscious simplification of "`(suite) × (env(s)) × (when)`" to keep the surface
  small (one cron field in a screen that already exists, no new entity-management UI).
- The firing mechanism uses pg-boss only for the **single heartbeat** + the existing `run` queue,
  keeping the `test_schedules` row the **single source of truth**. The considered alternative —
  one pg-boss schedule per test — was rejected: it splits truth across the table and pg-boss's
  schedule store and couples every edit to a `schedule()`/`unschedule()` side-effect. We already
  need `cron-parser` for `next_run_at`, so owning the due-set query costs little and keeps the
  edit path plain SQL.
- A scheduled run's verdict mirrors live review state, exactly like a manual run — the last-run
  chip reflects a `needs_review` → approved flip on the next poll.
- The notifications PRD has a clean seam: it observes the same run terminal states this slice
  produces and routes them to Slack / the in-app inbox; nothing here presumes its design beyond
  leaving the dashboard Alerts placeholder in place.
