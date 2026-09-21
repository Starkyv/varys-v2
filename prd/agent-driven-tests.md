# PRD — Agent-Driven Tests: a test with no steps, run by your own local Claude

> A new test kind that stores **no steps and no fingerprints** — only an ordered list of
> **Checkpoints**, each carrying how to reach it and what to accept — which a **locally-run
> Claude** re-walks in full on every Run. Comparison is **always contextual, never pixel**.
> Varys supplies no browser and sees no driving: Claude reaches each state with whatever tooling
> it judges best (Chrome DevTools, Playwright, computer use), and Varys's surface is
> **reporting, not driving**.
>
> **This reverses [ADR 0004](../docs/adr/0004-brief-authored-tests-converge-no-agentic-kind.md)
> in part** ("there is no agentic test kind") and **departs from
> [ADR 0001](../docs/adr/0001-mcp-authoring-server-side-shared-core.md)**'s server-side-browser
> posture. Both reversals are deliberate, both are narrower than they look, and both need ADRs
> (see Further Notes).
>
> **Vocabulary is `CONTEXT.md`'s** and has been updated there in place: **Agent-Driven Test**,
> **Agent Run Session**, **Checkpoint Manifest**, **AI Instructions**, and an amended **Brief**.

---

## Problem Statement

Every test in Varys today is **pinned**: a human records it with the Chrome extension, or Claude
authors it in an Authoring Session, and either way the result is an ordered list of steps, each
carrying a multi-signal Fingerprint of the element it touches, replayed deterministically by the
worker with no model call. That is a genuinely good design and it is why ordinary runs are cheap.

It is also why some tests cannot be written at all.

A flow whose DOM is reshaped every release — a date picker that becomes a range control, a chart
library that re-renders differently on every load, a modal that appears only sometimes — produces
a pinned test that breaks constantly for reasons that have nothing to do with whether the feature
works. The self-healing machinery (Repair Policy, Repair Jobs, re-pinning) exists precisely
because of this and is real progress, but it is a repair loop around a brittleness that is
structural: the test is written in terms of *which element*, when what the author actually cares
about is *which state*.

There are journeys nobody on the team has managed to record reliably at all. They get tested by
hand, or not at all.

Separately, the authors of these tests already have a tool that is extremely good at "get this app
into this state" and that they are already paying for: their own Claude, on their own machine,
under their own Pro/Max subscription. Varys cannot use it. Varys's agent surfaces all assume a
Varys-hosted browser driven over `/mcp`, and its unattended paths assume either a Varys-held
Anthropic key (rejected repeatedly, and rejected again here) or a cloud Claude that can reach the
app under test. Neither helps the person sitting at a laptop who wants to say "run the analytics
dashboard test against staging" and watch it happen.

## Solution

**Agent-Driven Tests** — a second test kind that is authored as intent rather than as steps, and
executed by the author's own local Claude.

An Agent-Driven Test has no steps. It has **AI Instructions** at the test level (what app, which
account, credentials, what to ignore) and an **ordered list of Checkpoints**, each a row of
`name + instructions + comparison prompt`, typed by a person in a purpose-built editor. The rows
are **cumulative**: row 3's instructions assume rows 1–2 already happened, so one session walks the
list top to bottom and carries its own session state.

To run it, the author asks their local Claude. Claude connects to Varys over `/mcp`, starts an
**Agent Run Session**, and receives three things: the fully composed AI Instructions, the
**Checkpoint Manifest** (the closed, ordered set of slot names it must fill), and the approved
baseline images for the environment. It then drives the app **however it likes** — Varys provides
no browser, no perception layer, and no action tools, and never sees the driving. For each slot it
captures a screenshot, compares it to the baseline **contextually** (never pixel), and submits an
image, a verdict and a required reasoning. First run produces proposals a human approves; approval
per environment is the one gate, exactly as it is for pinned tests.

What makes the green trustworthy is that **Claude is never the one that says the run passed.**
Varys pre-seeds one `run_results` row per Manifest slot *before the session starts*; `submit`
rejects any name outside the Manifest; and `deriveRunOutcome` computes the run from those rows as
a pure function. An agent that quietly checks less leaves rows in `missing`, and the run is red —
whether it decided to skip, crashed, or its laptop lid closed. That is the specific answer to the
objection ADR 0004 raised and that this PRD does not otherwise refute.

The governing principle, and the reason the design is shaped the way it is:

> **The prompt carries intent. The system carries rules.**

Nothing that must hold is asked for in the prompt. The AI Instructions contain no rules at all —
only what app, which account, which journey, what to accept.

## User Stories

### Authoring an Agent-Driven Test

1. As a test author, I want to create a test that has no recorded steps, so that I can test a flow whose DOM is too unstable to pin.
2. As a test author, I want to write test-level AI Instructions naming the app, the account and the journey's context, so that every checkpoint inherits it without repetition.
3. As a test author, I want to put standing exceptions in those instructions ("dismiss the cookie banner if it appears", "ignore the What's New modal", "never click Delete"), so that incidental UI does not derail a run.
4. As a test author, I want to put login credentials in the instructions as plain text, so that the agent can reach auth-gated pages without me building a secret store.
5. As a test author, I want to add checkpoints one at a time in a purpose-built editor rather than a free-text document, so that each one is a real object with a name I can rely on.
6. As a test author, I want each checkpoint to carry its own navigation instructions, so that I describe only the increment from the previous state.
7. As a test author, I want each checkpoint to carry its own comparison prompt, so that I can say what must be true in *this* screenshot rather than in the test as a whole.
8. As a test author, I want to reorder checkpoints, so that I can restructure a journey without retyping it.
9. As a test author, I want to rename a checkpoint without losing its approved baselines, so that renaming for clarity is not punished.
10. As a test author, I want to delete a checkpoint and be told what that does to its baselines, so that I am not surprised by a silent loss of approvals.
11. As a test author, I want to edit instructions without creating a new test version, so that iterating on wording is not an audit event.
12. As a test author, I want an Agent-Driven Test to be active the moment I create it, so that I do not have to promote something I wrote myself.
13. As a test author, I want to see at a glance that a test is agent-driven rather than pinned, so that I understand why it has no steps.
14. As a test author, I want to file an Agent-Driven Test into folders and tag it like any other test, so that my corpus stays organised.

### Suite-level instructions

15. As a test author, I want to write AI Instructions on a suite, so that shared context (the app, the account, standing exceptions) lives in one place across many tests.
16. As a test author, I want suite instructions composed with the test's rather than overriding them, so that both apply and neither is silently discarded.
17. As a test author, I want to see the fully composed instructions before I run, so that I know exactly what the agent will be told.
18. As a test author, I want to be warned when a suite's AI Instructions would apply to no tests (because all its members are pinned), so that I do not write instructions that silently do nothing.

### Running

19. As a test author, I want to ask my own local Claude to run a named test against a named environment, so that I do not have to operate a Varys-hosted browser.
20. As a test author, I want the run billed to my own Claude subscription, so that no Anthropic API key is involved anywhere.
21. As Claude, I want to start an Agent Run Session and receive the composed AI Instructions, the Checkpoint Manifest and the approved baselines in one call, so that I have everything the run needs before I touch the app.
22. As Claude, I want complete freedom in how I drive the app — Chrome DevTools, Playwright, computer use, anything — so that I can use whatever works for this app today.
23. As Claude, I want complete freedom in how I capture a screenshot, so that I am not blocked by a capture contract my tooling cannot satisfy.
24. As Claude, I want to retry a state I could not reach, within the same session and at my own discretion, so that a transient failure does not become a red run.
25. As Claude, I want to submit an image, a verdict and my reasoning for a named slot, so that the run records what I saw and why I judged it so.
26. As Claude, I want to be refused when I submit under a name outside the Manifest, so that I cannot invent a checkpoint that keys no baseline.
27. As Claude, I want to attach as many extra screenshots as I like as run evidence, so that a reviewer can see what the page looked like when I struggled.
28. As Claude, I want to finish the session with a written summary, so that a human has a narrative alongside the per-slot verdicts.
29. As a test author, I want the run to appear in Varys's runs list like any other, so that agent-driven and pinned results live in one place.
30. As a test author, I want a run bounded by a server-side wall-clock lease, so that an agent grinding on an unreachable state cannot burn my subscription quota indefinitely.
31. As a test author, I want a lease-expired run to be red rather than cancelled, so that "the agent drove for ten minutes and could not get there" is treated as a finding, not as "nobody ran it".

### Baselines and comparison

32. As a test author, I want the first run to produce proposed baselines rather than a pass, so that nothing is ever verified against an image nobody approved.
33. As a test author, I want to approve proposed baselines per environment, so that staging and production keep their own goldens.
34. As a test author, I want a `pass` verdict on a slot with no approved baseline to stay `pending-baseline`, so that a first run cannot be talked into reporting success.
35. As a test author, I want every checkpoint compared contextually and never pixel-diffed, so that legitimately changing content does not produce noise.
36. As a test author, I want the agent's reasoning shown beside both images, so that I can judge the judgement.
37. As a test author, I want the capture conditions (tool, viewport, device scale) recorded beside each artifact, so that when a comparison looks strange I can see whether the two images were even taken the same way.
38. As a test author, I want a checkpoint added after the baselines were approved to be required immediately, so that new coverage takes effect when I add it rather than when I approve it.

### Outcomes and failure

39. As a test author, I want a run with an unfilled slot to be red, so that an agent that quietly checks less cannot report green.
40. As a test author, I want an unfilled slot to be red even if the agent crashed, disconnected, or never reported at all, so that the guarantee does not depend on the agent's cooperation.
41. As a test author, I want unreached checkpoints distinguished from failed comparisons in the run view, so that "could not get there" and "got there and it looked wrong" read differently.
42. As a test author, I want a failed comparison never to be auto-retried, so that a real regression the judge catches intermittently is not made to disappear.
43. As a test author, I want the run's outcome computed by Varys rather than reported by the agent, so that the thing being graded does not write the grade.
44. As a test author, I want a run with several unreached slots to show me one root cause rather than five independent failures, so that I can see that login broke rather than that four screens are missing.
45. As a test author, I want agent-driven runs included in the dashboard and runs list on the same footing as pinned runs, so that my corpus has one view.

### Forensics

46. As a test author, I want the fully composed AI Instructions copied onto every run, so that a run from six weeks ago is still explainable after all three layers have been rewritten.
47. As a test author, I want to diff two runs' composed instructions, so that "what changed?" is answerable when a test starts failing.
48. As a test author, I want the agent's session summary stored on the run, so that I have its account of what happened alongside the evidence.

### Boundaries

49. As a test author, I want to be told clearly that an Agent-Driven Test cannot join a suite or a schedule, so that I do not build a nightly suite that silently never runs.
50. As an operator, I want the agent to be unable to approve a baseline, so that the one human gate stays human.
51. As an operator, I want the agent to be unable to edit the test it is running, so that a red run cannot be resolved by rewriting the check.
52. As an operator, I want an unattended Repair Agent credential to be unable to start an Agent Run Session, so that nothing can sit in a run-and-retry loop until something goes green.

## Implementation Decisions

### The kind

- **`tests.kind`** is added — `'pinned'` (default, so every existing row is unchanged) and `'agent'`.
  This is the column [ADR 0004](../docs/adr/0004-brief-authored-tests-converge-no-agentic-kind.md)
  explicitly refused; see Further Notes for why it is now correct.
- **`tests.origin` stays `'human'`.** A person types every word of an Agent-Driven Test, so it is
  not AI-authored in the sense `origin` means. Overloading it would break the draft-queue filters
  that already read it.
- **No Draft, no Promote.** Draft exists to gate *a machine-written artifact* before a human trusts
  it; here there is none. The gate that does the work is baseline approval, which already exists and
  is already per-environment. Stated as a rule: *Promote reviews what was written; baseline approval
  reviews what was seen.*
- **Not suite-eligible, not schedule-eligible.** There is nothing that can run one unattended.
  This must be enforced (suite/schedule membership rejects `kind='agent'`) and surfaced in the UI,
  not merely documented.

### Storage

- **Test-level AI Instructions reuse `tests.intent`** — already "the durable statement of intent",
  already on `tests`, already surfaced in review UI.
- **New table `agent_checkpoints`** — `(id, test_id, position, name, instructions, compare_prompt)`,
  with a **unique index on `(test_id, name)`**. The uniqueness is load-bearing, not hygiene: the
  Manifest's closed-set property depends on it, and a database constraint holds it regardless of
  which code path writes.
  - `id` is stable across renames, so a rename carries its approved baselines with it rather than
    orphaning them. `baselines` is keyed by `checkpoint_name`, so a rename updates those rows.
- **New column for suite-level AI Instructions** on `suites`.
- **Unversioned by choice.** Instruction and checkpoint edits do **not** write a `test_version`.
  Iterating on wording is not an audit event.
- **One `test_versions` row per Agent-Driven Test, written at creation and never again.**
  `runs.test_version_id` is `NOT NULL REFERENCES test_versions(id)`; this keeps that FK and every
  join, dashboard and report that depends on it working unchanged, without introducing versioning.
- **New column on `runs`** holding the **fully composed AI Instructions text**, copied at session
  start. This is the compensating control for unversioned instructions: without it, a past run is
  unexplainable once its three layers have been edited.
- **New column on `runs`** holding the agent's **session summary**.
- All DDL follows the repo's idempotent-bootstrap rule (applied whole at boot; `IF NOT EXISTS` /
  `DO` guards; no backticks in the template literal).

### AI Instructions composition

- Three layers, composed **general → specific**: suite → test → checkpoint.
- **Concatenated, never overridden.** These are additive context ("here's the app" / "here's this
  journey" / "here's this state"), not competing settings; override semantics would need per-key
  structure that text does not have.
- **A test in two suites with contradictory instructions is the author's problem, made visible.**
  `baselines` has no suite in its key, so two suites pushing a test toward different states will
  diff against the same baseline and one will be permanently red. Handled by scoping suite
  instructions in the UI as *environmental context*, and by the composed-text-on-run making it
  diagnosable — **not** by adding suite to the baseline key, which would multiply every baseline and
  every approval by suite membership.
- Suite AI Instructions do not apply to pinned members, and the suite editor says so.

### The Agent Run Session — a reporting surface, not a driving one

Varys hosts **no browser** for this kind. The `/mcp` surface is:

- **`start_agent_run(testId, environmentId)`** → returns the composed AI Instructions, the ordered
  **Checkpoint Manifest**, and the approved baseline images for that environment (plus, per slot,
  whether a baseline exists at all). Pre-seeds the run's rows as a side effect (below).
- **`submit_checkpoint(name, image, verdict, reasoning)`** — `reasoning` **required**. Rejects any
  `name` not in the Manifest. Writes the artifact and fills the pre-seeded row.
- **`submit_evidence(image, note)`** — unlimited, unnamed, keys no baseline, attached to the run.
- **`finish_agent_run(summary)`**.

Not provided, and deliberately: `navigate`, `click`, `type`, `observe`, or any perception layer.
Claude's driving is its own business and Varys does not observe it.

**Capture is unconstrained.** Claude submits whatever image its tooling produced. `submit_checkpoint`
records **capture metadata** (tool, viewport, device scale) beside the artifact as *evidence, not a
constraint* — so a reviewer looking at a strange comparison can see whether the two images were
taken the same way. The known cost is accepted explicitly: a baseline captured headless at 1280×800
and an actual captured via computer use on a Retina display are genuinely different pictures, and a
contextual judge will say so.

### What makes a green trustworthy

Four mechanisms, none of which live in the prompt:

1. **Pre-seeded rows.** `start_agent_run` writes one `run_results` row per Manifest slot in a new
   **`missing`** review state, *before the agent does anything*. Skipping becomes unrepresentable:
   the row exists whether or not the agent ever runs, crashes, or reports.
2. **Closed Manifest.** `submit_checkpoint` rejects out-of-Manifest names, so the agent cannot
   invent a slot or drift a name between runs (`Dashboard loaded` vs `dashboard-empty` would
   otherwise make a test red forever for reasons unrelated to the app).
3. **`deriveRunOutcome` computes the outcome.** The agent has no tool that sets it. It can return
   `pass` four times and still get a red run because slot five is `missing`.
4. **A `pass` with no baseline is inert.** Such a slot stays `pending-baseline` regardless of the
   verdict, so a first run cannot be talked into a pass.

### Outcome semantics

- **New `ReviewState` member: `missing`.** Today's union is `"pending-baseline" | "diff" | "passed"`.
- **`deriveRunOutcome` gains a precedence rule for `missing`, ranked above `regression` and above
  `pending-baseline`.** Above `regression` because an unreached checkpoint means the journey broke,
  which is more urgent and more actionable than a pixel difference earlier in the flow. Above
  `pending-baseline` or a first run that reached nothing would read as "awaiting approval".
- **The `RunOutcome` union is not extended.** A run with `missing` rows is **`failed`**; every
  dashboard, matrix and suite report already handles the existing union. The *reason* goes in the
  existing **`runs.failure_kind`** column (today `'locator'` or `NULL`) as **`'unreached'`** — which
  is exactly what that column was added for, and makes agent failures filterable.
- A **lease-expired** session is `failed` / `'unreached'`, **not** `cancelled` — an agent that drove
  for ten minutes and could not reach a state has produced a finding about the app or the
  instructions.
- Consecutive unreached slots should be presented with **one root cause**, not five independent
  failures.

### Comparison

- **Always contextual, never pixel** — the existing `compareMode: 'context'` semantics, with the
  per-checkpoint `compare_prompt` playing the role `prompt` plays for a pinned `context` checkpoint,
  and the existing global default judge prompt from the Configurations page as the fallback when a
  row leaves it blank.
- **The driving session judges**, holding both images — not a fresh stateless judge. The known cost
  (an agent that just spent twenty tool calls reaching a state has a stake in the answer) is
  accepted, and the compensating control is that **`reasoning` is required and persisted** on every
  verdict — `run_results.judge_reasoning` already exists for exactly this. With the driver judging
  its own captures, the rationale is the entire audit trail.
- **`@varys/judge-engine` is not on this path.** Its `JudgeProvider`/`VisionJudgeTransport` seam
  exists to let Varys make a model call; here Varys makes none. The judgement arrives as a submitted
  verdict.

### Retries

- **No server-side retry.** Retrying is Claude's own business, within the one session, at its own
  discretion — it knows *why* it failed and can vary approach, where a blind replay only re-rolls
  the dice. "Try again if a state doesn't come up" is intent, so it belongs in the AI Instructions
  where it can be tuned per test.
- **Bounded by a server-side wall-clock lease**, configurable per test. Enforced by Varys, so it is
  a rule rather than a request; a step/action budget is a poor proxy because twenty cheap actions and
  twenty expensive ones cost wildly different amounts.
- A failed *verdict* is never retried by anything, ever — same principle `CONTEXT.md` already states
  for assertions: a false relation is evidence about the application, and re-rolling it until it
  agrees hides the exact bug the check exists to catch.

### Credential scope

- The existing **Repair Agent** credential gains a **per-capability run scope** rather than a new
  credential type — provisioning, hashing, expiry and revocation from
  [ADR 0005](../docs/adr/0005-scoped-repair-agent-credential.md) all apply unchanged, and a second
  type would double the management surface for no new property.
- **Default off.** An unattended drainer able to start runs could sit in a fix-and-retry loop until
  something went green — the exact behaviour `run_test`'s existing agent-credential refusal was
  built to prevent.

### Not applicable to this kind

- **`repair_policy`** — there are no locators to repair. Hidden in the UI for `kind='agent'`.
- **Assertions** — subsumed by the per-checkpoint comparison prompt.
- **`captureMode` (element/region/fullpage)** and masks — Varys does not perform the capture.
- **`environments.cookies` / `local_storage`** — these apply to a browser Varys controls. Login is
  via plaintext credentials in AI Instructions.

## Testing Decisions

A good test here asserts **external behaviour at the tool boundary** — what the MCP surface accepts,
refuses, and records, and what outcome Varys derives — and never how the agent drove, which Varys
cannot see and must not depend on. Two seams, only one of them new.

### Seam 1 — `deriveRunOutcome` (existing, pure unit)

`packages/review-contract/src/derive-run-outcome.test.ts` already exercises the precedence table as
a pure function over rows, with no IO. This is the **highest seam in the feature**: it is where "an
unreached checkpoint is red" is actually true. New cases:

- a `missing` row outranks a `diff` row → `failed`, not `regression`
- a `missing` row outranks a `pending-baseline` row → `failed`, not `pending-baseline`
- all slots filled and matched → `passed`, unchanged
- existing pinned-test cases unchanged (no regression in precedence)

### Seam 2 — the agent-run MCP tool layer (new, API E2E)

One new `apps/api/test/agent-run.e2e.spec.ts`, driving `start_agent_run` → `submit_checkpoint` →
`finish_agent_run` over `/mcp` with a **deterministic script and no live LLM** — the posture
`prd/claude-mcp-authoring.md` already establishes ("the MCP tool layer drivable by a deterministic
test script"). **Prior art:** `apps/api/test/run-test-tool.e2e.spec.ts` (an MCP tool whose value is
what it refuses to let a model conclude — including the `pending-baseline`-is-not-a-pass property and
the agent-credential refusal, both of which recur here) and `apps/api/test/authoring.e2e.spec.ts`.

This E2E is **chromium-free by construction**, because Varys hosts no browser for this kind: the
script POSTs PNG bytes exactly as the agent would. No `processRun`, no `fixture-app`, no Playwright —
unlike `context-compare.e2e.spec.ts`, which needs all three. Properties worth more than the happy
path:

- a slot never submitted → run is `failed` with `failure_kind: 'unreached'`, **not** `passed`
- the same, when the session simply stops reporting (lease expiry) and `finish` is never called —
  proving the guarantee rests on the pre-seeded rows, not on the agent's cooperation
- `submit_checkpoint` with a name outside the Manifest → refused
- `verdict: 'pass'` on a slot with no approved baseline → stays `pending-baseline`; run is
  `pending-baseline`, not `passed`
- `submit_checkpoint` without `reasoning` → refused
- a `fail` verdict on a slot with an approved baseline → `diff` → run is `regression`
- the composed AI Instructions (suite + test + checkpoint) are returned by `start_agent_run` and
  copied onto the run verbatim
- a Repair Agent credential without the run scope cannot call `start_agent_run`
- adding a suite or schedule member with `kind='agent'` is refused

### Seam 3 — `agent_checkpoints` CRUD (existing API E2E pattern, thin)

Folded into the above or a sibling spec, following `apps/api/test/tests.e2e.spec.ts`: ordering,
`(test_id, name)` uniqueness refusal, and **rename carries its baselines** (the one piece of CRUD
with a real invariant behind it).

### Manual click-through

The checkpoint-row editor, the AI Instructions editors, and the agent-driven run view are the
**manual gate**, consistent with every prior slice's review UI. No UI tests.

## Out of Scope

1. **Schedules and suites for Agent-Driven Tests.** Nothing can run one unattended; membership is
   refused rather than silently non-functional.
2. **The Agent Run Job queue** — claim, lease-as-ownership, drain, unclaimed states, suite fan-in
   with an unclaimed child. Designed and deliberately shelved: its justification was unattended work
   by a cloud Claude, and a local browser makes cloud claimers impossible. Add it when someone
   actually wants a scheduled agent test. Nothing in this slice blocks it — pre-seeded rows, the
   Manifest, `deriveRunOutcome` and the lease all sit underneath either front door unchanged.
3. **Cloud Claude execution.** Follows from (2).
4. **A Varys-hosted browser for this kind**, and therefore `environments.cookies`/`local_storage`
   reuse, Varys-side capture normalisation, masks, and `captureMode`.
5. **A secret store.** Credentials are plaintext in AI Instructions by explicit decision.
   Consequences accepted: they appear in the model's context and in any relayed event stream.
6. **Letting an Authoring Session propose the checkpoint list and instructions** — Claude explores
   your app and drafts the plan, which you then edit. Genuinely useful and the obvious follow-on,
   and it *would* reintroduce Draft/Promote, because a machine would then have written the artifact.
7. **Converting between kinds** — pinning an Agent-Driven Test, or unpinning an existing test.
8. **Assertions, Repair Policy, Repair Jobs and Triage Jobs for this kind.**
9. **Pixel comparison for this kind**, in any configuration.
10. **In-product chat** — the Bridge Helper's "Author with AI" surface is untouched; this is driven
    from the author's own Claude Code.

## Further Notes

### Two ADRs are owed

**ADR 0006 — Agent-driven tests exist; ADR 0004 is reversed in part.** A future reader will find
ADR 0004 stating flatly *"there is no agentic test kind"* and then find `tests.kind = 'agent'`. The
honest account is the interesting one: ADR 0004 gave two reasons, and only one of them was
dissolved. **Cost** is gone — execution is local, on the author's own subscription, so Varys pays
nothing per run and the "agent session per test per environment per schedule, forever" objection
does not apply. **Silent skipping was never refuted**; it was engineered around, by the Checkpoint
Manifest, the pre-seeded `missing` rows, and `deriveRunOutcome` computing the outcome from rows the
agent cannot write. The ADR should also record what the reversal cost: no suites, no schedules, no
unattended runs — which is precisely the scope ADR 0004's objection still governs.

**ADR 0007 — Varys does not host the browser for an agent-driven run.** Every other agent surface
here is a Varys-hosted Playwright session, chosen deliberately in ADR 0001 (and its A1
perform-then-capture path). This inverts it. A reader will want to know why the established pattern
was abandoned and what was knowingly traded: comparability of artifacts across runs, the
`environments.cookies` login path, any possibility of a cloud claimer — in exchange for the agent
using whatever tooling actually works on the app in front of it, and for reaching apps that Varys's
server cannot (localhost, VPN).

### The one-line summary of the safety design

Every rule that must hold is enforced on Varys's side of the wire, by code or by a database row,
and none of it is asked for in the prompt:

| Rule | Enforced by |
|---|---|
| Only Manifest names may be submitted | `submit_checkpoint` rejects the call |
| An unreached checkpoint is red | rows pre-seeded in the DB before the agent starts |
| The run's outcome | `deriveRunOutcome`, a pure function over rows |
| A session cannot grind forever | a server-side wall-clock lease |
| A first run cannot be a pass | a `pass` with no baseline stays `pending-baseline` |
| Baselines get approved | a human |

### Known weak point, stated plainly

The driving session judges its own captures (a deliberate choice), and capture is unconstrained
(also deliberate). Together these mean the *quality* of an agent-driven verdict rests on the
comparison prompt and on the agent's candour, with `reasoning` as the audit trail and human
baseline approval as the gate. What the design guarantees is narrower and harder: **an
agent-driven run cannot report a green for work it did not do.** That is the guarantee ADR 0004's
objection demanded, and it is the one worth defending.
