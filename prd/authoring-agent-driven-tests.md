# PRD — Authoring Agent-Driven Tests with Claude

> **Author with AI** gains a second output. Today it can only produce a pinned test; after this it
> can produce an **Agent-Driven Test**, written as a **Draft** by the author's own Claude, which
> explores the app with its own local tooling and submits one **Checkpoint** per state it actually
> reached — with the screenshot proving it got there.
>
> **Draft and Promote return for this kind.** `prd/agent-driven-tests.md` removed them because
> "Draft exists to gate *a machine-written artifact* before a human trusts it; here there is none".
> A machine now writes the artifact, so the gate comes back — and it earns a second job it did not
> have before: it is the only thing the authoring tools are allowed to write to.
>
> Vocabulary is `CONTEXT.md`'s and has been updated there in place: **Draft**, **Author with AI**
> and **Agent-Driven Test**.

---

## Problem Statement

Writing an Agent-Driven Test is entirely manual. Every word is typed into the editor by a person:
the test-level **AI Instructions**, then each **Checkpoint**'s name, how to reach it, and what
counts as matching its baseline. For a six-screen journey that is a page of careful prose, and it is
prose with an unusual property — a model has to act on it later, so an ambiguity that a human reader
would skate over becomes a run that goes somewhere else entirely.

The author is also writing blind. They are describing states from memory, in an app that may have
moved since they last looked, in wording they cannot test until a run spends their Claude
subscription quota finding out. The failure modes are quiet and expensive: a Checkpoint nobody can
actually reach is **unreached** forever, and because the **Checkpoint Manifest** is a closed set, the
only fix is to go back and edit the test. A comparison prompt that is too loose passes everything; too
tight and it fails on legitimate change. None of this is visible until the first run.

Meanwhile Varys already has the surface that would solve it. **Author with AI** — a chat in the web
app, driving the user's **Bridge Helper**, billed to their own Claude subscription — explores the app
and writes a test. It can only write *pinned* tests: the kind whose DOM has to be stable enough to
record, which is precisely the kind that does not work for the flows Agent-Driven Tests exist for. So
the one surface that could draft the hard tests is the one that cannot produce them.

The gap is narrow and specific. Claude is already trusted to *walk* an Agent-Driven Test and judge
every Checkpoint in it. It is not permitted to write one down.

## Solution

**Author with AI produces an Agent-Driven Test as a Draft.**

The author picks the kind before the chat opens, because the two paths share no mechanism and the
choice has to be made before the first tool call. It is a **steer, not an enforcement**: it decides
what Claude is told to author, and Varys refuses nothing on the strength of it. For an Agent-Driven Test, Claude drives nothing of
Varys's: it explores the app on the author's own machine with whatever tooling suits it, exactly as it
does during an **Agent Run Session**, and Varys never observes the driving. What Varys receives is
prose and pictures.

Claude creates the Draft with its authored AI Instructions, then adds Checkpoints one at a time. Each
Checkpoint carries a screenshot of the state, and **Varys refuses the Checkpoint without one**. That
refusal is the load-bearing part. A Checkpoint invented from a description reads identically to one
Claude actually reached — same prose, same confidence — and the reviewer has no way to tell them
apart. Requiring the image makes "a Checkpoint I wrote but never reached" unrepresentable, in the same
way pre-seeded rows make silent skipping unrepresentable during a run. It is a rule Varys enforces,
not something asked for in a prompt.

The result lands in the Drafts review queue. The reviewer reads the AI Instructions and the ordered
Checkpoints against the pictures Claude captured, then **Promotes** it with a folder and tags — or
deletes it. Baselines are untouched by all of this: the authoring captures are reference images, never
goldens, and the first **Run** still produces the proposals a human approves. The one human gate stays
exactly where it was.

Two boundaries make the surface safe rather than merely useful:

- **The authoring tools write only to Drafts.** Once a test is promoted it is `active`, and no MCP
  tool can touch it again — editing is the author's, in the editor. Because a test being run is by
  definition promoted, "the agent cannot edit the test it is running" stops being a rule anyone has to
  remember and becomes structurally true.
- **Only a human principal may author.** An agent credential is refused outright, with no capability
  to grant. Running has a legitimate unattended case, which is why the run capability exists at all.
  Authoring has none, and an unattended agent that can write tests can write tests that pass.

## User Stories

### Choosing the kind

1. As a test author, I want to choose whether Author with AI produces a pinned test or an Agent-Driven Test before the chat opens, so that the session's tools are fixed before the first one is called.
2. As a test author, I want that choice explained in terms of what it costs me, so that I understand an Agent-Driven Test spends my Claude subscription on every future run where a pinned test replays free.
3. As a test author, I want the choice to be mine rather than Claude's, so that a recurring cost is never incurred on my behalf by a judgement I did not make.
4. As a test author, I want to be unable to switch kinds mid-conversation, so that I never end up with a half-recorded, half-written artifact.

### Authoring

5. As a test author, I want Claude to explore my app with its own local tooling, so that it can reach a dev server, a VPN'd staging or an SSO session that only my machine can see.
6. As a test author, I want Claude to write the test-level AI Instructions for me, so that the app, the account and the standing exceptions are captured without my typing them.
7. As a test author, I want Claude to add one Checkpoint per state it reached, in journey order, so that the Checkpoint Manifest describes a walk that actually happened.
8. As a test author, I want each Checkpoint to carry its own instructions describing only the increment from the previous state, so that the cumulative shape of the journey is preserved.
9. As a test author, I want each Checkpoint to carry its own comparison prompt, so that what must be true in that screenshot is stated where it applies.
10. As a test author, I want Claude to be refused when it submits a Checkpoint without a screenshot, so that it cannot write down a state it never reached.
11. As a test author, I want each Checkpoint written as its own call rather than the whole test in one, so that the prose for the twelfth Checkpoint is as considered as the prose for the first.
12. As a test author, I want an abandoned authoring pass to leave a visibly incomplete Draft rather than a convincing-looking one, so that I can see what Claude got to and what it did not.
13. As a test author, I want the Draft to be created the moment Claude starts rather than at the end, so that a crashed session does not throw away the work that was done.
14. As a test author, I want Claude to be refused a duplicate Checkpoint name within one test, so that the Manifest's closed-set property holds however the test was written.
15. As Claude, I want to be told plainly that Varys hosts no browser for this kind, so that I do not wait for perception tools that are never coming.
16. As Claude, I want to be told that my Checkpoint names become a closed set nothing can add to at run time, so that I name them carefully rather than provisionally.

### Reviewing and promoting

17. As a reviewer, I want a machine-written Agent-Driven Test to arrive as a Draft, so that nobody's prose becomes a standing test without a human reading it.
18. As a reviewer, I want to read the AI Instructions Claude authored in full, so that I can check what every future run will be handed — including the credentials in it.
19. As a reviewer, I want to see each Checkpoint beside the screenshot Claude captured for it, so that I can judge the prose against evidence rather than on trust.
20. As a reviewer, I want a Draft of this kind to show its real Checkpoint count, so that a test with eight Checkpoints does not read as asserting nothing.
21. As a reviewer, I want a zero-Checkpoint Draft of this kind described accurately, so that I am told it cannot run at all rather than that it will run and catch nothing.
22. As a reviewer, I want the panels that only make sense for a pinned draft to be absent rather than empty, so that a missing step list does not read as a missing artifact.
23. As a reviewer, I want to promote the Draft with a folder and tags, exactly as I promote a pinned one, so that my corpus stays organised however a test was written.
24. As a reviewer, I want to delete a Draft I do not want, so that a bad authoring pass costs nothing but the time it took.
25. As a reviewer, I want to run a Draft before promoting it, so that I can find out whether Claude's Checkpoints are reachable before I accept them.
26. As a reviewer, I want to edit a Draft in the ordinary editor before promoting it, so that I can fix a wording problem without asking Claude to start again.

### Boundaries

27. As an operator, I want the authoring tools to refuse any test that is not a Draft, so that Claude cannot rewrite a test that is already in service.
28. As an operator, I want the agent to remain unable to edit the test it is running, so that a red run still cannot be resolved by rewriting the check.
29. As an operator, I want an agent credential to be refused authoring outright, so that nothing unattended can write a test and then pass it.
30. As an operator, I want that refusal to have no capability that could grant it, so that it is not one provisioning mistake away from being true.
31. As an operator, I want the agent to remain unable to approve a baseline, so that the one human gate is unaffected by any of this.
32. As a test author, I want authoring captures to be reference images and never goldens, so that "the first run produces proposals rather than a pass" still holds.

### Forensics and honesty

33. As a reviewer, I want to know a test was written by Claude rather than by a person, so that I read it with the right amount of suspicion.
34. As a test author, I want the AI Instructions on the test to be the ones Claude authored, so that the prose handed to every run is the artifact and not the request that produced it.
35. As a test author, I want to preview the fully composed instructions before running a promoted test, so that I can see what three layers assembled out of sight produced.
36. As a test author, I want an authored test to behave in every other respect like one I typed myself, so that nothing downstream has to know how it came to exist.

## Implementation Decisions

### The surface

- **Author with AI gains a kind selector**, presented before the session opens. There is no
  mid-session switch, and the pinned path is untouched.
- **The selector steers; it does not enforce.** `/mcp` filters tools by *principal*, not by session,
  and authoring deliberately has no session object to hang a mode on. So the choice decides what
  Claude is told to write, not what Varys will refuse. That is the right place for it: by ADR 0006
  the prompt carries intent and the system carries rules, and "which kind am I authoring" is intent —
  nothing downstream depends on it, because authoring the wrong kind produces a Draft a reviewer
  reads and deletes. Enforcing it would mean reintroducing the session state this design removed.
- **The Bridge Helper path is unchanged.** The model still runs locally under the user's own
  subscription and reaches Varys over `/mcp`. Only the tools it is given differ.
- **No Authoring Session is opened for this kind, and there is no live browser preview**, because
  there is no Varys-hosted browser to preview. The Author surface shows the conversation and the
  Checkpoints as they arrive.

### No server-side browser, extended from runs to authoring

- ADR 0007 established that Varys hosts no browser for an agent-driven **run**. That posture extends
  to **authoring** this kind, for two of the same three reasons: the app under test is often reachable
  only from the author's machine, and fixing the driving to one Playwright reduces "whatever works" to
  "whatever Playwright can do".
- ADR 0001's reason for putting the browser server-side does **not** apply here and is not being
  reversed. That argument is about fingerprints — a step is only worth recording if it was captured by
  the same code the human recorder uses. An Agent-Driven Test records no steps and captures no
  fingerprints, so there is nothing for a shared recorder core to produce.
- **Consequence accepted:** Varys attests to nothing about how the app was explored. The evidence a
  Draft carries is the prose and the submitted screenshots, exactly as a run's evidence is.

### The write surface — the Draft is the accumulator

- **Two MCP tools, both human-principal-only and both Draft-scoped:**
  - **create an Agent-Driven Test** — name and authored AI Instructions in, a test id out, written at
    `status: draft`, `kind: agent`, `origin: ai`.
  - **add a Checkpoint** — test id, name, instructions, comparison prompt and a **required** PNG.
- **No session object and no finish step.** The run surface has one because the pre-seeded rows must
  let Varys call a run red without the agent's cooperation; authoring protects no equivalent guarantee,
  so a session would be state Varys holds for nothing. The Draft itself accumulates, and it is in the
  review queue from the moment it is created.
- **These are the existing REST authoring operations exposed over MCP**, not a second way to write the
  same rows. Checkpoint creation keeps going through the same service, so the unique index on
  `(test_id, name)` — which the Manifest's closed-set property rests on — is enforced identically
  whoever is writing.
- **The single `test_versions` row** is written at creation and never again, as it is for a
  hand-written Agent-Driven Test. Nothing here writes a version.

### The required capture

- **A Checkpoint cannot be written without an image.** The refusal is structural, not advisory.
- Images land in the existing **`draft_previews`** store, which already carries a unique index on
  `(test_id, checkpoint_name)` — one preview per Checkpoint, enforced by the database, matching the
  uniqueness `agent_checkpoints` already has.
- **They are reference images, never baselines.** The existing store's contract is unchanged, and the
  first Run still produces the proposals a human approves per environment.
- **Deliberately not done:** promoting authoring captures to proposed baselines. It would make the
  Draft "fully packed" in one pass, at the price of a baseline no Run ever produced and a quiet
  reversal of the rule that a first run cannot report a pass.

### Storage — no new tables, no new columns

- **`tests.intent` carries the AI Instructions Claude authored.** This is the same slot a hand-written
  Agent-Driven Test uses, and `CONTEXT.md` already unifies the two: a **Brief** is either *pinned* into
  steps and fingerprints, or left unpinned and re-walked every run.
- **The steering prompt is not persisted.** The existing draft path writes the author's steering
  instruction into `intent`; for this kind that slot belongs to the authored artifact, and writing the
  request there would hand "make me a test for the dashboard" to every future run as its standing
  instructions. The artifact and its Checkpoints are a far better answer to "why does this test exist"
  than the sentence that asked for it, and the request itself remains visible in the chat.
- **`origin` becomes `'ai'` for these.** The original decision to keep it `'human'` rested on "a person
  types every word of an Agent-Driven Test", which this makes false.
- **`status` becomes `'draft'`**, and Promote behaves exactly as it does for a pinned draft.

### What Draft means for this kind

- **It carries no restriction of its own.** An Agent-Driven Test is barred from suites and schedules
  whatever its status, so the usual mechanical effect of draft-ness is already true and adds nothing.
- **It is fully runnable throughout**, matching pinned drafts, which are deliberately "individually
  runnable for baseline preview". Running a Draft is the only way to discover whether Claude's
  Checkpoints are reachable, and withholding that would withhold the most useful thing a reviewer can do.
- **It is the write scope for the authoring tools**, which is the mechanical job it gains here. Adding a
  Checkpoint to a non-Draft is refused.

### Capability boundary

- **Human principals only.** An agent principal is refused the authoring tools the same way it is
  refused the other tools outside its scope, and there is no capability that grants them. The run
  surface has a capability because unattended running has a real use case; unattended authoring has
  none, and an agent that can write a test can write one that passes.
- **Draft-scoped, which subsumes a rule that would otherwise need remembering.** A test with a live
  Agent Run Session is by definition promoted and therefore `active`, so "the agent cannot edit the
  test it is running" holds without a separate check for it.
- **This is deliberately stricter than the pinned equivalent.** Tools that change a pinned test are
  reachable by an agent holding a claim on a repair job. Nothing comparable exists here: there is no
  repair path for this kind at all, so there is no claim that could scope the write.

### Read-model corrections

- **A Draft's Checkpoint count must branch on kind.** It is currently derived from the latest
  `test_versions` definition's screenshot steps. An Agent-Driven Test's stub definition has no steps, so
  every one of these would read as a zero-Checkpoint draft — the queue's own flag for "a test that
  asserts nothing". It must count the test's Checkpoints instead.
- **The Draft inspector must be kind-aware.** Three of its panels have no meaning for this kind: the
  steering instruction (never recorded), the step list (there are none), and the per-Checkpoint preview
  panel keyed to pinned checkpoints. They are replaced by the AI Instructions and the ordered
  Checkpoints, each beside its capture — the shape the Agent-Driven Test editor already uses.
- **The zero-Checkpoint warning must be rewritten for this kind.** It currently says such a test "will
  run but never catch a regression", which is true of a pinned test and false here: starting a run on an
  Agent-Driven Test with no Checkpoints is refused outright.
- **The thumbnail** continues to come from the first Checkpoint's capture, which this kind now always
  has.

### Left at defaults

- **The Wall-Clock Lease is not set by Claude.** The test takes the column default and the author tunes
  it in the editor. Claude has just explored the journey and could estimate one, but a bound on
  somebody's subscription spend is not a thing to infer from one walk.
- **Environment.** An Agent-Driven Test binds to no environment; a Run picks one. Claude authors against
  whatever is on the author's machine, so authored instructions naming a literal URL can contradict the
  `Environment:` line a Run composes above them. The composed-instructions preview already exposes this
  before a run is spent, and that is the mitigation — no check is added, because a regex over prose
  would produce false positives on exactly the sentences worth writing.

## Testing Decisions

**What makes a good test here.** Only external behaviour: what the `/mcp` surface accepts, what it
refuses, and what is in the database and the artifact store afterwards. Not which service was called or
in what order. The properties worth pinning are the ones that protect something — a refusal that must
hold however convinced the caller is, and a Draft that must not be able to lie about what Claude
reached.

**One seam.** A `describe` block inside the existing Agent-Driven Tests authoring E2E spec, driving the
real `/mcp` JSON-RPC endpoint with an MCP bearer token against a real Postgres (testcontainers) and real
local artifact storage. It is the outermost boundary the feature has, and everything the change adds sits
underneath it: the transport, the capability gate, the Draft scoping, the required image, the
`draft_previews` write, and where the authored prose lands. Nothing else gets its own seam — in
particular, no unit seam for the write-eligibility rule, which is one boolean fully observable through
the refusals.

**One extraction.** The MCP call helpers (JSON-RPC post, tool call, PNG fixture) currently live as
closures inside the Agent Run Session spec. They move into a shared test harness module beside the
existing auth and database harnesses, and both specs use it. This removes a duplicate rather than adding
a seam.

**Prior art.** The Agent Run Session spec is the closest model — Chromium-free by construction, driving
`/mcp` as both a human and an agent principal, asserting on rows and artifacts rather than on responses
alone, and testing refusals as first-class behaviour. The existing authoring spec is the model for the
database-enforced properties (uniqueness, no version written).

**What must be covered:**

- A Draft is created at `kind: agent`, `origin: ai`, `status: draft`, with the authored AI Instructions
  in the Brief slot and **not** the steering prompt.
- Checkpoints accumulate in journey order across separate calls, and the Draft is queryable between them.
- A Checkpoint without an image is refused, and leaves no row and no artifact.
- A duplicate Checkpoint name is refused by the database, as it is on the hand-written path.
- Adding a Checkpoint to a promoted (`active`) test is refused — including one with a live Agent Run
  Session, which is the story-51 case stated directly.
- An agent principal is refused both tools, and no capability grants them.
- The captures land as draft previews and **no baseline row is created** by authoring.
- Promoting an authored Draft produces a test indistinguishable in behaviour from a hand-written one:
  it starts a session, composes its instructions and seeds its Manifest identically.
- The Draft read model reports the real Checkpoint count for this kind rather than zero.
- No `test_versions` row beyond the one written at creation.

**Not tested automatically.** The Author surface and the Drafts inspector, consistent with every ticket
in this feature: this repo has no UI tests, and the changes there are layout and copy composed from
shipped components. They are manual-verify.

## Out of Scope

1. **Editing a promoted test over MCP.** The authoring tools write only to Drafts. "Add a Checkpoint for
   the new screen" without opening the editor is the obvious follow-on and was rejected here because it
   reopens the rule that an agent may not edit the test it is running.
2. **Authoring by an agent principal**, under any capability. Not a default-off switch — no switch.
3. **Seeding baselines from authoring captures.** Reference images only; the first Run still produces the
   proposals.
4. **A Varys-hosted browser for authoring this kind**, and therefore any uniform capture contract,
   viewport normalisation or masks.
5. **Persisting the steering prompt**, in `intent` or anywhere else.
6. **A designed live-authoring view** — Checkpoints streaming into the Author surface as a visual
   replacement for the browser preview. The surface will show them; making that the centrepiece is a
   design exercise nobody has asked for yet.
7. **Claude choosing the test kind**, or proposing one. The author picks, before the session.
8. **Claude setting the Wall-Clock Lease.**
9. **Converting between kinds** — authoring a pinned test and turning it agent-driven, or the reverse.
10. **Suites, schedules, Repair Jobs, Triage Jobs and assertions for this kind**, all of which remain out
    of scope for Agent-Driven Tests generally.
11. **Batch Checkpoint writes.** One call per Checkpoint, deliberately.

## Further Notes

### No ADR, by decision — so this document carries the argument

The capability boundary was judged ADR-worthy during design and an ADR was declined. It is recorded
here instead, and it is the decision a future reader is most likely to trip over, because it runs
against the repo's own precedent: tools that change a **pinned** test are reachable by an agent that
holds a repair claim, while this says an agent may never author an Agent-Driven Test at all. The
asymmetry is not an oversight. A repair claim scopes a write to one test that a human's failing run
already identified; there is no repair path for this kind, so there is no claim to scope anything, and
the alternative — a capability flag, off by default — would put "an unattended agent can write tests
that pass" one provisioning mistake away.

The same applies to two other reversals recorded here rather than in `docs/adr/`: Draft and Promote
returning for a kind whose PRD removed them, and ADR 0007's no-browser posture extending from runs to
authoring.

### `CONTEXT.md` was updated during design

Three entries already carry these decisions and do not need revisiting: **Draft** (that draft-ness
carries no restriction for this kind and means only that nobody has read what the machine wrote),
**Author with AI** (that it drives an Authoring Session with a live preview for a pinned test, and
nothing at all for this one), and **Agent-Driven Test** (that its Checkpoints and AI Instructions may be
written by a person or by Claude).

One unrelated drift was noticed and left alone: the **Checkpoint Manifest** entry still says it is
"handed to the claimer when it takes the job", but the Agent Run Job queue was shelved and the Manifest
is handed over directly when a session starts.

### Why the required image is the load-bearing decision

Everything else here is plumbing that could be argued either way. The required capture is the one
mechanism that makes a machine-written Agent-Driven Test reviewable at all. Prose describing a state
Claude reached and prose describing a state it imagined are indistinguishable on the page — same
confidence, same specificity, and a reviewer has no way to tell which is which. The picture is the only
thing that separates them, and making it mandatory moves the guarantee out of the prompt and into Varys,
which is the rule the whole feature family is built on: *the prompt carries intent, the system carries
rules.*

### The relationship to `prd/agent-driven-tests.md`

That PRD listed this work under Out of Scope as item 6, described it as "genuinely useful and the obvious
follow-on", and predicted precisely the consequence this document accepts:

> it *would* reintroduce Draft/Promote, because a machine would then have written the artifact.

Nothing else in that PRD is reversed. The kind, the Manifest's closed set, the pre-seeded rows,
`deriveRunOutcome`, the Wall-Clock Lease, contextual-only comparison and baseline approval as the single
human gate all stand unchanged.
