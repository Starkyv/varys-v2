# Slice 08 — Triage jobs: every red run gains an explanation

**Type:** AFK · **Label:** `ready-for-agent` · **Blocked by:** 03

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

Failures Claude may *not* fix become read-only **Triage Jobs**. A pixel regression, a failed
judge, a false assertion relation, a crash, a timeout — each enqueues a job whose only output is
a written finding on the run. Claude drives to the failure, looks, and explains.

The run stays red. That is the whole point: a diagnosis must never be mistakable for a
resolution.

Enforcement is structural, not advisory. A triage claim grants observation only — no
`apply_fix`, no `edit_test`, and (permanently, per DESIGN.md §4) no baseline approval. If an
agent holding a triage claim attempts a mutation, it is refused.

This is where the "the chart is empty because /api/metrics returns 401" class of finding comes
from — the thing that turns a red cell into an actionable one.

## Acceptance criteria

- [ ] A pixel regression enqueues a triage job, not a repair job
- [ ] A failed judge, a false assertion relation, a crash, and a timeout each enqueue a triage job
- [ ] A triage claim grants observation tools only
- [ ] An agent holding a triage claim is refused `apply_fix`, `edit_test`, and baseline approval
- [ ] A reported finding is written onto the run and displayed with the failure
- [ ] The run's outcome is **unchanged** by triage — still red
- [ ] No test version is created by a triage job
- [ ] Triage jobs share the queue, lease, attempt-cap, and cancel behaviour of repair jobs
- [ ] E2E: a real pixel regression produces a triage job, a simulated drainer reports a finding, the run stays red and the definition is untouched

## Blocked by

- Slice 03 (triage jobs are claimed through the same lease mechanism)
