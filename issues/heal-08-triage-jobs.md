# Slice 08 — Triage jobs: every red run gains an explanation

**Type:** AFK · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** 03

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

- [x] A pixel regression enqueues a triage job, not a repair job
- [~] A failed judge, a false assertion relation, a crash, and a timeout each enqueue a triage job — *judge, crash and timeout are covered; a **false assertion relation** cannot be, because assertions do not exist until slice 09. The class is in the vocabulary and wired; see Flags.*
- [x] A triage claim grants observation tools only
- [x] An agent holding a triage claim is refused `apply_fix`, `edit_test`, and baseline approval
- [x] A reported finding is written onto the run and displayed with the failure
- [x] The run's outcome is **unchanged** by triage — still red
- [x] No test version is created by a triage job
- [x] Triage jobs share the queue, lease, attempt-cap, and cancel behaviour of repair jobs
- [x] E2E: a real pixel regression produces a triage job, a simulated drainer reports a finding, the run stays red and the definition is untouched

## Blocked by

- Slice 03 (triage jobs are claimed through the same lease mechanism)

## Flags raised

- **One acceptance criterion is partial, for the same reason slice 01's was.** "A failed judge, a
  false assertion relation, a crash, and a timeout each enqueue a triage job" is three-quarters
  done: judge, crash and timeout are each covered by a real failure in the E2E. A **false assertion
  relation** cannot be — `@varys/assertion-engine` lands in slice 09, so there is no relation to make
  false. `assertion` is in `TRIAGE_FAILURE_KINDS` and in `RunFailureKind`, so slice 09 only has to
  throw with that class rather than extend the vocabulary; it should add the test rather than
  assume this one covered it.

- **Triage is gated on the same `auto` Repair Policy repair is, and that is a product call worth
  confirming.** Slice 01 promised a `manual` test "behaves exactly as it did before the queue
  existed", and finding triage jobs about it in the queue would break that promise. But triage
  writes nothing, so a project might reasonably want *diagnosis everywhere* and *repair nowhere* —
  which today needs `auto`, and `auto` also opts the test into unattended editing. If that split is
  wanted it is a third policy value (`diagnose`), not a tweak.

- **Triage is deliberately NOT gated by the circuit breaker.** The breaker exists to stop a bad
  deploy rewriting the corpus; triage cannot write. During a mass failure an explanation is the
  single most useful thing Varys can produce, so suppressing it would remove the one safe output at
  exactly the moment it matters most. Consequence: a bad deploy that breaks 200 tests produces zero
  repair jobs and up to 200 triage jobs. They are per (test, failure class) so they do not multiply
  per run — but slice 07's breaker will not hold them back, and nothing else will either.

- **The triage cluster key is scoped to the TEST, unlike a repair key, and it has to be.** A repair
  key is deliberately test-blind so one renamed button collapses across thirty-eight tests. Two
  tests that both crashed did not necessarily crash for the same reason — and since slice 07 the
  queued-unique index is over `cluster_key` alone (project-wide), a test-blind `triage:crash` would
  silently merge two unrelated diagnoses into one job. Unit-tested, including that a triage key can
  never collide with a repair key.

- **`runs.failure_kind` is now written for runs that are NOT `failed`.** A pixel regression finishes
  every step and comes back `needs_review`; it is red, and it now carries `failure_kind = 'pixel'`.
  The column's doc changed from "for a failed run" to "for a red run" to match. Every existing
  reader keys on the exact string `'locator'` (the repair affordance, the manual-enqueue guard, the
  breaker census), so widening the vocabulary cannot accidentally make a crash look repairable —
  and `RunsService.getById` degrades an unrecognised stored value to null rather than passing a
  class no surface can render.

- **A judge that cannot RUN is classified `judge`, not `crash`, via a new typed error.** No judge
  configured (or no prompt) throws `JudgeUnavailableError`, matching the `LocatorUnresolvedError`
  precedent: the class of a failure is recorded by the code that knows what threw, never matched out
  of a message. Without it the queue says "crashed" when the truth is "you have not configured a
  judge", which sends whoever reads it looking in the wrong place. **Note the asymmetry**: a judge
  that runs and returns `fail` is a `diff` checkpoint, so it is *also* classified `judge` — both
  paths land in the same class, which is right, but they arrive very differently.

- **`open_repair_session` learned to park on a red CHECKPOINT.** A pixel regression has no failing
  *step*, so opening a session on it used to be refused outright — which made "drive to the failure
  and look" impossible for the commonest triage class. It now falls back to the first red
  checkpoint's screenshot step. This changes behaviour for the human repair path too (a session on a
  needs-review run now opens instead of erroring), which reads as an improvement but is a change
  nobody asked for in this ticket.

- **Baseline approval is an ABSENCE, not a refusal, and the E2E asserts the absence.** There is no
  approve tool on `/mcp` for any principal, so an agent has no verb for it at all. That is stronger
  than a check that could be forgotten — but it also means nothing fails loudly if someone later
  adds one. The test asserts `tools/list` contains no `approve*` / `set_baseline` name, which is the
  closest thing to a guard rail available.

- **`REPAIR_CLAIM_TOOLS` is the enforcement list and it is hand-maintained.** `apply_fix`,
  `edit_test` and `report_repair` need a repair claim; everything else an agent can reach is
  observation or page interaction. A future mutating tool that nobody adds to that list would be
  reachable under a triage claim. Worth a second pair of eyes on whether `click`/`type`/`navigate`
  belong there too — they mutate the PAGE, not the test, and triage needs them to reach the failure,
  so I left them out deliberately.

- **Three existing `repair-queue` cases changed from "no job at all" to "a triage job".** They were
  pinning slice 01's rule, which this slice supersedes for the job half. The load-bearing half —
  that none of these is repairable, including that a human cannot force one into the repair queue —
  is unchanged and now asserted explicitly in all three.

- **The web surface is unverified by hand.** Per house practice there are no UI tests and this
  session could not run the SPA. The finding card on run detail is toned as an OBSERVATION (info,
  not danger) on purpose: the failure is already red in the badge above, and colouring the
  explanation red too would read as a second failure rather than as the thing that makes the first
  one actionable. That judgement deserves a human eye, as does the footer line that says out loud
  that nothing was changed.

- **`/code-review` was not run**: this session is configured not to spawn subagents.

## Promotion candidates

None. The finding card lives in `views/RunDetail/` and its copy is triage vocabulary throughout
("what a repair agent found", "a diagnosis, not a fix"), which by the promotion test makes it this
feature's component. One caller.
