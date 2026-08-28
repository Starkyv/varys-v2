# Slice 14 — The attended repair loop: run it, and stop demanding a judge

**Type:** AFK · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** 04, 05

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19). Amends
slice 05's gate; adds to the attended path slice 18 opened.

## What to build

Two changes, both from the same complaint: a person asking their own Claude *"this test is broken,
fix it"* should get a finished answer, and should not be stopped by a setting they never chose.

**1. `run_test` / `run_status` — the half of "fix it" that proves the fix.** Until now an attended
repair ended at "I wrote v2"; the person who asked had to go and press Run to find out whether it
worked. The fix and the proof of the fix were in different hands. `run_test` queues a run of the
test's latest version through the same path the Run button uses, waits for the verdict, and hands
back an answer shaped so the outcomes that are NOT passes cannot be quietly reported as passes.

Human principals only. A drainer that could trigger runs could sit in an unattended
fix-and-retry loop until something went green, and "green eventually" is exactly the evidence
slice 05 exists to refuse. An unattended repair still gets its one re-run, queued by Varys after
the repair is reported (slice 06).

**2. A judge is no longer a precondition for a repair.** Slice 05 refused every repair when no
judge was configured. That is right when a project has *asked* for a second opinion and it is
unavailable — but a project that never configured one has not asked, and refusing work a human
explicitly requested over an unset API key is the wrong failure. So: no judge configured ⇒ the
repair stands on the agent's own account, recorded as **not independently validated** and shown as
such in review. A judge configured ⇒ slice 05 unchanged, preconditions and all.

The safety that was always load-bearing is untouched: the version is still `unreviewed`, the run is
still red, and a human still accepts it — now knowing which of the two kinds of evidence they hold.

## Acceptance criteria

- [x] `run_test` runs a test's latest version and returns the verdict, by `testId` or by a repair
      session's `sessionId`
- [x] A wait that elapses returns `finished: false` and a `runId`; `run_status` resumes it
- [x] The answer reports `outcome` (not just `status`), the failing step, `failureKind`, the
      checkpoints awaiting a human, and only the assertions that failed
- [x] `pending-baseline`, `baseline`, `regression` and `healed` each carry prose saying what may
      and may not be claimed about them — a first run is never reportable as a pass
- [x] Neither tool is listed for, or callable by, a Repair Agent
- [x] With no judge configured, `report_repair` succeeds, asks no judge, and records the repair as
      unvalidated; the version is still `unreviewed` and the job closes `done`
- [x] With a judge configured, every slice-05 behaviour is unchanged (pass, fail, throw, no-Brief)
- [x] The review surface distinguishes a judged verdict from an unvalidated one
- [x] The authoring instructions tell Claude to prove a repair with `run_test`, and how not to
      overstate the outcome
- [ ] Verified by hand — UI tests are out of scope per house practice

## Blocked by

- Slice 04 (a repair to prove), slice 05 (the gate this amends)

## Flags raised

- **This is a deliberate weakening of slice 05, requested twice by the product owner after the
  trade-off was stated.** The judge is now opt-in by configuration rather than mandatory. The case
  it was built for — a control that is GONE with a plausible different one in its place, which
  re-pins cleanly and resolves — is now caught only by the human reviewer reading the signal diff.
  That is a real reduction in unattended safety and should be weighed against the slice-00
  wrong-fix measurement before this is run unattended at scale.
- **The no-Brief refusal now only applies when a judge is configured.** It was the gate's
  precondition, not an independent rule: with nothing validating the claim there is nothing for a
  Brief to be checked against. A Brief is still what the reviewer reads, and still worth having.
- **`justification_validated` is a new column, and null for every existing row.** The review UI
  treats null as "not stated" and renders as before; only an explicit `false` gets the warning
  tone. So historical repairs do not retroactively read as unvalidated.
- **`run_test` blocks the MCP request while it waits** (default 90s, max 300). That is a held HTTP
  connection per waiting call. Bounded on purpose, with `run_status` as the continuation, but a
  long-poll is still a long-poll — worth a look if many sessions run tests at once.
- **`run_test` costs a real replay against the real app**, and the model decides when to spend it.
  The tool description and the authoring instructions both say "when you need the answer, not
  reflexively after every edit"; whether that holds in practice is a wording question a human
  should watch.
- **`/code-review` was not run**: this session is configured not to spawn subagents.

## Promotion candidates

None. `RunToolService` is API-side and speaks repair/authoring vocabulary; nothing new landed in
the web app beyond one tone class on an existing line.
