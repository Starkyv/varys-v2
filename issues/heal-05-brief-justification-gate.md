# Slice 05 — Brief-justification gate on every repair

**Type:** HITL · **Label:** `needs-design` → `ready-for-agent` after slice 00 · **Blocked by:** 04

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

The guard that stops a plausible-but-wrong repair from landing. Before a repair is applied, the
agent must state **which clause of the `Brief`** the re-pinned element satisfies, and a one-shot
judge validates that claim. A rejected justification abandons the repair; the run stays `failed`.

This is HITL because the judge's rubric is a **safety property expressed as prose**. Its wording
decides whether the guard actually catches the scenario it exists for: a deploy deletes "Apply
filter", the agent finds a plausible "Refresh" button, and re-pins to it. The rubric must reject
that. Getting the wording wrong produces a guard that always says yes, which is worse than no
guard because it looks like one.

Ride the existing `JudgeProvider` seam rather than inventing a new one — the fake provider then
covers this for free, and a thrown transport error already maps to "not a pass". Here that must
mean **repair abandoned**, never **repair accepted**.

Also in scope: the `Brief` becomes editable and is displayed beside the justification, since the
judge's verdict is meaningless to a reviewer who cannot see what it was checked against.

**Slice 00 gates GA, not development.** Build it, but let the spike's wrong-fix rate decide
whether this guard is sufficient alone or whether the strong-signal rule (rejected in Q11 of the
design interview) needs to sit alongside it.

## Acceptance criteria

- [ ] A reported repair without a brief-clause justification is refused
- [ ] The justification is validated by a judge before the repair is applied
- [ ] A rejected justification abandons the repair, leaves the test unchanged, and leaves the run `failed`
- [ ] A judge transport error abandons the repair — never applies it
- [ ] An accepted justification is stored on the version and shown beside the brief in review
- [ ] The brief is editable, and editing it does not disturb the test's history
- [ ] E2E, both directions: the rubric **accepts** a genuine rename of the same control, and **rejects** re-pinning to a different control when the original was removed
- [ ] Rubric wording reviewed by a human against the "deleted Apply filter → plausible Refresh button" scenario before this ships

## Blocked by

- Slice 04 (there must be a repair to gate)
- Slice 00 gates GA (not development)
