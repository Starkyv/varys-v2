# Slice 01 — Repair Policy + a locator failure enqueues a visible job

**Type:** AFK · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** none

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

The queue exists and fills. A test gains a **Repair Policy**; when a run fails on a locator it
cannot resolve and the policy is `auto`, Varys enqueues a **Repair Job** — and a human can see
it. Nothing claims or repairs anything yet.

End to end: a policy column on the test, defaulting to `manual` for hand-recorded tests so
nothing starts changing behind an author's back; a per-test toggle plus a bulk action across a
folder or tag; enqueue at the point in a run where an unresolvable locator is *already* detected
(not a separate scanner); a jobs table carrying test, originating run, kind, status, and attempt
count; and a queue view showing what is queued.

The queue view must distinguish **unclaimed** from **slow**. A project with no drainer
accumulates queued jobs, and per
[ADR-0003](../docs/adr/0003-repair-on-user-cloud-claude-claim-drain.md) that is an accepted
consequence — but it has to be visible, not mysterious.

Cluster key is written on the job now (a stable derivation from the failing locator's strong
signals) even though clustering behaviour lands in slice 07. Writing it early avoids a backfill.

## Acceptance criteria

- [x] A test has a repair policy of `manual` or `auto`; hand-recorded tests default to `manual`
- [x] Policy is settable per test and in bulk across a folder or tag, and is visible on test detail
- [x] A run that fails on an unresolvable locator under `auto` creates exactly one queued job
- [x] The same failure under `manual` creates **no** job and behaves exactly as today
- [~] A pixel regression, a failed judge, and a false relation create **no** repair job — *pixel regression and failed judge are covered by tests; a **false relation** cannot be: assertions do not exist until slice 09. See Flags.*
- [x] A job records the test, the originating run, its kind, its cluster key, and its attempt count
- [x] A queue view lists queued jobs and shows unclaimed distinctly from in-progress
- [x] A queued job can be cancelled
- [x] A repair job can be enqueued manually from a failed run whose policy is `manual`
- [x] E2E: a real locator break staged with a new `@varys/fixture-app` variant produces a queued job — the failure is genuine, not stubbed

## Blocked by

None - can start immediately.

## Flags raised

**One acceptance criterion is partial, deliberately.** "A pixel regression, a failed judge, and a
false relation create no repair job" is two-thirds testable today:

- *Pixel regression* — covered: baseline seeded and approved, fixture flipped to `changed`, run
  comes back `needs_review` with `failure_kind` null and zero jobs.
- *Failed judge* — covered: a `context` checkpoint with no judge provider configured fails its
  step, `failure_kind` null, zero jobs, and `POST /repair-jobs` refuses it with a 400.
- *False relation* — **not covered, and cannot be.** Assertions land in slice 09, so there is no
  relation to make false. Structurally it is already safe (only `LocatorUnresolvedError`
  enqueues, and `assertion-engine` will have to opt in explicitly), but slice 09 should add the
  test rather than assume this one covered it.

**Two schema additions the ticket did not name.** Both looked cheaper to add now than to
backfill:

- `runs.failure_kind` — `'locator'` or null. "Is this repairable?" had to be a recorded fact,
  not a substring match on the error text: the manual-enqueue endpoint needs to refuse a pixel
  regression, and a regex over `error` is exactly the kind of guard that quietly stops working.
  Written by the runner, from the code that knows what threw.
- `repair_jobs.claimed_by` / `claimed_at` — nothing in this slice writes them (claiming is slice
  03), but the queue view's entire job is to tell unclaimed from in-progress, so it needs
  somewhere to read the claimer from. Slice 03 adds the lease.

**Double-enqueue: the partial unique index is not sufficient on its own.** `repair_jobs_queued_uq`
covers `status = 'queued'` only, so once a drainer claims a job, the next nightly failure of the
same locator would insert a *second* job behind the one being repaired. Both enqueue paths now
check for an OPEN (`queued` | `claimed`) job first, with the index still backing the
queued-vs-queued race two workers can actually hit. Covered by "does not stack a second job
behind one a drainer has already claimed".

**A flaky run to keep an eye on.** One run of `repair-queue.e2e.spec.ts` failed with
`socket hang up` on the manual-policy case; two subsequent full runs passed 18/18. The comment in
`@varys/queue`'s `startBoss` describes this shape (an unhandled pg-boss `error` event severing an
in-flight request), so it is most likely container/pg-boss contention rather than the code under
test — but it is a real intermittent, not something I fixed.

**Not committed.** The working tree already carried unrelated in-flight slice-18 work when this
started, and five files carry both those edits and mine — `apps/api/src/tests/tests.service.ts`,
`apps/web/src/views/TestDetail/index.tsx`, `packages/review-contract/src/index.ts`,
`packages/runner/src/index.ts`, and `issues/README.md`. Committing them would sweep half of
someone else's unfinished change set into this slice (`authoring-repair.e2e.spec.ts` is currently
failing on a message-wording assertion from that work, untouched by this slice). Everything here
is in the working tree, and this ticket's status is already `in-review`, so a re-run will not pick
it up again.

**The web surfaces are unverified by hand.** Per house practice there are no UI tests, and this
session could not run the SPA. The repair-policy card on test detail, the bulk control in the
Tests toolbar, the Repair queue view and the "Queue repair" button on run detail all typecheck
and are wired to tested endpoints, but nobody has looked at them.

## Promotion candidates

None. The one component that looked reusable — the queue table in
`apps/web/src/views/RepairQueue/` — reads `RepairJobStatus` and speaks in repair vocabulary
throughout, which by the promotion test makes it this feature's component rather than a shared
one. It also has only one caller.
