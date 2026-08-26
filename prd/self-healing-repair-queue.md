# PRD — Self-healing tests: assertions + the repair queue (Slice 19)

> A test that breaks because the app moved a button should fix itself, overnight, without a
> human — and must never go green by doing so. Plus the check Varys cannot express today: not
> "does this screenshot match", but "does this number equal the sum of that column".
>
> Labels: `ready-for-agent` (conceptual — see `issues/README.md`).
> Depends on: Slice 18 (repair session full edit) for `edit_test`; ADR-0003, ADR-0004, ADR-0005.

## Problem Statement

Two problems, from the test author's side.

**1. Tests die of app drift, and only a human can revive them.**

A recorded test carries a multi-signal `Fingerprint` per target, and the locator engine already
self-heals when a weaker signal still matches. But when *no* candidate clears the floor, the run
hard-fails with "could not locate", and that is where it stops. The cure exists — a Repair
Session re-drives the test to the failing step, parks a live browser there, and `try_locator` /
`apply_fix` write a verified fix — but every step of it requires a person to notice the red run,
open a session, and drive it. A nightly suite that breaks on Tuesday is red until someone looks
on Thursday, and the author's confidence in the whole corpus erodes with each one.

**2. There is no way to check a relationship, only an image.**

Every assertion in Varys is a `Checkpoint`: one image, diffed against a per-environment
baseline, or judged by an LLM against a prompt. That covers "does this look right". It cannot
express the checks authors actually care about most:

- the revenue KPI equals the sum of the Revenue column in the table below it
- the row count in the header matches the number of rows rendered
- the total on the summary page equals the total on the detail page
- this field is non-empty after the filter is applied

Asking the vision judge to do this is the wrong tool: reading `$1,203,441` off an image and
summing a 40-row column is precisely where a model hallucinates. Authors currently either skip
the check or approximate it with a screenshot that goes stale for unrelated reasons.

**Why the obvious fix is wrong.** The tempting answer to (1) is to stop replaying and let Claude
drive every run from a natural-language brief, adapting to whatever it finds. ADR-0004 records
why that was rejected: an agent that re-decides the path each run can silently fail to check
something and still report pass, and a false green is far more dangerous than the false red it
replaces. Cost and latency compound it — an agent session per test per environment per schedule,
forever, when almost every run faces an unchanged app.

## Solution

**Claude drives once, Varys remembers, Claude returns only when the memory goes stale.**

Three capabilities on the `Test` you already have — no new test kind (ADR-0004):

**Assertions.** A test declares named `Assertion`s alongside its checkpoints: a stable id and a
plain-language `check`. Once **pinned**, an assertion is *data, never code* — which fingerprints
to read, how to coerce each, and which relation to apply, drawn from a vocabulary Varys owns. The
worker evaluates it exactly, every run, with no model call. Assertions the vocabulary cannot
express fall back to the existing one-shot vision judge, and the author is told which ones did.

**Repair Policy.** Per test: `manual` (today's behaviour — surface it, a human opens a Repair
Session) or `auto` (enqueue a `Repair Job`). Available to *every* test regardless of how it was
authored — a hand-recorded test self-heals too, which is worth more than scoping it to
brief-authored ones.

**The repair queue.** Varys enqueues, a cloud Claude drains. When a run fails on a locator it
cannot resolve, Varys groups the failure into a `Failure Cluster` and enqueues one job per
cluster. An unattended drainer authenticates with a scoped `Repair Agent` credential
(ADR-0005), **claims** the job under a lease, drives the existing Repair Session, and re-pins.
Varys keeps everything durable — the queue, the pinned browser, the checkpoints, the baselines,
the audited version, the lease. Claude supplies only the judgement, on the user's own
subscription (ADR-0003).

**Three guards, all load-bearing:**

- **Auto-repair can never produce a green run.** Claude must name which clause of the `Brief`
  the re-pinned element satisfies; a judge validates that claim before the fix applies. The
  re-run's outcome is `healed` — amber, outranked by `regression` and `failed`, outranking
  `passed`. It does not fail a suite; it stays in the review queue until a human accepts the
  version.
- **A Circuit Breaker.** Above a threshold of simultaneous failures, repair is suppressed
  entirely and an alert is raised. Mass failure means the app broke or was redesigned — a human
  decision — not a corpus that has drifted. Without this, one bad deploy rewrites the whole test
  corpus into agreement with a bug.
- **Claude may never approve a baseline.** DESIGN.md §4 deletes the previous baseline on
  replacement with no rollback. An agent that can approve baselines can permanently erase the
  evidence that a regression happened.

Failures Claude may not fix — a pixel regression, a failed judge, a false relation, a crash —
become a read-only `Triage Job` instead: Claude drives to the failure, looks, and writes a
finding onto the run. The run stays red. Every red gains an explanation; none gains a fix.

## User Stories

**Assertions — authoring**

1. As a test author, I want to declare a named assertion on a test, so that I can check a relationship between two things on the page rather than only how they look.
2. As a test author, I want each assertion to have a stable id I choose, so that it has its own pass/fail history across runs the way a checkpoint name keys a baseline.
3. As a test author, I want to write the assertion's check in plain language, so that I do not have to learn a query syntax to express "the KPI equals the sum of the column".
4. As a test author, I want Claude to pin how an assertion is evaluated during the authoring session, so that later runs evaluate it without any model call.
5. As a test author, I want to see which of my assertions were pinned and which fell back to the vision judge, so that I know which ones are exact and which are approximate.
6. As a test author, I want to be told when my assertion cannot be pinned at all, so that I can rephrase it rather than discovering later that it was never really checked.
7. As a test author, I want to edit an assertion's check text without losing its id and history, so that a wording fix does not reset its record.
8. As a test author, I want to delete an assertion, so that a check I no longer care about stops failing runs.
9. As a test author, I want to see the pinned form of an assertion in the test editor, so that I can tell exactly which elements it reads and what it compares.
10. As a test author, I want a tolerance on numeric comparisons, so that a rounding difference in a currency total does not fail a run.

**Assertions — running**

11. As a test author, I want assertions evaluated on every run in the worker with no model call, so that adding a check does not add cost or latency to my nightly suite.
12. As a test author, I want an assertion whose extraction target no longer resolves to be treated as a *locator* failure, so that it is repairable like any other broken locator.
13. As a test author, I want an assertion whose extraction succeeded but whose relation is false to be treated as a *real* failure, so that a genuine bug in my app is never repaired away.
14. As a test author, I want each assertion's result shown separately on the run detail, so that I can see which check failed without reading a log.
15. As a test author, I want an assertion's pass/fail history over time, so that I can tell an intermittent failure from a new one.
16. As a test author, I want an assertion failure to fail the run, so that a broken relationship is as loud as a broken screenshot.
17. As a test author, I want an unpinnable assertion to be judged by the existing vision judge, so that "the chart looks reasonable" is still checkable even though it is not exact.
18. As a test author, I want a judged assertion that errors at the transport level to mark the run needs-review rather than pass, so that a model outage is never a silent green.

**Repair Policy**

19. As a test author, I want to set a test's repair policy to auto or manual, so that I control which tests may be edited without me.
20. As a test author, I want manual to remain the default for tests I recorded by hand, so that nothing I built starts changing behind my back.
21. As a test author, I want to set repair policy in bulk across a folder or tag, so that I can opt in a whole area at once.
22. As a test author, I want to see a test's repair policy on its detail page, so that I know whether a change I see was mine.
23. As a test author, I want auto-repair available on hand-recorded tests too, so that the capability is not limited to tests authored from a brief.

**The queue**

24. As a test author, I want a locator failure under an auto policy to enqueue a repair job automatically, so that the fix starts without me noticing the red run.
25. As a test author, I want failures that share one root cause grouped into a single cluster, so that one app change produces one reviewable fix rather than forty divergent ones.
26. As a test author, I want a repair applied across a whole cluster at once, so that thirty-eight tests broken by one renamed button are fixed consistently.
27. As a test author, I want repair suppressed entirely and an alert raised when too many tests fail at once, so that a bad deploy cannot rewrite my corpus to agree with it.
28. As a test author, I want to see the circuit breaker's state and threshold, so that I understand why jobs are queued and not draining.
29. As a test author, I want to override a tripped breaker deliberately, so that a genuine mass redesign can be repaired in bulk once I have confirmed it.
30. As a test author, I want to see the repair queue — what is queued, claimed, and finished, so that I can tell "slow" from "unclaimed".
31. As a test author, I want a queued job with no drainer to be visibly unclaimed rather than silently pending, so that a project with no repair agent is obvious rather than mysterious.
32. As a test author, I want to cancel a queued repair job, so that I can stop a repair I have decided to do by hand.
33. As a test author, I want to enqueue a repair job manually for a failed run, so that I can use the drainer on a test whose policy is manual.
34. As a Varys operator, I want a claimed job whose claimer stops reporting to return to the queue after its lease expires, so that a crashed drainer does not strand work.
35. As a Varys operator, I want a claim to be exclusive, so that two drainers cannot repair the same test concurrently and race on its version.
36. As a Varys operator, I want jobs to record who claimed them and when, so that the audit trail explains every change to a test definition.
37. As a Varys operator, I want a job that fails repeatedly to stop being retried, so that one impossible repair does not consume the drainer forever.

**Triage**

38. As a test author, I want a pixel regression to enqueue a read-only triage job, so that my red run comes with an explanation of what broke.
39. As a test author, I want triage to write its finding onto the run, so that I read the diagnosis where I am already looking.
40. As a test author, I want triage to be unable to edit the test or approve a baseline, so that an explanation can never quietly become a change.
41. As a test author, I want the run to stay red after triage, so that a diagnosis is never mistaken for a resolution.
42. As a test author, I want triage on crashes and timeouts too, so that "the run died" becomes "the run died because /api/metrics returned 401".

**The healed outcome and its review gate**

43. As a test author, I want an auto-repaired re-run to come back amber rather than green, so that I still know a human needs to look.
44. As a test author, I want healed to not fail my suite, so that a self-healed test does not block a deploy on a change that was probably fine.
45. As a test author, I want healed to be outranked by regression and failed, so that a real visual break stays the headline even if a locator was also re-pinned.
46. As a test author, I want the repaired version to sit in the review queue until I accept it, so that no AI edit to my corpus is trusted by default.
47. As a test author, I want to see, side by side, the old locator and the new one with the signals that changed, so that I can accept or reject the repair in seconds.
48. As a test author, I want to reject a repair and have the test revert to its previous version, so that a wrong fix costs me one click.
49. As a test author, I want to see Claude's justification against the brief, so that I can judge whether the re-pinned element is really the same thing.
50. As a test author, I want a repair whose justification the judge rejects to be abandoned and the run to stay failed, so that a plausible-but-wrong fix never lands.
51. As a test author, I want a digest notification for healed runs rather than a page, so that self-healing informs me without waking me.
52. As a test author, I want the dashboard matrix to show healed distinctly from passed and failed, so that I can see at a glance how much of my corpus is drifting.
53. As a test author, I want to know how many healed versions are awaiting review, so that the queue does not rot unnoticed.

**Repair Agent credential**

54. As a project admin, I want to provision a named repair agent credential, so that an unattended drainer can authenticate without a browser.
55. As a project admin, I want that credential restricted to claiming jobs and repairing within them, so that a leak cannot drive a browser through my authenticated staging environment at will.
56. As a project admin, I want the credential unable to open an authoring session, edit tests outside a claimed job, or approve a baseline, so that its blast radius is bounded by design rather than by trust.
57. As a project admin, I want to see each credential's last-used time, so that I can tell a live drainer from a forgotten one.
58. As a project admin, I want to revoke a credential in one click, so that a suspected leak is closed immediately.
59. As a project admin, I want credentials to expire, so that a forgotten one stops working on its own.
60. As a project admin, I want repaired versions attributed to the agent's label, so that the audit trail says "repaired by agent ci-box" rather than borrowing a person's name.
61. As a project admin, I want the existing per-user OAuth flow to keep working unchanged for attended Claude Code, so that adding machine access does not disturb humans.

**Brief**

62. As a test author, I want the brief that produced a test stored on it, so that any later repair can be checked against what the test was for.
63. As a test author, I want to edit the brief, so that I can sharpen the statement of intent as I learn what the test is really guarding.
64. As a test author, I want to see the brief beside a repair's justification, so that I can judge the claim without navigating away.

## Implementation Decisions

**No new test kind.** There is no `tests.kind`. `tests.intent` becomes the `Brief`;
`definition.assertions[]` is new; a per-test repair policy column gates enqueueing. Per ADR-0004.

**Two new pure packages.**

- `@varys/assertion-engine` — owns the pinned vocabulary and evaluates it over already-extracted
  values. Pure and network-free, in the shape of `@varys/judge-engine`: all semantics
  unit-testable with no browser and no model. Extraction itself (resolving a fingerprint,
  reading text off the page) stays in the runner; the engine sees only values.
- `@varys/repair-policy` — cluster-key derivation from a failed locator, clustering, and the
  circuit-breaker predicate. Pure functions over failure records, in the shape of
  `@varys/locator-engine`.

**The pinned assertion is data, never code.** A vocabulary Varys owns — coercions
(`text | number | sum-number | count | exists`) and relations
(`eq | neq | gt | gte | lt | lte | contains | non-empty`), with an optional numeric tolerance.
Nothing model-authored executes in the worker. Shape, from the design interview:

```ts
Assertion { id; check: string; pinned?: PinnedAssertion }

PinnedAssertion = {
  kind: 'relation'
  left:  { target: Fingerprint; as: Coercion }
  right: { target: Fingerprint; as: Coercion } | { literal: string | number }
  relation: Relation
  tolerance?: number        // numeric relations only
}
```

An assertion with no `pinned` form falls back to the `JudgeProvider`. This is deliberate:
`judge-engine` already exists, is already swappable, and already maps a thrown transport error to
needs-review rather than a silent pass.

**Extraction-failed and relation-false are different outcomes.** An assertion whose target does
not resolve is a *locator* failure and is repairable. An assertion whose targets resolved and
whose relation is false is an *app* failure and is never repairable. This distinction is the
entire safety property of assertions under auto-repair and must be represented in the result, not
inferred.

**`deriveRunOutcome` gains `healed`.** It is not derivable from checkpoints — it is a property of
the run (a repair was applied) — so the function takes a new input. Precedence:
`failed → regression → pending-baseline → healed → baseline → passed`. `healed` does not fail a
suite and does not block a schedule; it is a queue item, in the same operational weight class as
`pending-baseline`.

**The queue.** New tables for jobs and for agent credentials. A job carries: the test, the
originating run, a cluster key, a kind (`repair | triage`), status, claimer, lease expiry, and
attempt count. Enqueue happens where a run's locator failure is already detected, not in a
separate scanner. Claim is a single conditional UPDATE — the same optimistic-claim pattern
`SchedulerService` already uses to make overlapping ticks safe.

**Clustering before enqueue, not after.** One job per `Failure Cluster`, so a repair is proposed
once and applied across the cluster as one reviewable change. Cluster key derives from the
failing locator's strong signals, so "the same button broke everywhere" collapses to one job.

**Circuit breaker is checked at enqueue time** and is a project-level setting with a default.
When tripped, no jobs are created, the failures are recorded as breaker-suppressed, and an alert
fires via the existing `@varys/notify` path. A deliberate human override exists.

**Repair Agent auth is a second issuer, not an exemption.** `McpAuthService.principal()` grows a
second path that resolves an agent token to a real service principal (`agent:…`). Everything
downstream of the single choke point is unchanged, so ownership checks, `created_by` attribution,
and the claim record all keep working. Tool availability is gated on the principal's kind. Per
ADR-0005; ADR-0002 is amended, not reversed.

**New MCP tools, scoped to the agent principal:** claim the next job (optionally filtered),
report a repair with its brief-clause justification, report a triage finding, and release a job.
Repair itself reuses the Slice 18 tools — `goto_step`, `observe`, `try_locator`, `apply_fix`,
`read_test`, `edit_test` — restricted to the claimed job's test. No new drive primitives.

**The justification judge rides the existing `JudgeProvider` seam.** Claude must name the brief
clause the re-pinned element satisfies; a one-shot call validates it. Reusing the seam means
`FakeJudgeProvider` covers it and a transport error maps to "repair abandoned", never "repair
accepted".

**Rejected, recorded in ADR-0005:** the stateless repair bundle (Varys drives, offers candidate
elements with fingerprints pre-extracted, Claude answers "which one"). Smaller credential
surface and no lease, but it cannot handle repairs where the *flow* changed. Revisit if the real
failure distribution turns out to be dominated by simple element moves.

**Deliberately not decided here:** whether Claude Code requests the `offline_access` scope. It
mattered when an attended OAuth token was the drainer's only credential; with a provisioned agent
credential it is off the critical path. Noted because `better-auth@1.6.19`'s mcp plugin defaults
to `openid` only, issues 1-hour access tokens, and hard-rejects refresh for tokens lacking that
scope — so an *attended* session's longevity still depends on it.

## Testing Decisions

**What makes a good test here.** Assert on outcomes an author could observe: a run's outcome, an
assertion's result, whether a job is claimable, whether a tool call is refused, what the audit
trail says. Never on how a value was computed, which private method ran, or the shape of an
intermediate. Two specific traps to avoid: do not assert on the *text* of Claude's justification
(it is model output — assert that a rejected justification abandons the repair), and do not
assert on wall-clock timing for leases (inject the clock).

**No live Claude, anywhere.** A **simulated drainer** speaks the claim protocol over HTTP in the
test, exactly as `bridge.e2e.spec.ts` drives the relay with a simulated helper — the pattern
`prd/author-with-ai.md` already committed to ("testable with a simulated helper and no live
Claude"). Judge calls use `FakeJudgeProvider`, including its throw path.

**Real breakage, not mocked breakage.** `@varys/fixture-app` already exposes a `Variant` union.
Add a variant in which a target is renamed or moved, so a test recorded against one variant
genuinely hard-fails against the other. The repair loop is then exercised end-to-end against a
real browser and a real unresolvable locator — no stubbed failure.

**Seams, highest first:**

| Seam | Kind | Covers | Prior art |
|---|---|---|---|
| `@varys/review-contract` | pure | `healed` and its precedence rung, including that regression outranks it | `derive-run-outcome.test.ts` |
| `@varys/assertion-engine` | pure | every coercion × relation, tolerance edges, and extraction-failed vs relation-false | `judge-engine/index.spec.ts` |
| `@varys/repair-policy` | pure | cluster-key derivation, clustering of mixed failures, breaker at/over/under threshold | `locator-engine/index.spec.ts` |
| API e2e — queue | integration | enqueue on real locator failure, claim exclusivity under concurrency, lease expiry → requeue, attempt cap, cancel | `schedules-fire.e2e.spec.ts`, `suite-runs.e2e.spec.ts` |
| API e2e — agent auth | integration | agent token accepted; **denied** for `open_session`, for a test outside the claimed job, and for baseline approval; revocation and expiry take effect | `auth.e2e.spec.ts`, `authoring.e2e.spec.ts` |
| API e2e — repair round trip | integration | fixture variant break → job → simulated drainer repairs → judge accepts → re-run is `healed` → version unreviewed; and the judge-rejects path leaves the run `failed` | `authoring-repair.e2e.spec.ts`, `repair-edit.e2e.spec.ts` |
| API e2e — assertions in a replay | integration | pinned assertion passes and fails; extraction failure is repairable; relation-false is not; judge fallback and its error path | `replay.e2e.spec.ts`, `context-compare.e2e.spec.ts` |
| API e2e — surfacing | integration | `healed` on run detail, runs list, dashboard matrix and suite report; suite stays passing; review queue count | `review-ui.e2e.spec.ts`, `outcome-*` issues |

**The tests that matter most** are the negative ones — a judge-rejected justification leaves the
run red, a relation-false assertion is never enqueued for repair, a tripped breaker creates zero
jobs, and an agent credential is refused for every tool outside its scope. Those encode the
guards; the happy path is comparatively cheap to get right.

**Harness reuse.** Testcontainers Postgres via `db-harness.ts` and the existing
`auth-harness.ts`; no new harness. UI tests are out (see below).

## Out of Scope

- **Claude driving a run.** Rejected in ADR-0004 and not revisited here. Claude drives at
  authoring and at repair; never during a normal run.
- **A `kind: 'agentic'` column or any second execution path.** ADR-0004.
- **Brief-authoring UX.** Typing a brief and getting a Draft is mostly wiring over the existing
  Authoring Session and belongs in its own slice. This PRD assumes the brief is present and uses
  it for justification; it does not build the authoring surface.
- **The Bridge Helper.** Still unbuilt (`prd/author-with-ai.md`). Attended authoring is unchanged
  and unaffected.
- **Varys summoning a cloud Claude.** Varys never makes an outbound call to start an agent —
  that would require holding a credential that can spend the user's subscription. Rejected in
  ADR-0003. Consequence, accepted: Varys cannot guarantee an unattended repair ever happens.
- **The drainer itself.** The routine that runs on a box or in the cloud and polls the queue is
  operator-side configuration, not Varys code. Varys ships the credential, the tools, and
  documentation.
- **Auto-approving baselines, ever.** Not a scope decision — a permanent boundary. DESIGN.md §4.
- **Repairing crashes, timeouts and navigation errors.** Triage only. Widening auto-repair to
  execution failures was considered and left out: that class is most likely to be a real outage.
- **The stateless repair bundle.** Recorded as the near-miss alternative in ADR-0005.
- **UI tests.** Per house practice, the web surfaces are verified by hand.
- **Measuring `offline_access`.** No longer blocking; see Implementation Decisions.
- **Multi-drainer round-robin and drainer health.** First-claim-wins with a lease is enough;
  fairness across drainers is a later problem if it appears.

## Further Notes

**The premise inverted during design, and the ADRs carry why.** This started as "Claude drives
the whole run, no deterministic replay". Two consequences killed it: an agent that re-decides the
path can silently skip a check and still report pass, and paying for an agent session on every
run forever is untenable when almost every run faces an unchanged app. What survives is the
valuable half — Claude figures out how to find things, Varys remembers the answer — which makes a
brief-authored test *cheaper and more deterministic over time*, inverting the usual expectation
of an AI feature. Anyone tempted to "simplify" this back into a live agent loop should read
ADR-0004 first.

**The recurring failure mode across every decision was the false green.** It appeared three
times — an agent skipping a declared checkpoint, a repair re-pinning to a wrong element, and
auto-repair rewriting the corpus during an outage — and each guard exists for one of them. A
broken locator fails loudly; a skipped or repaired-away check fails silently, and silence ships
bugs. When trading these off later, that asymmetry is the tiebreak.

**Suggested slice order.** Q17 of the design interview picked the queue first, deliberately, to
prove the riskiest architecture before adding capability:

```
1 queue + agent credential + healed outcome (simulated drainer, fixture variant)
2 clustering + circuit breaker
3 triage jobs
4 assertions (engine, pinning, replay evaluation)
5 review UI for repaired versions
```

**One thing worth measuring alongside slice 1.** Nothing here establishes Claude's *wrong-fix
rate* on real failures — how often it re-pins to a plausible but incorrect element. That number
decides whether `healed` is a useful amber or a stream of noise nobody reviews, and it also
decides whether the stateless bundle would have been sufficient. The tools to measure it already
ship (`failed_runs`, `open_repair_session`, `try_locator`, `apply_fix`), so it costs a session
against real failed runs rather than any new code.
