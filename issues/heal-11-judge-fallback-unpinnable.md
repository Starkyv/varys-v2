# Slice 11 — Judge fallback for unpinnable assertions

**Type:** AFK · **Label:** `ready-for-agent` · **Blocked by:** 09

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

Not every check reduces to two extractions and a relation. "The chart looks reasonable" cannot be
pinned, and the honest answer is to judge it rather than to pretend.

An assertion with no pinned form falls back to the existing `JudgeProvider`. That seam is already
built, already swappable, and already maps a thrown transport error to needs-review rather than a
silent pass — which is precisely the behaviour required here.

The author-facing half matters as much as the mechanism: an author must be able to tell **which
of their assertions are exact and which are approximate**, and must be told when an assertion
cannot be pinned at all, so they can rephrase it rather than discovering months later that it was
never really being checked.

Note the deliberate boundary. A judge reading `$1,203,441` off an image and summing a 40-row
column is exactly where a model hallucinates — so the fallback exists for *qualitative* checks,
and the vocabulary exists for *quantitative* ones. Do not let the fallback become the default
path for numeric comparisons.

## Acceptance criteria

- [ ] An assertion with no pinned form is evaluated by the existing judge provider
- [ ] A judge transport error marks the run needs-review — never a pass
- [ ] The test editor shows, per assertion, whether it is pinned (exact) or judged (approximate)
- [ ] An assertion that cannot be pinned tells the author so, with enough detail to rephrase it
- [ ] A judged assertion's verdict and reasoning appear on run detail beside its check text
- [ ] Judged and pinned assertions on the same test both run, and either can fail the run
- [ ] Unit tests use the fake judge provider, including its throw path

## Blocked by

- Slice 09 (assertions must exist and be evaluated before a fallback has meaning)
