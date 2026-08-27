# Slice 06 — The `healed` outcome, the re-run, and the digest

**Type:** AFK · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** 05

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

Now that no repair can land without passing the justification gate, an applied repair may
trigger a re-run — and that re-run may come back **amber**.

`healed` joins the derived run outcome. It is *not* derivable from checkpoints (it is a property
of the run: a repair was applied), so the derivation takes a new input. Precedence:

```
failed → regression → pending-baseline → healed → baseline → passed
```

Operationally `healed` is a **queue item, not an alarm** — the same weight class as
`pending-baseline`. It does not fail a suite and does not block a schedule, but it stays in the
review queue until a human accepts the version, and it fires a digest notification rather than a
page.

Surfacing is part of this slice, not a follow-up: run detail, runs list, test history, dashboard
matrix, and suite report all read `healed` from one derivation so they cannot drift.

The precedence rung matters more than it looks: if the visual checks *also* failed, `regression`
stays the headline. A re-pinned locator must never soften a real visual break.

## Acceptance criteria

- [x] An applied repair triggers a re-run of the test
- [x] A re-run where everything verified but a locator was re-pinned reads `healed`
- [x] A re-run with a pixel diff reads `regression`, **not** `healed`, even though a locator was re-pinned
- [x] A re-run that crashes reads `failed`, not `healed`
- [x] A suite containing a healed run still reports as passing, with a healed count
- [x] A schedule is not blocked by a healed run
- [x] `healed` renders distinctly from passed and failed on run detail, runs list, test history, dashboard matrix, and suite report
- [x] A digest notification fires for healed runs; no page
- [x] The count of healed versions awaiting review is visible
- [x] Pure unit tests cover every precedence pairing, including regression-outranks-healed

## Blocked by

- Slice 05 (nothing may go amber before the justification gate exists)

## Flags raised

- **`healed` is a property of the VERSION a run replayed, not a stamp on the run.** The new input
  to `deriveRunOutcome` is `repairApplied`, and every call site computes it the same way
  (`isRepairInReview(repairJobId, reviewState)` in `@varys/review-contract`): the run's own test
  version was written by a Repair Agent and is still `unreviewed`. No column was added to `runs`.

  That choice has one visible consequence worth a reviewer's eye: **accepting the repair makes the
  run read `passed` again** — including runs already in the history. The reading is "this rests on
  an edit nobody signed off", so once somebody signs off it stops being true, and `healed` is a
  review-queue marker rather than a permanent scar. The alternative (a `runs.repair_job_id` column,
  amber forever) is defensible too, and it is the one thing here a product opinion should decide.
  It is also what makes the suite and schedule criteria true without special-casing: an ordinary
  suite child or cron fire of a test whose active definition is an unaccepted repair simply reads
  `healed`, because it genuinely is one.

- **The re-run is best-effort and never blocks the repair.** `RepairJobsService.triggerRerun`
  swallows a queue failure, logs it, and returns `rerunId: null`; the report then says plainly that
  nothing was retried. The repair has already passed the justification gate at that point and
  stands — a queue outage is a reason to have no evidence yet, not a reason to throw a judged
  repair away.

- **A healed run counts as a PASSING verification in the dashboard pass rate.** It compared against
  real baselines and everything matched; the only amber thing about it is an unreviewed repair,
  which is a queue item, not a failed check. Excluding it (the `pending-baseline` treatment the
  slice's "same weight class" wording might suggest) would collapse the pass rate toward 0% exactly
  when repairs are pending — which reads as an alarm, the one thing `healed` is explicitly not.
  Reversible in one line in `dashboard.service.ts#rate` if that call goes the other way.

- **`counts.healed` on a suite is a SUBSET of `counts.passed`, not a sibling.** A healed child's
  coarse status is `passed`, so it stays counted there and `deriveStatus` is untouched — the suite
  reports passing, exactly as the criterion asks. The report panel shows the Healed tile only when
  it is non-zero, and the history row's stacked bar deliberately has no healed segment (it would
  double-count). Worth a frontend-literate pass on whether a subset-count reads clearly enough
  there.

- **The digest, not the page.** `notifyRunComplete` now faces a healed run as 🩹 HEALED with the
  `review` tone and a "review the repair" deep link, instead of ✅ PASSED. Only `healed` is lifted
  from the derived outcome into the notification; the rest of the vocabulary refines what
  `passed`/`failed` already say truthfully. It rides the EXISTING per-source gates — no new
  `slack_notify_healed` setting — so a project that has muted manual notifications hears nothing
  about healed runs either. If healed should be able to speak when everything else is muted, that
  is a new setting and a new slice.

- **The re-run's `triggerSource` is a new value, `repair`.** It is neither a person's `manual` nor
  a cron's `schedule`, and the Runs source filter does not offer it as a facet (it is in the
  column's label map only). Older runs still degrade to "Manual" as before.

- **Precedence is pinned by unit tests, not by the E2E.** Every pairing — including
  regression-outranks-healed and crash-outranks-healed — is one case in
  `packages/review-contract/src/derive-run-outcome.test.ts`, each asserted with AND without the
  repair flag so the case shows what the flag did and did not change. Driving a pixel diff and a
  crash through a real browser as well would buy minutes and no confidence: it is one pure
  function.

- **A re-run that fails again enqueues another Repair Job, and nothing here stops that looping.**
  The re-run is an ordinary run, so an `auto`-policy test whose repair did not actually work goes
  straight back onto the queue: repair → re-run → fail → repair → … Each pass is gated by the
  justification judge and each writes versions, so it is not silent, but it is a treadmill. The
  per-job `ATTEMPT_CAP` does not catch it because every cycle is a NEW job. This is squarely
  slice 07's territory (clustering + circuit breaker) and is left to it deliberately rather than
  half-solved here — but it is now reachable, which it was not before this slice.

- **The re-run made `repair-justification-gate.e2e.spec.ts` racy, and that spec was hardened, not
  papered over.** A passing case now leaves a re-run executing after its assertions finish; the
  next case flips the fixture variant out from under it, so it can fail on a locator and enqueue a
  job of its own, which `claim_repair_job` would then hand the drainer instead of the job under
  test. The fix is three things, all in the spec: `quiesce()` (drain to no in-flight runs before
  touching the variant), cancelling every queued job except this case's, and asserting the claimed
  job IS the expected one so a future recurrence fails legibly instead of as a confusing
  "no repair job … is claimed by you".

- **Pre-existing failures, unrelated and unchanged by this work**, verified by running each suite
  against a stashed tree: `repair-edit.e2e.spec.ts` (2 failures) and `baseline.e2e.spec.ts`
  ("hard-fails the run when no fingerprint signal matches"). Both fail identically on clean `main`.

- **`/code-review` was not run**: this session is configured not to spawn subagents.
