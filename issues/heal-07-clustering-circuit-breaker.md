# Slice 07 — Failure clustering and the circuit breaker

**Type:** AFK · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** 01

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

Bound the blast radius. One app change must produce **one** reviewable fix, and a bad deploy must
produce **none**.

A new pure package, `@varys/repair-policy`, owns three things as functions over failure records:
cluster-key derivation from a failing locator's strong signals, clustering, and the
circuit-breaker predicate. Pure and network-free, in the shape of `@varys/locator-engine`.

**Clustering happens before enqueue.** Thirty-eight tests broken by one renamed button become one
job, proposed once and applied across the cluster as a single reviewable change — not thirty-eight
independent repairs that can diverge from each other.

**The breaker is checked at enqueue time.** Above a project-level threshold of simultaneous
failures, no jobs are created at all: the failures are recorded as breaker-suppressed and an alert
fires through the existing notify path. Mass failure means the app broke or was redesigned, which
is a human decision. Without this, one bad deploy rewrites the whole corpus into agreement with a
bug — and every subsequent run goes amber, then green.

A deliberate human override exists, because a genuine mass redesign *is* something you want to
repair in bulk once you have confirmed it.

## Acceptance criteria

- [x] Failures sharing a locator signature collapse into one job; unrelated failures do not
- [x] A repair reported for a clustered job applies across every test in the cluster as one reviewable change
- [x] Rejecting a clustered repair reverts every test in the cluster
- [x] Failures above the threshold create **zero** jobs and are recorded as breaker-suppressed
- [x] Tripping the breaker fires an alert through the existing notify path
- [x] The breaker's state, threshold, and what it suppressed are visible
- [x] An admin can override a tripped breaker and release the suppressed failures for repair
- [x] The threshold is a project setting with a documented default
- [x] Pure unit tests cover clustering of mixed failures, and the breaker at, over, and under threshold

## Blocked by

- Slice 01 (enqueue must exist before it can be clustered or suppressed)

## Flags raised

- **A job now spans many tests, and that is a schema shape change.** `repair_jobs.test_id`/`run_id`
  became the ANCHOR (the oldest failure, the one a drainer opens its session on) and a new
  `repair_job_tests` table carries the membership. The queued-unique index moved from
  `(test_id, cluster_key)` to `cluster_key` alone — project-wide — which is what makes "one app
  change, one job" true. The DDL drops the old index and BACKFILLS `repair_job_tests` from every
  existing job, so a pre-clustering job is simply a cluster of one and no reader needs a
  "clustered or not?" branch.

- **The Repair Agent credential's reach widened, deliberately.** `claimedJobId` now matches through
  `repair_job_tests` rather than `repair_jobs.test_id`, so a claim reaches every test in the cluster
  — it has to, because the fix is written across all of them. ADR-0005's wording already said "the
  tests covered by a job it has claimed" (plural); this is the first slice where that is more than
  one. **Worth a second opinion**: one claim now grants write access to N tests, and N is decided by
  the cluster key, not by a human.

- **The breaker counts distinct TESTS, not clusters, and that is the whole call.** Counting clusters
  would read "40 tests, 1 renamed button" as `1 ≤ 10, carry on` and wave through the single most
  consequential rewrite the product can perform. So a big genuine rename DOES trip the breaker — and
  the override exists precisely for that case. The cluster spread is reported alongside
  (`clusters`) and is the first thing the UI and the Slack alert say, because "40 tests, 1 cluster"
  is a rename you can confirm in a minute and "40 tests, 31 clusters" is a broken deploy.

- **"Simultaneous" is a one-hour window over `runs.failure_kind = 'locator'`, and the window is a
  constant, not a setting.** The ticket only required the threshold to be configurable. Counting the
  open QUEUE instead was rejected: a project with no drainer accumulates queued jobs by design
  (ADR-0003), so that would trip the breaker permanently on a project whose only problem is that
  nothing is draining — the exact diagnosis slice 01 worked to keep distinct. The consequence to
  check: a suite that takes longer than an hour spreads its failures across two windows and can
  under-count. `BREAKER_WINDOW_MS` in `packages/runner/src/repair-jobs.ts` is the one line to change
  if that matters.

- **The breaker's state is recomputed on read, never stored.** A stored `tripped` flag needs
  something to decide when to clear it, and that is the judgement the window already makes. So the
  breaker un-trips by itself an hour after the mass failure stops, and the queue view is never
  stale. It also means `tripped` can read false while suppressed failures are still held back —
  which is correct (the event is over; the work is still waiting) and the UI says so in those words.

- **The MANUAL enqueue path is deliberately NOT gated by the breaker.** A person opening one failed
  run and asking for it to be repaired IS the human decision the breaker is holding out for, at the
  finest grain there is. Gating it would leave a tripped breaker with no way to repair one
  known-good case short of releasing everything. Stated in `enqueueForRun`'s doc — but it does mean
  the breaker is bypassable one run at a time by anyone who can reach the API.

- **The fan-out is read from what the anchor BECAME, not from what the drainer said.** The step that
  carried the job's cluster key before the repair is diffed against the definition after it, and the
  new target is applied to every member — matched by cluster key too, so a member whose broken step
  sits at a different index is still repaired. Two consequences worth a reviewer's eye:
  - a repair that is not a traceable locator re-pin (an `edit_test` that restructured the steps)
    **does not fan out at all**. The anchor's repair stands alone, and the log says so. That is the
    conservative branch: fanning a change we cannot identify across other people's tests would be a
    guess.
  - a member that no longer carries the broken locator is SKIPPED, not failed — a cluster is a
    hypothesis about a root cause, and a member already edited past the break has nothing to repair.

- **A half-applied cluster fails closed.** If any member cannot take the fix, everything the job
  wrote — anchor included — is reverted through the same `revertRepair` a human Reject uses, the job
  goes back to the queue, and the report is refused. A cluster half-repaired is worse than none,
  because the queue would call it done.

- **Accept and reject are now cluster-wide decisions.** The review queue collapses a clustered
  repair to ONE item (the anchor) naming every test, and accepting/rejecting decides all of them.
  Rejecting reverts each member test through its own `revertRepair`. If a member's revert throws,
  it is logged and the rest continue — a partial revert is bad, but stopping halfway is worse.
  **Worth checking**: that per-member failure is logged, not surfaced to the reviewer.

- **The Slack alert is NOT gated by the per-source notification switches.** `notifyManual` /
  `notifySchedule` / `notifySuite` say which RUNS you want to hear about; a tripped breaker is not a
  run, it is Varys declining to repair anything until a human looks. Muting run notifications must
  not silently mute the guard. It still needs a token and channel configured.

- **`enqueueRepairIfAuto` changed its return type** from `string | null` to a discriminated
  `EnqueueOutcome` (`enqueued` | `joined` | `suppressed` | `skipped`). The runner's own call site
  ignores it; nothing else consumed it.

- **`repair-queue.e2e.spec.ts` needed a `beforeEach` that clears the queue.** Every case in it breaks
  the same fixture control, so under clustering they now join one another's Failure Cluster instead
  of opening their own job. The assertions were pinning slice 01's per-test rule, which clustering
  supersedes; giving each case its own queue preserves what they were actually testing rather than
  weakening them.

- **The web surfaces are unverified by hand.** Per house practice there are no UI tests and this
  session could not run the SPA. The circuit-breaker card on the Repair queue (with its Override
  confirm), the cluster lines on queue rows and review items, and the threshold card on
  Configurations all typecheck and are wired to tested endpoints, but nobody has looked at them.
  The breaker card's copy carries the judgement call — it tells the reader whether this looks like a
  rename or a broken deploy — and that wording deserves a human read.

- **Three neighbouring specs needed clustering-aware fixtures, and the change is honest rather than
  weakening.** `repair-claim` ("two drainers end up with different jobs", "scopes the claimer to the
  test it claimed") and `repair-round-trip` ("refuses the repair tools for a test the claim does not
  cover") each need TWO independent jobs, which since clustering means two independent BREAKS — two
  tests sharing one broken control are now correctly one job, so there would be nothing for the
  second drainer to win. Each now stages a distinct broken locator. `repair-queue` got a `beforeEach`
  that clears open jobs, since every case in it breaks the same control.

- **The pre-existing `repair-queue` intermittent is still there and is NOT this slice.** Across three
  isolated runs it passed 18/18 twice; the one failure was a `403` on `POST /tests` in a
  bulk-policy case that starts no runs and never touches the queue. Slice 01 already flagged this
  shape ("socket hang up … most likely container/pg-boss contention"). Worth someone chasing it
  properly — a suite that fails 1-in-3 on auth teaches you to ignore red.

- **`/code-review` was not run**: this session is configured not to spawn subagents.

## Promotion candidates

None. The circuit-breaker card and the cluster note both live in `views/RepairQueue/` and speak
repair vocabulary throughout (Failure Cluster, suppressed, cluster key), which by the promotion test
makes them this feature's components rather than shared ones. Each has one caller.
