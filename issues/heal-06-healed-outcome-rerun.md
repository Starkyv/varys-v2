# Slice 06 — The `healed` outcome, the re-run, and the digest

**Type:** AFK · **Label:** `ready-for-agent` · **Blocked by:** 05

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

- [ ] An applied repair triggers a re-run of the test
- [ ] A re-run where everything verified but a locator was re-pinned reads `healed`
- [ ] A re-run with a pixel diff reads `regression`, **not** `healed`, even though a locator was re-pinned
- [ ] A re-run that crashes reads `failed`, not `healed`
- [ ] A suite containing a healed run still reports as passing, with a healed count
- [ ] A schedule is not blocked by a healed run
- [ ] `healed` renders distinctly from passed and failed on run detail, runs list, test history, dashboard matrix, and suite report
- [ ] A digest notification fires for healed runs; no page
- [ ] The count of healed versions awaiting review is visible
- [ ] Pure unit tests cover every precedence pairing, including regression-outranks-healed

## Blocked by

- Slice 05 (nothing may go amber before the justification gate exists)
