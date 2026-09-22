# Varys

Visual-regression test automation: record → baseline → rerun → compare, with an
optional Claude/MCP layer that can author tests by driving a live browser session.

## Language

**Authoring Session**:
A live, server-side Playwright browser session that Claude drives (via the MCP server)
to author a test — perceiving the page and performing actions while Varys captures the
resulting steps. Distinct from a Run, which replays an already-saved test.

There is exactly one way to drive it: Claude is given the whole **Brief** up front, walks it end
to end, and ends the session itself. There is no step-by-step way to author and nothing for the
author to stop — a session that has run out of brief is over.
_Avoid_: live session, recording session (when Claude-driven), interactive mode, batch mode

**Run**:
A server-side replay of a saved test against one environment, producing checkpoint
diffs against the approved baseline.

A Run carries its own write-once copy of the definition it replayed. The test has one definition
and no history, so the Run is the only place the past stays legible — which step it walked, which
one failed, and the page that failure faced. The copy is *evidence*: nothing reads it as the test
and nothing can be restored from it.
_Avoid_: execution, playback

**Checkpoint**:
A named screenshot target within a test whose image is diffed against a per-environment
baseline. The unit of visual review.
_Avoid_: snapshot, assertion

**Repair Session**:
A live, server-side Playwright browser session that re-drives an EXISTING test — with the same
drive a Run uses — to the step in question and parks there, so the test can be diagnosed and
edited against the page it actually faces. It records nothing: every change is written onto the
existing test **in place** — a test is one definition, with no versions behind it and nothing to
roll back to. The page it re-drives comes from the failing **Run**'s own copy, which is what lets
it face the page that actually broke rather than the test as it stands today. Distinct from an
Authoring Session, which records a new test into a Draft.
_Avoid_: debug session, fix session

**Draft**:
An AI-authored test that has not yet been promoted — a first-class, runnable test surfaced in a
review queue until a human accepts it. For an ordinary test it is also held out of suites and
schedules. An **Agent-Driven Test** is barred from both whatever its status, so Draft does
something else for that kind: it is the only status Claude may write to, which makes **Promote**
the moment a test passes out of Claude's reach and into its author's.
(Human-authored tests are active on create and are never drafts.)
_Avoid_: staging test, pending test

**Needs Review**:
A *state*, never a place. A **Checkpoint** whose image awaits a human decision (`pending-baseline`
or `diff`, unresolved) and, derived from it, a **Run** outcome. It is decided on the Run itself —
there is no queue page that lists it, and the count of what is waiting is not something Varys
reports. The only queue page is the **Review queue**, which holds **Drafts** awaiting **Promote**
and can no more approve a baseline than a Promote can.
_Avoid_: review queue (that names the Draft queue), needs-review page, approval queue

**Promote**:
The human action that accepts a Draft: assign it a folder + tags and make it active
(eligible for suites and schedules). Distinct from baseline approval, which remains a
separate per-environment gate.
_Avoid_: publish; approve (reserved for baseline/checkpoint approval)

**Bridge Helper**:
A small process the user runs locally that launches Claude (Claude Agent SDK) under their
**own** Claude subscription and relays its conversation + tool activity to the Varys web
app — so what it does is billed to the user's subscription, not Varys. It launches Claude
for two jobs: authoring a test, and walking an **Agent-Driven Test** when the person
presses Run in Varys. Varys reaches it by pushing a command down a channel the helper
itself opened, which is why running one is something the user can stop at any moment.
Distinct from the Authoring Session (the server-side browser it drives).
_Avoid_: agent, daemon, connector

**Author with AI**:
The in-product authoring surface: a chat inside the Varys web app that drives the user's Bridge
Helper. Producing an ordinary test, it drives an **Authoring Session** and shows a live browser
preview; producing an **Agent-Driven Test**, it drives nothing — Claude explores the app with its
own local tooling and Varys sees only the prose it writes. Distinct from connecting your own
Claude Code directly to the public MCP server.
_Avoid_: AI mode, copilot

**Brief**:
The author's natural-language statement of what a test should do and check. It is the durable
statement of intent: it produces the test in an Authoring Session, and any later repair must
still satisfy it. Stored on the test (`tests.intent` today). Distinct from a checkpoint's
judge **prompt**, which is what the judge looks for in one screenshot. A Brief is either
**pinned** into steps and fingerprints (an ordinary test) or left unpinned and re-walked every
run (an **Agent-Driven Test**).
_Avoid_: prompt, script, scenario

**Assertion**:
A named check on a test that no single screenshot can express — typically a comparison between
two things on the page, or across pages ("the revenue KPI equals the sum of the Revenue
column"). Declared with a stable id so it has its own pass/fail history, the way a checkpoint
name keys a baseline. Once **pinned**, an assertion is *data, never code*: which fingerprints
to read, how to coerce each, and which relation to apply, from a vocabulary Varys owns — so
the worker evaluates it exactly, with no model call and nothing model-authored executing.
Assertions the vocabulary cannot express fall back to the vision judge, and the author is told
which ones did — every assertion is labelled **exact** (pinned) or **approximate** (judged),
because an approximate check wearing an exact one's clothes is how someone finds out months
later that a total was never really being verified. Distinct from a **Checkpoint**, which is an
image compared to a baseline.

A failing assertion fails the run, and *how* it failed decides who owns it. **Extraction
failed** — a side produced no value, because its target no longer resolves — is a *locator*
failure: the app was never asked the question, so it cannot have answered wrongly, and it is
repairable exactly like a broken step locator. **Relation false** — both values were read and
they disagree — is evidence about the *application* and is never repairable: the only way to
"repair" it is to re-pin until the numbers agree, which hides the exact bugs assertions exist to
catch. It is reported and left red. A **judged fail** is the same rule with softer evidence and
the same consequence. A judge that could not be reached at all is the one outcome that is neither
a pass nor a failure: nothing was checked, so the run goes **Needs Review** and claims nothing
either way — a model outage must never read as a green.
_Avoid_: check, expectation, validation

**Pin**:
Recording what Claude decided while driving — the steps it walked, the multi-signal Fingerprint
of every element it chose, and how each Assertion is to be evaluated — so ordinary runs resolve
all of it in the worker with no model call. Pinning is what makes a brief-authored test an
ordinary test. Distinct from **baseline approval**, which is about the image, not the target.

An assertion's pin is *verified against the live page before it is stored*, and the two ways that
can go wrong are not alike. A side that cannot be READ means the pin is broken, and it is refused —
storing it would author a check that has never once evaluated. A pin that reads both values and
finds they DISAGREE is correct, and the page is not: it is stored as written and reported. This is
the same rule as **Assertion**'s "a false relation is never repairable", one moment earlier — rewording a check at
authoring time until the app agrees with it hides exactly the bug the check was for.
_Avoid_: cache, lock, freeze

**Agent-Driven Test**:
A test with no steps and no fingerprints: an ordered list of Checkpoints, each carrying how to
reach it and what to accept, which a locally-run Claude re-walks in full on every Run. Its
checkpoints are always compared **contextually** — never pixel-diffed. It is never executed by
the worker, so it cannot belong to a suite or a schedule. Its Checkpoints and **AI Instructions**
are written either by a person in the editor or by Claude through **Author with AI**, which
produces it as a **Draft**. Distinct from an ordinary test, whose behaviour is pinned data the
worker replays with no model call.
_Avoid_: agentic test, prompt test, AI test

**Checkpoint Manifest**:
The closed set of checkpoint names an Agent-Driven Test's Run must produce — the test's
**authored** checkpoints, in order. Handed to the agent when its **Agent Run Session** starts; the
capture tool accepts no name outside it, and a Run that leaves a slot unfilled is red. It is what stops
an agent that re-decides its path from quietly checking less and still reporting green. A slot
whose environment has no approved baseline yet is not a failure but a **proposal**: it is still
required to be produced, and what it produces awaits human approval.
_Avoid_: checklist, contract, expected checkpoints

**AI Instructions**:
The natural-language context an agent is given for a Run, composed general-to-specific from
three layers — **suite**, **test** (the Brief's preamble), then the **checkpoint**'s own — and
concatenated, never overridden, because the layers are additive context rather than competing
settings. They are environmental, not behavioural: what app, which account, what to ignore.
Credentials live here as plain text by deliberate choice. Because instructions are edited in
place, the fully composed text is **copied onto the Run**, so a Run stays explainable after every
layer has been rewritten.
_Avoid_: prompt, system prompt, context

**Unreached**:
A Checkpoint Manifest slot a Run was required to fill and never did. Written as the checkpoint
review state `missing` — the rows are seeded before an agent starts, so the state survives an
agent that skipped, crashed or never reported — and surfaced on the Run as `failure_kind`
`unreached`. The Run is **failed**, outranking `regression` and `pending-baseline` both: a
journey that broke is more urgent than a pixel that moved, and a Run that reached nothing is not
"awaiting approval". Distinct from a **judged fail**, where the agent got there and the state was
wrong; nothing was compared here at all.
_Avoid_: skipped, not captured, incomplete

**Agent Run Session**:
One execution of an Agent-Driven Test, started by a person asking their own local Claude to run
it — directly, or by asking Varys to ask it (the Run control on the test, which reaches their
paired **Bridge Helper**). Either way it is still their Claude, their machine and their
subscription; what differs is only which finger starts it. Varys supplies no browser and sees no
driving: Claude reaches each state with whatever it judges best — Chrome DevTools, Playwright,
computer use — and captures however it likes.
Varys's surface is **reporting, not driving**: it hands over the composed AI Instructions, the
Checkpoint Manifest and the approved baselines, and takes back an image, a verdict and a
reasoning per slot. What Claude may not do is the bookkeeping it would be grading itself on:
approve a baseline, set the Run's outcome, or submit under a name outside the Manifest.
Distinct from an Authoring Session (which records into a Draft) and a Repair Session (which
edits an existing test) — both of which are Varys-hosted browsers.
_Avoid_: agent session, run session, execution session

**Run Request**:
A press of the Run control on an Agent-Driven Test: Varys asking a person's paired **Bridge
Helper** to start an **Agent Run Session**. It creates nothing — no Run, no reservation, no row —
so it is not a Run in a pending state; it is the ask itself, held only in memory and only for as
long as it has left. It ends in one of three ways: **acknowledged** (the helper says it has
launched Claude), **fulfilled** (an Agent Run Session for that test was started, which is what
was actually wanted), or **lapsed** (neither happened inside its bound, so Varys says plainly
that it asked and cannot say whether anyone listened). One request at a time per person per test,
refused by the relay rather than by a disabled button, so two browser tabs cannot each start a
session on the same machine. It reserves nothing and leaves nothing behind when it lapses. A fulfilled one leaves
exactly one trace: the **Run** it was answered by records that it came from Varys rather than from
someone typing to their own Claude — evidence for a reader, which nothing else reads.
_Avoid_: pending run, queued agent run, reservation

**Wall-Clock Lease**:
The bound on an Agent Run Session: how long it may run before Varys closes it, set per test with
a modest default and enforced **server-side**, so it is a rule rather than something the AI
Instructions ask for. Wall-clock rather than a tool-call budget, because twenty cheap actions and
twenty expensive ones cost wildly different amounts and it is the author's own Claude
subscription being spent. Retrying a state it could not reach stays the agent's own business —
this only stops an agent retrying one that will **never** appear. On expiry the session is closed
and every further submission refused; whatever slots are still unfilled have been `unreached`
since they were seeded, so the Run is **failed**, not **cancelled** — an agent that drove for ten
minutes and could not get there has found something out. It expires to STOP the work; nothing
picks it up afterwards.
_Avoid_: timeout, budget, deadline, TTL

**Healed**:
A property of one **step**, not of a Run: the scored matcher could not confidently resolve a
checkpoint's element, so the run fell back to the recorded deterministic CSS path and captured
through that. Transient — it is flagged on the step of that one Run and written nowhere near the
test — and marked in the run timeline. Only checkpoints heal; a click has no fallback, because a
wrong region is cheap and a wrong click is not.

A Run with a healed step still reads **passed**: the marker on the step is the whole report. There
is no run-level `healed`, and no amber for "green, but on a locator that didn't really match".
_Avoid_: self-healed, auto-fixed, warning, healed run

**Capture**:
The image an agent submits as the evidence for one **Checkpoint** — the picture of a state it
actually reached. It is evidence, never a golden: a Capture is stored as the reference behind a
Manifest slot or as a proposal awaiting approval, and only a human turns one into a baseline.

Distinct from the screenshot an agent takes to *perceive* the page (an authoring session's
`observe(screenshot: true)`, or whatever tooling an agent-driven walk uses to look at what is in
front of it), which records nothing in the test and is evidence of nothing. The same picture can
serve both, but they are different claims — one says "this is what the page looks like to me right
now", the other says "this is what a human should review, and may approve".
_Avoid_: screenshot, shot, image, snapshot
