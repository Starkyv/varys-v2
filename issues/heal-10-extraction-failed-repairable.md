# Slice 10 — Extraction-failed is repairable; relation-false never is

**Type:** AFK · **Label:** `ready-for-agent` · **Blocked by:** 01, 09

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

Wire the distinction slice 09 produces into the queue slice 01 built.

An assertion whose extraction target no longer resolves is a **locator** failure. It is
repairable exactly like any broken step locator, and under an `auto` policy it enqueues a repair
job.

An assertion whose targets both resolved and whose relation is false is an **app** failure. It is
never repairable — under any policy, at any threshold, by any agent. Repairing it would mean
re-pinning until the numbers agree, which is a machine for hiding the exact bugs assertions exist
to catch. It enqueues a **triage** job instead (once slice 08 lands) or simply stays red.

This is a small slice by line count and the most important one in the assertions branch. It is
the point where a safety property becomes executable.

## Acceptance criteria

- [ ] An assertion whose target does not resolve enqueues a repair job under an `auto` policy
- [ ] Repairing it re-pins the assertion's extraction target and writes an unreviewed version
- [ ] An assertion whose relation is false enqueues **no** repair job, under any policy
- [ ] A relation-false assertion cannot be repaired even by a manually enqueued job
- [ ] A relation-false assertion enqueues a triage job where slice 08 is present
- [ ] The distinction is visible to the author on the run — "could not read the value" vs "the values disagree"
- [ ] E2E: a fixture variant that *removes* the assertion's target produces a repair job; a variant that *changes its value* produces none

## Blocked by

- Slice 01 (the queue must exist)
- Slice 09 (the distinction must be produced before it can be acted on)
