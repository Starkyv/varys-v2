# Varys

Visual-regression test automation: record → baseline → rerun → compare, with an
optional Claude/MCP layer that can author tests by driving a live browser session.

## Language

**Authoring Session**:
A live, server-side Playwright browser session that Claude drives (via the MCP server)
to author a test — perceiving the page and performing actions while Varys captures the
resulting steps. Distinct from a Run, which replays an already-saved test.
_Avoid_: live session, recording session (when Claude-driven)

**Run**:
A server-side replay of a saved test against one environment, producing checkpoint
diffs against the approved baseline.
_Avoid_: execution, playback

**Checkpoint**:
A named screenshot target within a test whose image is diffed against a per-environment
baseline. The unit of visual review.
_Avoid_: snapshot, assertion

**Repair Session**:
A live, server-side Playwright browser session that re-drives an EXISTING test — with the same
drive a Run uses — to the step in question and parks there, so the test can be diagnosed and
edited against the page it actually faces. It records nothing: every change is written onto the
existing test as a new audited version. Distinct from an Authoring Session, which records a new
test into a Draft.
_Avoid_: debug session, fix session

**Draft**:
An AI-authored test that has not yet been promoted — a first-class test with a full
definition, but excluded from suites and schedules and surfaced in a review queue until a
human accepts it. (Human-recorded tests are active on create and are never drafts.)
_Avoid_: staging test, pending test

**Promote**:
The human action that accepts a Draft: assign it a folder + tags and make it active
(eligible for suites and schedules). Distinct from baseline approval, which remains a
separate per-environment gate.
_Avoid_: publish; approve (reserved for baseline/checkpoint approval)

**Bridge Helper**:
A small process the user runs locally that launches the Claude authoring agent (Claude
Agent SDK) under their **own** Claude subscription and relays its conversation + tool
activity to the Varys web app — so in-product authoring is billed to the user's
subscription, not Varys. Distinct from the Authoring Session (the server-side browser it
drives).
_Avoid_: agent, daemon, connector

**Author with AI**:
The in-product authoring surface: a chat inside the Varys web app that drives an Authoring
Session through the user's Bridge Helper, with a live browser preview. Distinct from
connecting your own Claude Code directly to the public MCP server.
_Avoid_: AI mode, copilot

**Brief**:
The author's natural-language statement of what a test should do and check. It is the durable
statement of intent: it produces the test in an Authoring Session, and any later repair must
still satisfy it. Stored on the test (`tests.intent` today). Distinct from a checkpoint's
judge **prompt**, which is what the judge looks for in one screenshot.
_Avoid_: prompt, script, scenario, agentic test

**Assertion**:
A named check on a test that no single screenshot can express — typically a comparison between
two things on the page, or across pages ("the revenue KPI equals the sum of the Revenue
column"). Declared with a stable id so it has its own pass/fail history, the way a checkpoint
name keys a baseline. Once **pinned**, an assertion is *data, never code*: which fingerprints
to read, how to coerce each, and which relation to apply, from a vocabulary Varys owns — so
the worker evaluates it exactly, with no model call and nothing model-authored executing.
Assertions the vocabulary cannot express fall back to the vision judge, and the author is told
which ones did. Distinct from a **Checkpoint**, which is an image compared to a baseline.

A failing assertion fails the run, and *how* it failed decides who owns it. **Extraction
failed** — a side produced no value, because its target no longer resolves — is a *locator*
failure: the app was never asked the question, so it cannot have answered wrongly, and it is
repairable exactly like a broken step locator. **Relation false** — both values were read and
they disagree — is evidence about the *application*, and is never repairable, under any Repair
Policy, at any breaker threshold, by any agent: the only way to "repair" it is to re-pin until
the numbers agree, which hides the exact bugs assertions exist to catch. It earns a Triage Job.
_Avoid_: check, expectation, validation

**Pin**:
Recording what Claude decided while driving — the steps it walked, the multi-signal Fingerprint
of every element it chose, and how each Assertion is to be evaluated — so ordinary runs resolve
all of it in the worker with no model call. Pinning is what makes a brief-authored test an
ordinary test. Distinct from **baseline approval**, which is about the image, not the target.
_Avoid_: cache, lock, freeze

**Repair Policy**:
Per-test setting for what happens when a run fails on a locator it cannot resolve: `manual`
(surface it for a human to open a Repair Session, today's behaviour) or `auto` (enqueue a
Repair Job). Applies to every test, however it was authored — a hand-recorded test can
self-heal too.
_Avoid_: self-heal mode, AI mode

**Repair Job**:
A queued request for a cloud Claude to repair one broken test, created by Varys when a run
fails a locator under an `auto` Repair Policy. Varys owns the queue, the browser and the
audit trail; the user's cloud Claude **claims** the job over `/mcp`, drives a Repair Session,
and re-pins. Distinct from a **Run**, which Varys executes itself.
_Avoid_: repair task, healing run

**Triage Job**:
A queued request for a cloud Claude to *diagnose* a failure it may not fix — a pixel
regression, a failed judge, a false assertion, a crash. Claude drives to the failure, looks,
and writes a finding onto the run; it may not edit the test and may never approve a baseline.
The run stays red. Distinct from a **Repair Job**, which changes the test.
_Avoid_: investigation, analysis, RCA

**Claim**:
A cloud Claude taking exclusive ownership of one queued Repair or Triage Job over `/mcp`,
which binds it to that job's Repair Session. The queue is project-wide and first-claim-wins:
any member's cloud Claude may drain it, and the job records who claimed it, so a repaired
version is attributed to that member. A claim is a lease — it expires if the claimer stops
reporting, and the job returns to the queue with one more attempt spent. A job that spends every
attempt without a repair is abandoned rather than re-offered forever.
_Avoid_: lease, pick up, assign

**Healed**:
A run outcome: everything the test checks verified cleanly, but reaching it required re-pinning
a locator that no longer resolved. Amber — outranked by `regression` and `failed`, outranking
`passed`. Operationally it is a queue item, not an alarm: it does not fail a suite, and it
stays in the review queue until a human accepts the repaired version. Extends the existing
locator-level sense of healed (`LocatorVerifyResult.healed`) to the whole run.
_Avoid_: self-healed, auto-fixed, warning

**Failure Cluster**:
A group of queued job-triggering failures that share one root cause — the same locator
signature stopped resolving across many tests. Repaired once, reviewed once, applied across
the cluster as a single change, rather than N independent repairs that can diverge.
_Avoid_: batch, group

**Circuit Breaker**:
The threshold above which auto-repair is suppressed entirely and an alert is raised instead:
when too many tests fail at once, the app is broken or was redesigned — a human decision —
not a corpus that has drifted. Protects against auto-repairing the whole test corpus into
agreement with a broken deploy.
_Avoid_: kill switch, rate limit

**Repair Agent**:
A provisioned, revocable, expiring service credential that lets an unattended process
authenticate to `/mcp` and drain the job queue. It resolves to a real service principal
(`agent:…`), not to an anonymous exemption, so ownership checks and attribution work unchanged;
its safety comes from **scope** — it may claim jobs and repair within them, and may never open
an Authoring Session, edit tests outside a claimed job, or approve a baseline. Distinct from
the **Bridge Helper**, which is attended and carries a human's own Claude login.
_Avoid_: service account, API key, bot user
