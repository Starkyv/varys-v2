# Varys hosts no browser for an agent-driven run

An **Agent Run Session** is started over `/mcp` and driven entirely on the **author's own
machine**, by their own Claude, under their own subscription. Varys supplies no browser, no
perception layer and no action tools for it: `start_agent_run` hands over the composed AI
Instructions, the ordered **Checkpoint Manifest** and the approved baselines, and never observes
how any state is reached. Every other Varys agent surface does the opposite —
[ADR 0001](./0001-mcp-authoring-server-side-shared-core.md) chose a **server-side Playwright
session** precisely so that Claude's actions land in Varys's own recorder. That posture is
**departed from for this kind only**, and ADR 0001 is otherwise untouched.

## Context

ADR 0001's argument is about **authoring**: a step is only worth recording if the fingerprint
behind it was captured by the same code the human recorder uses, so Claude has to act *through*
Varys rather than beside it. An agent-driven run records no steps and captures no fingerprints.
There is nothing for a shared recorder core to produce, so the reason ADR 0001 put the browser
server-side does not arise here.

Three things decide it positively.

- **The credential does not exist.** These runs are explicitly not to be paid for with a
  Varys-held Anthropic key; they run on the author's Pro/Max subscription (the same constraint
  that dissolved [ADR 0004](./0004-brief-authored-tests-converge-no-agentic-kind.md)'s cost
  objection, see [ADR 0006](./0006-agent-driven-tests-partially-reverse-adr-0004.md)). A
  Varys-hosted browser would need a Varys-held way to summon a model to drive it. There is none,
  by design.
- **The app under test is often only reachable from the author's machine** — a dev server, a VPN,
  an SSO session already established in their own browser. A server-side browser would have to be
  given credentials and network reach that the local one already has.
- **Flexibility is the feature.** The value of this kind is that Claude picks the approach —
  Chrome DevTools, Playwright, computer use, a CLI, some combination — against whatever is in
  front of it. A Varys-hosted Playwright would fix that choice at exactly one option, which is
  the thing a pinned test already does better.

## Considered options

- **(Chosen) No server-side browser; Varys is a reporting surface.** Claude drives locally,
  unconstrained, and submits captures and verdicts back.
- **(Rejected) Extend ADR 0001's session to this kind.** Varys launches Playwright, Claude drives
  it through `observe`/`click`/`navigate` as it does for authoring. This buys a uniform capture
  contract — every image taken the same way at the same viewport, which genuinely makes
  comparisons cleaner. It was rejected because it requires the credential that does not exist,
  cannot reach a local-only app, and reduces "whatever works" to "whatever Playwright can do".
- **(Rejected) A pinned capture contract without a pinned browser.** Let Claude drive locally but
  require captures at a fixed viewport and device scale. Rejected as unenforceable theatre: Varys
  cannot verify a claim about how an image was produced, so the constraint would exist only in
  the prompt — and the whole design rule here is that nothing load-bearing is asked of the model.

## Consequences

- **Varys observes no driving, and therefore attests to none.** The evidence a run leaves is what
  was submitted: images, per-slot verdicts and required reasoning. There is no trace, no step
  list, no network log. A person reading an agent-driven run is reading the agent's account plus
  the pictures, not a recording.
- **Capture is unconstrained, and the cost is accepted explicitly.** A baseline taken headless at
  1280×800 and an actual taken via computer use on a Retina display are genuinely different
  pictures, and a contextual judge will say so. Capture metadata is recorded beside the artifact
  as **evidence, not a constraint** — so a reviewer looking at a strange comparison can see
  whether the two images were taken the same way.
- **Nothing can run one unattended**, which is not a gap to close later but the boundary that
  makes ADR 0006's reversal defensible: agent-driven tests are refused from suites and schedules
  because there is nothing to summon a driver, and a nightly suite that silently skips a member is
  worse than one that will not accept it.
- **The guarantee has to live entirely on Varys's side of the wire**, since nothing on the other
  side is observed. That is why starting a session pre-seeds one `missing` row per Manifest slot
  and creates the run **already `failed` / `unreached`**: the run is red before the agent acts,
  and an agent that crashes, disconnects or checks less changes nothing about that. See ADR 0006
  for the full set of mechanisms.
- **`environments.cookies` / `local_storage` do not apply** to this kind — they seed a browser
  context Varys controls. Login is whatever the AI Instructions say it is, credentials included,
  as plain text (a deliberate choice: there is no secret store, and the instructions are already
  the place a person writes how to sign in).
- **Revisit if** Varys ever holds a credential that can drive a model on its own infrastructure
  for these runs. The capture-contract argument would then be worth re-opening on its own terms —
  but not before, because it is the unenforceable half of a decision whose other half is missing.
