# Repair is attended, and a test has one definition — ADR 0003 and ADR 0005 are superseded

When a run fails, Varys does nothing about it. A person reads the failure and asks their own
Claude to repair it, naming the run or the test; Claude opens a **Repair Session** over `/mcp` and
edits the test **in place**. There is no queue, no claim, no lease, no circuit breaker, no
clustering, no triage job, no justification gate, no service credential, and no version history.
[ADR 0003](./0003-repair-on-user-cloud-claude-claim-drain.md) (Varys queues, a cloud Claude
drains) and [ADR 0005](./0005-scoped-repair-agent-credential.md) (a second issuer on `/mcp`) are
superseded in full.

## Context

Both superseded ADRs answered one question: *who repairs a test when nobody is watching?* ADR 0003
said a cloud Claude claiming from a Varys-owned queue, because "the **Bridge Helper** is a process
on someone's laptop and cannot serve a 3am schedule". ADR 0005 issued it a credential, because an
unattended drainer cannot complete a browser OAuth leg.

Nobody needs a test repaired at 3am. The failure is still there in the morning, and the person who
reads it is the person who knows whether the app changed on purpose. Everything the queue was —
the lease that returns abandoned work, the breaker that refuses to repair a mass failure, the
clustering that collapses one renamed button into one job, the judge that rules on whether a
re-pin found the same control — is scaffolding around the absence of that person. With them
present it is all answered by them looking at it.

Test versioning went for a related but distinct reason, and it is the part a future reader will
find most surprising: **a test-management tool with no history.** `test_versions` carried four
jobs, and each one turned out to have a better home or no longer exist:

- *A gate on unattended edits.* A repair landed `unreviewed` so an agent's change could not
  quietly become the definition every run replays. With no unattended agent, nothing is unreviewed.
- *Reproducibility.* A run pinned the exact definition it replayed. That is now a write-once copy
  of the definition **on the run itself** — which is what a run needed all along, and needs no
  history of the test to provide.
- *Audit.* "Who last changed this test" is `tests.updated_by` / `updated_at`.
- *Concurrency.* The stale-editor guard moved from `baseVersion` to `updated_at`. It is kept:
  two tabs clobbering each other is a loss you cannot see happened.

What remains is rollback, and rollback is the thing being given up deliberately.

## Considered options

- **(Chosen) Attended repair; one definition per test; a run-local snapshot.** The entire
  attended toolset survives untouched — `failed_runs`, `open_repair_session` (which already took a
  `runId` **or** a `testId` and never needed a job), `try_locator` → `apply_fix`, `read_test` →
  `edit_test`. `/mcp` has one issuer again, so ADR 0002 stands unqualified rather than
  carved out.
- **Keep the queue, default every test to `manual`.** Rejected: dead machinery that still has to
  compile, migrate, and be reasoned about on every change. `repair_policy` defaulted to `manual`
  already, which is precisely why nothing was lost by removing the other branch.
- **Keep versions, drop only the review gate.** Rejected: the gate was the only thing versions
  were doing that a run-local snapshot does not do better. Keeping the table to preserve a
  rollback nobody had used would have kept `runs.test_version_id`, the `max(version)` subquery on
  every test read, and the version number in five user-visible strings.
- **Drop versions with no snapshot on the run.** Rejected: every past run would silently re-render
  against the current definition, `failed_step_index` could point at a step that no longer exists,
  and a repair session would park on the page today's test faces rather than the page that broke.
  A Run would stop being evidence.

## Consequences

- **A locator failure now sits there until a human acts.** No job appears, nothing self-heals, and
  a mass failure raises no alert (the breaker's alert went with the breaker). The run is red and
  someone has to look — which was already true under the `manual` policy every test defaulted to.
- **No unattended Agent Run Sessions.** `can_start_agent_runs` existed so a credential could start
  one with no human present. An Agent Run Session now begins only from a signed-in person or their
  paired Bridge Helper — which is what ADR 0007 describes anyway: their Claude, their machine,
  their subscription.
- **No rollback and no test history.** A bad edit is fixed by editing again. "What did this test
  look like last month" is unanswerable except through the runs that replayed it.
- **The justification gate is gone**, and with it `judgeRepairJustification`. A repair is no longer
  argued against the **Brief** by a judge; the person who asked for it reads the result. The
  before/after **Signal Diff** that made an agent's claim checkable is removed rather than
  relocated — its reviewer no longer exists.
- **Destructive migration.** `test_versions`, `repair_jobs`, `repair_job_tests`,
  `suppressed_failures` and `agent_credentials` are dropped, after backfilling `tests.definition`
  from each test's latest version and `runs.definition` from the version each run actually ran. The
  backfill is what makes this deployable against an existing corpus; the drop is what makes it
  irreversible.
- **API test coverage shrank from 51 specs to ~23**, by explicit decision: specs coupled to
  versioning were deleted rather than rewritten. That includes coverage of features being kept —
  Agent Run Sessions, the Checkpoint Manifest, the wall-clock lease, `unreached`, schedule firing,
  folders, assertions and the run lifecycle.
