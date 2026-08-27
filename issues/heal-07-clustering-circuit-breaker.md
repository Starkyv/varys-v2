# Slice 07 — Failure clustering and the circuit breaker

**Type:** AFK · **Label:** `ready-for-agent` · **Blocked by:** 01

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

- [ ] Failures sharing a locator signature collapse into one job; unrelated failures do not
- [ ] A repair reported for a clustered job applies across every test in the cluster as one reviewable change
- [ ] Rejecting a clustered repair reverts every test in the cluster
- [ ] Failures above the threshold create **zero** jobs and are recorded as breaker-suppressed
- [ ] Tripping the breaker fires an alert through the existing notify path
- [ ] The breaker's state, threshold, and what it suppressed are visible
- [ ] An admin can override a tripped breaker and release the suppressed failures for repair
- [ ] The threshold is a project setting with a documented default
- [ ] Pure unit tests cover clustering of mixed failures, and the breaker at, over, and under threshold

## Blocked by

- Slice 01 (enqueue must exist before it can be clustered or suppressed)
