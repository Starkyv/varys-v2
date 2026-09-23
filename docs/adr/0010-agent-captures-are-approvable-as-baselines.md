# An Agent-Driven Test's authoring captures are approvable as its baselines

A human can approve an **Agent-Driven Draft**'s authoring **Captures** as the **Baselines** for an
environment they name, directly from the review queue — no Run in between. A pinned test cannot:
its baseline still comes from a Run's capture, approved there. The human gate does not move in
either case; what goes is the Run that existed only to produce a picture to approve.

## Context

An Agent-Driven Test's checkpoints are never pixel-diffed —
`agent-run.service.ts` seeds every `run_results` row with the team-wide threshold and the comment
that says why it is inert: *"this kind never pixel-diffs — the comparison is always contextual."*
The judge is the agent itself, comparing two pictures and writing its reasoning.

That one fact is what makes this safe here and not elsewhere. The usual objection to promoting an
authoring capture — it was taken on the author's machine, by their tooling, at their device pixel
ratio, so it will differ from a run's capture on every pixel — is an objection about *pixel
diffing*. A vision judge is indifferent to antialiasing. So the images really are interchangeable
for the only comparison this kind ever performs.

What the previous design required instead was ceremony. The agent captured every state it reached
and Varys stored each one; a human then had to start a Run so the agent could re-reach the same
states and produce a *second* picture, which that same human then approved. Same states, same
agent, same judgement — one extra run, and an authoring capture sitting unused beside it the whole
time.

The reason to keep a human in it is unchanged and is not about pixels. In an agent-driven run
Claude is already the only witness and the judge; if it also supplied the baseline it would take
the picture, define correct, and grade itself against its own definition with nobody ever looking.
A wrong baseline is the one failure that never shows up as a red — it is a green forever, so the
first approval is the only moment anyone can catch a half-drawn chart or a stale filter.

## Consequences

- **The reviewer names the environment.** A baseline is keyed `(test, checkpoint, environment,
  viewport)`, and an `add_agent_checkpoint` records no environment at all. It is asked for at
  approval rather than inferred from the walked URL or declared by the agent: "this is correct
  **for staging**" is the claim being made, and letting the agent state it would hand back the
  decision the gate exists to keep from it.
- **The bytes are copied, not referenced.** `putDraftPreview` upserts the preview in place, so a
  baseline pointing at that key would be silently rewritten by a later re-capture. An approved
  image has to stop moving at the moment it is approved.
- **A checkpoint that already has a baseline is skipped, never overwritten.** Replacing a live
  golden stays a Run's approval, where the capture that disagreed is on screen next to it.
- **Pinned tests are refused, in the server and not just in the UI.** The asymmetry is the part a
  future reader will try to "fix" — it looks like an oversight and is the whole point.
- **Promote and this remain separate routes**, as they always were. Either can happen without the
  other.
