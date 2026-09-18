# Starting an Agent Run Session from Varys

## Problem Statement

An **Agent-Driven Test** is the only kind of test in Varys with no Run button. Opening one shows a
notice explaining that it has no recorded steps, that the author's own local Claude walks it, and
that it cannot be added to a suite or a schedule. There is nothing to press.

To actually run one, the author has to leave Varys entirely: find the folder on their machine where
the Varys MCP server is registered, open Claude there, and type a sentence asking it to run the
test. Varys knows which test they want, which environment it should run against, what the
**Checkpoint Manifest** is and what the **Wall-Clock Lease** is — and none of that helps, because
the one thing it cannot do is ask the author's Claude to begin.

This is a genuine capability gap, not a cosmetic one, and it is felt three ways:

- **It is the wrong ceremony for the frequency.** Re-running a test after a fix is a routine act.
  Making it a context switch into a terminal, in a specific directory, makes people do it less.
- **It is easy to do wrong.** The folder matters, because MCP servers are registered per-folder.
  Started in the wrong one, the Varys tools are simply absent. Worse, a folder can have more than
  one Varys server registered — a local one and a production one — and a loosely-worded prompt can
  reach the wrong instance.
- **It puts the author in the loop for no judgement.** Everything the author contributes by typing
  that sentence is information Varys already holds. The human is acting as a message bus.

The author's stated requirement is direct: clicking Run on an Agent-Driven Test should run it.

## Solution

An Agent-Driven Test gets a **Run** button, and pressing it starts an **Agent Run Session** on the
author's own machine without them leaving the web app.

The piece that makes this possible already exists. The **Bridge Helper** — a small process the user
runs locally, which launches Claude under their own subscription — already pairs with Varys and
already holds an open channel that Varys pushes commands down. Today that channel carries exactly
one kind of command: a chat prompt for the *Author with AI* surface. This spec adds a second kind:
*start an Agent Run Session on this test, against this environment*.

What the author sees:

1. They open an Agent-Driven Test. If their Bridge Helper is paired, a **Run** button is live. If it
   is not, the button is visibly disabled and says so, rather than being absent or silently inert.
2. They press it, and pick an environment if the test uses one — the same choice, for the same
   reason, as the existing Run dialog for pinned tests: the environment decides which approved
   baselines the captures are compared against, and supplies the base URL.
3. Varys sends the command to their paired Bridge Helper. The helper launches Claude, which calls
   `start_agent_run` exactly as it does today when a human types the request.
4. The web app shows that the request went out, and then switches to the Run itself the moment one
   appears. From that point everything downstream is unchanged: the Run is created **already failed
   / unreached**, one `missing` row per Manifest slot, and it fills in as Claude submits.

What deliberately does **not** change:

- **Varys still holds no credential that can summon a model.** It sends a "go" to a process the user
  chose to pair and can stop at any moment. It does not call Anthropic, and the run is billed to the
  author's own subscription exactly as before.
- **Varys still drives nothing and observes no driving.** ADR 0007 is untouched. The browser, the
  app under test, and the captures all stay on the author's machine.
- **The Run is still created by `start_agent_run`.** Pressing the button creates nothing durable.
  This matters: the pre-seeded `missing` rows and the Wall-Clock Lease are stamped when that tool
  is called, and inventing a second notion of "started" would give Varys a Run it cannot vouch for.

## User Stories

1. As a test author, I want a Run button on an Agent-Driven Test, so that running it is the same
   gesture as running any other test.
2. As a test author, I want pressing Run to launch Claude on my own machine, so that I never have to
   find a folder and type a prompt to start a routine re-run.
3. As a test author, I want to choose an environment when I press Run, so that my captures are
   compared against the baselines approved for the environment I mean.
4. As a test author, I want the environment choice to be skipped for a test that uses no base URL,
   so that I am not asked a question that has no answer.
5. As a test author, I want the Run button to be disabled with a plain reason when no Bridge Helper
   is paired, so that I learn why nothing will happen before I press it rather than after.
6. As a test author, I want to be told how to pair a helper from that disabled state, so that the
   failure carries its own remedy.
7. As a test author, I want visible acknowledgement that my request left Varys, so that the gap
   between pressing Run and the Run appearing does not read as a broken button.
8. As a test author, I want to be told if no Run appears within a reasonable time, so that a helper
   that is paired but wedged is distinguishable from one that is working.
9. As a test author, I want the Run button to become unavailable while a request is outstanding, so
   that an impatient second press does not start two sessions against the same test.
10. As a test author, I want the web app to move me to the Run as soon as it exists, so that I watch
    the Checkpoint Manifest fill in without hunting for it.
11. As a test author, I want the Run started this way to be indistinguishable from one I started by
    typing, so that nothing about my history or outcomes depends on which door I used.
12. As a test author, I want the Run to record that Varys asked for it, so that I can tell later
    whether a session was started by hand or from the web app.
13. As a test author, I want a pinned test's Run button to keep working exactly as it does now, so
    that this change costs me nothing on the tests I already have.
14. As a test author, I want the Run button to refuse a test with an empty Checkpoint Manifest, so
    that I am not given a session with no slots to fill.
15. As a project member, I want only my own paired helper to be reachable from my session, so that
    nobody else's press can launch a process on my machine.
16. As a project member, I want a press by someone who does not own the helper to be refused, so
    that the helper channel is not a way to run code on a colleague's laptop.
17. As a project member, I want the helper to be something I start and stop myself, so that Varys's
    ability to reach my machine lasts exactly as long as I allow it.
18. As a test author, I want the helper to launch Claude in the folder it was itself started in, so
    that which MCP servers are available is a consequence of how I started it and not of a string I
    typed into a settings box.
19. As a test author, I want the command Varys sends to name the test by id, so that a loosely
    worded prompt can never reach a different test than the one I clicked.
20. As an operator, I want the helper's connection state visible on the test page, so that I can see
    whether pressing Run can work without pressing it.
21. As a reviewer, I want a Run started from the web app to carry the same pre-seeded red and the
    same Wall-Clock Lease as any other, so that the guarantee does not weaken because the trigger
    changed.
22. As a reviewer, I want nothing about baseline approval to change, so that a Run started more
    conveniently is not a Run that is easier to wave through.
23. As a test author, I want the existing Author with AI chat to keep working while this is added,
    so that widening the helper does not cost me the surface it was built for.
24. As a test author, I want to keep the option of starting a session by typing, so that the button
    is an addition and not a replacement.

## Implementation Decisions

### The Bridge Helper is widened, not duplicated

The helper keeps its identity as *the process the user runs locally that launches Claude under
their own subscription*. It gains a second thing it can be asked to do. A separate run-only helper
was considered and rejected: it would mean two processes to keep running, two pairing flows, and two
places for the connection state to be wrong.

Two glossary entries widen as a result, and both changes belong in this work:

- **Bridge Helper** currently says it launches *the Claude authoring agent*. It launches Claude —
  for authoring, and to walk an Agent-Driven Test.
- **Agent Run Session** currently says it is *started by a person asking their own local Claude to
  run it*. It is started by a person asking their own local Claude — directly, or by asking Varys to
  ask it. The substance of the entry is unaffected: it is still the user's Claude, still their
  machine, still their subscription, and Varys still supplies no browser.

### The command channel gains a second variant

The relay's downward command type is today a single-variant union carrying a prompt. It becomes a
union of two: the existing prompt, and a run request carrying the **test id** and an optional
**environment id**. Nothing else travels down.

In particular the command does **not** carry the AI Instructions, the Checkpoint Manifest or the
baselines. Those are what `start_agent_run` returns, and duplicating them into the command would
create a second copy that can disagree with the first. The command is an instruction to begin, not a
briefing.

Naming the test by **id** rather than by a sentence is the point of the whole mechanism: it removes
the class of failure where a typed prompt reaches the wrong test, or the wrong Varys instance.

### Pressing Run creates nothing durable

The button sends a command. It does not create a Run, reserve one, or write any row. The Run comes
into existence when Claude calls `start_agent_run`, which is also where the `missing` rows are
seeded and the Wall-Clock Lease is stamped.

This is deliberate and load-bearing. The design's central guarantee is that a Run is red from the
instant it exists and that nothing is inferred from work that was not reported. A Run created at
button-press would be a Run that exists without a session behind it — and if the helper were wedged,
it would sit there forever as a failure nobody ever attempted.

The cost is a gap between the press and the Run appearing, which the next decision addresses.

### The request has a visible, bounded lifetime

Because the press writes nothing, the web app needs its own account of what is happening. The
request is tracked as transient, owner-scoped state on the relay, with three observable outcomes:

- **acknowledged** — the helper received the command and reports that it has launched Claude.
- **fulfilled** — a Run for that test appears, which is what the author actually wanted to see. The
  web app moves them to it.
- **lapsed** — neither happened within a bounded window. The author is told plainly that the helper
  was asked and did not start a session, which is the state that distinguishes a wedged helper from
  a slow one.

A helper that is paired but not responding must produce *lapsed*, not an indefinite spinner. ADR
0003 already establishes this principle for unclaimed repair work: the inability to guarantee that
something happens must be visible in the UI, never silent.

While a request is outstanding for a given test, a further press is refused. This is enforced on the
relay rather than only by disabling the button, so that two browser tabs cannot both start one.

### The helper decides where and how Claude is launched

Varys does not tell the helper which folder to run in, which MCP server to use, or what to type. The
helper launches Claude in its own working directory, and that directory is a fact about how the
operator started the helper — not a string configured in Varys that could be stale or wrong.

This deliberately closes the question of Varys holding a configured path. A path in a settings screen
is a claim the server cannot verify; the helper's own working directory needs no verification because
the helper is already the thing being trusted.

The helper program itself is not in this repository. This spec fixes the **Varys-side contract** —
the command, its variants, the refusals and the request lifecycle. Building the helper's side of it
is separate work that consumes this contract.

### Authorization is inherited, not invented

The relay already scopes the web side to the signed-in owner of the chat and the helper side to a
pairing-issued token. A run request reuses both unchanged: only the owner may send one, and it can
only ever reach the helper they themselves paired.

No new credential is introduced. In particular this does not need the scoped agent credential that
unattended draining requires, because the human is present and authenticated by their own session.

### Refusals are explicit and distinguishable

Four cases must be refused, and each must say which one it is:

- The test is **not an Agent-Driven Test**. Pinned tests keep their existing Run path through the
  queue; this door is not for them.
- **No Bridge Helper is paired** for this user. The button is disabled ahead of time, and the
  request is refused if one arrives anyway.
- The test's **Checkpoint Manifest is empty**. `start_agent_run` already refuses this, so the
  refusal here is not a new rule — it exists to fail before a Claude is launched and subscription
  time is spent discovering it.
- A **request is already outstanding** for this test.

### The trigger is recorded

A Run started this way records that it was requested from the web app rather than typed. This is
evidence for a reader, not a behavioural switch: nothing about the Run's outcome, lease, review or
approval depends on it. The existing trigger-source concept on a Run is the natural place for it.

### The web surface

The Agent-Driven Test detail view keeps its notice — the substance of it is still true, and the part
about suites and schedules is unchanged — but gains the Run control beside it, and the helper's
connection state. The environment choice reuses the existing Run dialog's pattern rather than
inventing a second one, including its handling of a test that needs no environment.

## Testing Decisions

A good test here asserts what an outside caller can observe: that a press by the right person
reaches the right helper carrying the right ids, and that every refusal is the refusal it claims to
be. It must not assert how the relay stores its in-flight state, nor reach into the web app's
internals. The helper's own behaviour — launching Claude, choosing a folder — is not testable from
this repository and is explicitly not asserted here.

**One seam: the Bridge relay's HTTP surface.** This is an existing seam with existing prior art, and
it covers the entire Varys side of the feature in one place. A test pairs a stand-in helper, holds
the downward command stream, acts as the signed-in owner, and observes what arrives. The web app is
not separately tested, because it renders what this surface reports and holds no decision of its
own.

Cases to cover at that seam:

- A run request from the owner arrives at the paired helper as a run command carrying the test id
  and the chosen environment id.
- A request naming no environment arrives with none, rather than with a guessed one.
- The command carries no instructions, manifest or baselines.
- A request for a pinned test is refused, distinguishably.
- A request for a test with an empty Checkpoint Manifest is refused, distinguishably.
- A request with no helper paired is refused, distinguishably.
- A second request for the same test, while one is outstanding, is refused.
- A request from a signed-in user who is not the chat's owner is refused and reaches nobody.
- An unauthenticated request is refused.
- An acknowledged request is reported as acknowledged; one that is never acknowledged lapses within
  its bound rather than remaining outstanding.
- The existing prompt command still relays unchanged, and an event still travels back up.

**Prior art.** The bridge relay E2E spec already pairs a helper, relays a prompt down, relays an
event up, correlates the session, and asserts the unauthenticated refusals on all three surfaces.
The new cases extend that file directly. The agent-driven-test E2E specs over the MCP surface remain
the prior art for everything downstream of `start_agent_run`, which this change does not touch.

## Out of Scope

1. **Suites and schedules for Agent-Driven Tests.** They stay refused. This spec makes them newly
   *arguable* — a commandable helper is the thing whose absence justified the refusal — but a helper
   the operator may not be running is exactly the silent-skip failure that ADR 0007 refuses to
   accept. Revisiting it means amending that ADR on its own terms, with a real answer for the
   unstarted-helper case, and that is a separate decision.
2. **Cloud execution of Agent Run Sessions**, and the Agent Run Job queue with claim, lease-as-
   ownership and drain. Still shelved for the reason the Agent-Driven Tests spec gives: a local
   browser makes cloud claimers impossible.
3. **The Bridge Helper program itself.** This spec defines the contract it consumes. Its
   implementation, packaging and how the operator starts it are separate work.
4. **Any change to what happens after `start_agent_run`.** The pre-seeded red, the `missing` rows,
   the Manifest as a closed set, the Wall-Clock Lease, submission, review and approval are all
   untouched.
5. **A Varys-hosted browser for this kind**, per ADR 0007.
6. **A configured folder or path setting in Varys.** The helper's working directory replaces it.
7. **Cancelling a running Agent Run Session from the web app.** Worth having, and a different
   feature — the Wall-Clock Lease is what bounds a session today.
8. **Re-running automatically on a failure**, or any form of retry.
9. **A secret store.** Credentials remain plaintext in AI Instructions by explicit decision.

## Further Notes

**This does not weaken ADR 0007, and the reason is worth stating.** That ADR rejects a Varys-hosted
browser and records that nothing can run an Agent-Driven Test unattended. Both still hold. The
browser stays on the author's machine, and a press of a button is an attended act — a person is
present, signed in, and looking at the test. What changes is only which of their fingers starts it.

**The capture path should be trustworthy before this ships.** A recent real Agent Run Session
submitted placeholder images accompanied by convincing reasoning, because the agent could not get
real screenshot bytes through and chose a workaround rather than an honest failure. Work already
exists to close that — accepting a local file path for a capture so the bytes never pass through the
model's output, and refusing a truncated or altered PNG loudly — and it is a prerequisite in
practice if not in dependency. A Run button makes runs cheaper to start; cheap runs that quietly
record the wrong picture are worse than expensive ones. The specific danger is approval: a first run
has no baseline, so its captures are proposals, and approving them writes them as the baselines that
every later run is measured against.

**The button will invite the schedule question immediately.** Once pressing Run works, "why can't it
press itself at 3am" is the obvious next thought, and the honest answer is that nothing guarantees
the helper is running. That is a real product question with a real answer available — make the
unstarted-helper case loud instead of silent — but it is an ADR-level decision, not something to
slip in behind a convenience feature.
