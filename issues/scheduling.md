# Issues — Varys v2 Slice 8: Scheduling (PRD 1)

> Tracer-bullet issues for the scheduling slice (`prd/scheduling.md`).
> Two vertical slices; each is demoable on its own.
>
> *Not published to an issue tracker — none configured; the `ready-for-agent` label could
> not be applied. This file is the source of record, consistent with prior slices.*
>
> **Scope (product-owner direction):** scheduling is **per-test**, not `suite × env(s)`.
> A test carries an optional **cron** (+ timezone + enable toggle + one optional environment
> + keep-trace); when the cron fires, that test runs as an ordinary single run. This is a
> deliberate simplification of DESIGN §6's `(suite) × (env(s)) × (when)` — confirmed, not an
> oversight. There is **no separate Schedules UI**: the cron lives in the existing test-detail
> config surface; on/off is the enable toggle (or clearing the cron).
>
> **Notifications** (Slack + in-app alerts, DESIGN §10) are a **sibling PRD** (Slice 8, PRD 2),
> not here — scheduled results already land in Runs history / Needs Review / the dashboard.
>
> **This slice's only DDL:** a 1:1 `test_schedules` table (Issue 1). The cron is *operational
> "when-to-run" metadata*, like `tests.folder_id`/`status`/`origin` — relational, **never in the
> versioned `definition` jsonb**, and editing it creates **no new `test_version`** (the
> rename/file precedent), unlike the versioned `PUT /tests/:id/config` (waits + threshold).
>
> **Riskiest assumptions, pinned by E2E:** setting/clearing a schedule writes no new version
> (Issue 1); the firing tick is single-fire under concurrent/duplicate ticks (Issue 2). The
> firing reuses the existing single-run path verbatim — the worker never learns schedules exist.
>
> **Mechanism:** `cron-parser` (already resolved via pg-boss) computes `next_run_at`; pg-boss's
> own scheduler (currently `schedule: false`) is enabled on the **API** boss for **one** internal
> minute heartbeat — leader-elected, single-fire-across-instances, restart-durable. A
> `test_schedules` row is the single source of truth; the heartbeat just sweeps the due set.

| Issue | Type | Status |
|---|---|---|
| 1 — Per-test cron schedule config (full stack, not yet firing) | AFK | 🔴 Not started |
| 2 — Durable firing: the cron tick runs scheduled tests | AFK | 🔴 Not started |

---

# Issue 1 — Per-test cron schedule config (full stack, not yet firing)

**Type:** AFK · **Blocked by:** none · **Status: 🔴 Not started**

## Parent

`prd/scheduling.md` — Varys v2 Slice 8, PRD 1.

## What to build

Give a test an optional **schedule** and let a human configure it end-to-end — without yet
firing anything. The schedule is `{ cron, timezone, enabled, environmentId?, keepTrace }`,
presented as part of the test and stored relationally in a **1:1 `test_schedules` row**
(keyed by test). It is set through the **structural** test update (the same relational path
that renames/files a test), so saving a schedule **creates no new `test_version`** — the cron
is not part of the record→replay→diff contract.

The cron is **validated server-side** with `cron-parser`: an invalid expression is rejected,
a valid one persists and the read-model returns a computed **`nextRunAt`** (honoring the
timezone). An unknown `environmentId` is rejected up front (the suite-run trigger's precedent);
environment is **optional** — empty means the default baseline. Clearing the schedule, or
flipping `enabled` off, turns scheduling off while (for disable) keeping the cron.

The **existing test-detail config surface** gains the schedule controls — a cron field (raw
expression + a few presets like hourly/daily/weekly + a plain-language summary), a timezone, an
enable toggle, an optional environment picker, and a keep-trace toggle — and the **Tests list**
shows a small "scheduled · next run" indicator. No separate Schedules view.

Patch shape (encodes the clear-vs-set decision): the structural test update accepts
`{ schedule: { cron, timezone?, enabled?, environmentId?, keepTrace? } | null }`, where `null`
clears the schedule.

## Acceptance criteria

- [ ] A test can be given a schedule (`cron` + `timezone` + `enabled` + optional `environmentId` + `keepTrace`) and have it cleared, via the structural test update — and doing so **creates no new `test_version`** (version unchanged, `definition` jsonb untouched). Pinned by API E2E.
- [ ] An invalid cron expression is rejected (`400`) at save time; a valid one persists and the read-model returns a computed `nextRunAt` that honors the schedule's timezone.
- [ ] A schedule referencing an unknown `environmentId` is rejected (`404`); environment is optional (omitted ⇒ the run later seeds/uses the `"default"` baseline).
- [ ] The test read-model / `GET /tests/:id/config` returns the schedule + `nextRunAt`, and the tests list carries enough to show a "scheduled / next run" indicator.
- [ ] The test-detail config surface edits the schedule (cron with live validation + presets + plain-language summary, timezone, enable toggle, optional environment, keep-trace); the Tests list shows the scheduled indicator. *(Manual click-through — no UI/component tests, standing direction.)*
- [ ] DDL additive (`CREATE TABLE IF NOT EXISTS test_schedules`, `test_id → tests ON DELETE CASCADE`, `environment_id → environments ON DELETE SET NULL`); **restart `pnpm dev`** to apply. Schedule fields are relational metadata, never in `definition` jsonb.
- [ ] Schedule types (`TestSchedule` + `nextRunAt`) added to `@varys/review-contract`; the controller route uses explicit `@Inject`. The schedule rides the existing `/tests` prefix — **no new top-level route**, so no Vite-proxy allowlist change (the CLAUDE.md gotcha applies only to new prefixes).

## Blocked by

None — can start immediately.

---

# Issue 2 — Durable firing: the cron tick runs scheduled tests

**Type:** AFK · **Blocked by:** Issue 1 · **Status: 🔴 Not started**

## Parent

`prd/scheduling.md` — Varys v2 Slice 8, PRD 1.

## What to build

Make schedules actually fire — durably. Enable pg-boss scheduling/supervision on the **API's**
boss (today it is created with `schedule: false`) and register **one** internal `scheduler-tick`
recurring job at `* * * * *`. pg-boss provides the hard parts: leader-elected, single-fire
across instances, restart-durable. The worker's boss stays unchanged and still consumes only the
run queue — **the worker never learns schedules exist.**

Each tick: select `enabled` schedules whose `next_run_at <= now()`; for each, **atomically claim**
it with a conditional update that advances `next_run_at` to the next cron occurrence
(`UPDATE test_schedules SET last_run_at = now(), next_run_at = :computedNext WHERE test_id = :id AND enabled AND next_run_at <= now()` — proceed only if one row changed), so overlapping ticks
or multiple API instances cannot double-fire. A claimed schedule fires the **existing single-run
path** (`RunsService.create(testId, { environmentId, trace })`) using the schedule's environment
+ keep-trace, attributing the run to the schedule's owner (`created_by`). The resulting run id is
written back as `last_run_id`.

A fire **missed during downtime coalesces to one** catch-up run: a long-past `next_run_at` fires
once and advances to the next *future* occurrence, never once per missed slot. A schedule that
errors at fire time (e.g. its env was deleted) **degrades gracefully** (env dropped → default)
and **never stops the tick** from firing the other due schedules. A scheduled run is an ordinary
single run — it appears in Runs history, Needs Review, and the dashboard identically to a manual
run; no new result model.

## Acceptance criteria

- [ ] pg-boss scheduling is enabled on the API boss with a single `scheduler-tick` recurring job; the worker's boss is unchanged (still only consumes the run queue).
- [ ] Forcing a schedule due (set `next_run_at` into the past) and invoking the tick creates **exactly one** ordinary run for that test — with the schedule's environment + keep-trace, attributed to the schedule's creator (`created_by`) — then sets `last_run_at`/`last_run_id` and advances `next_run_at` to a future occurrence. *(Chromium-free API E2E that drives the tick directly.)*
- [ ] Invoking the tick **twice** for one due schedule creates exactly one run (atomic claim — no double-fire).
- [ ] A **disabled** schedule, and a test with **no** schedule, never fire.
- [ ] A **missed** fire (long-past `next_run_at`) fires once then advances to the next future slot (no per-slot stampede); a fire whose env was since deleted runs against `"default"` and does not crash the tick for other due schedules.
- [ ] The scheduled run is indistinguishable from a manual single run downstream (Runs history / Needs Review / dashboard) — it reuses `RunsService.create`, adds no parallel result path.
- [ ] pg-boss heartbeat wiring + real-wall-clock cron are **manual-verified** (a once-a-minute schedule produces a run); automated tests invoke the tick function directly — no flaky real-time waits. No UI/component tests.

## Blocked by

- Issue 1 — the firing tick reads the `test_schedules` rows + `next_run_at` it persists.
