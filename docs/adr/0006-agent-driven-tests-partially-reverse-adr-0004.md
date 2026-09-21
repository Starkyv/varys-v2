# Agent-driven tests exist — ADR 0004 is reversed in part

There is now a `tests.kind`, and `agent` is one of its values. An **Agent-Driven Test** has no
steps and no fingerprints: it holds AI Instructions and an ordered list of Checkpoints, which a
**locally-run Claude** re-walks on every Run, comparing each capture to its approved baseline
**contextually and never by pixel**. [ADR 0004](./0004-brief-authored-tests-converge-no-agentic-kind.md)
says, in its title and under Consequences, that no such kind exists. It is superseded **in part**,
and the part that survives is the important one.

## Context

ADR 0004 killed the permanently-agent-driven design for two reasons. Only one of them has been
answered by circumstance; the other had to be engineered around, and the scope of this reversal is
exactly the scope of that engineering.

**Cost and latency — dissolved.** ADR 0004 objected to "an agent session per test per environment
per schedule, forever". That priced a Varys-hosted agent on a Varys-held Anthropic credential.
These runs execute on the **author's own Claude, on their own machine, under their own
subscription**, started by the author asking for them. Varys pays nothing per run and holds no
outbound credential. The latency objection is conceded rather than answered: these runs are slow,
and that is accepted.

**Silent skipping — never refuted.** ADR 0004's real objection stands, verbatim: "an agent that
re-decides the path each run can quietly fail to check something and still report pass. A broken
locator fails *loudly*; a skipped assertion fails *silently*, and false greens ship bugs that false
reds do not." Nothing about running locally makes that less true. It is answered by machinery
instead, on Varys's side of the wire, under one rule: **the prompt carries intent, the system
carries rules.** Nothing that must hold is asked of the model.

- A **Checkpoint Manifest** — the test's authored checkpoints — is a closed set. The submit tool
  refuses any name outside it, so an agent cannot invent a slot or drift a name between runs.
- Varys **pre-seeds one `run_results` row per slot in `missing`** before the agent starts, so an
  unfilled slot is red whether the agent skipped it, crashed, or never reported at all. Nothing is
  inferred from an absent row.
- `deriveRunOutcome` computes the outcome from those rows as a pure function. The agent has no
  tool that sets it, and `missing` outranks everything but a crash.
- A `pass` on a slot with no approved baseline stays `pending-baseline`, so a first run cannot be
  talked into success.

## Consequences

- **The reversal is bounded by what that machinery covers.** An Agent-Driven Test **cannot join a
  suite or a schedule**, and Varys's worker refuses to run one at all. Nothing can run it
  unattended — Varys hosts no browser for this kind and holds no credential that could summon
  anyone's Claude — and a nightly suite that silently skips a member is worse than one that will
  not accept it. ADR 0004's objection still governs precisely the territory this reversal declines
  to enter.
- `tests.kind` defaults to `pinned`, so every test recorded before this is exactly what it was.
  ADR 0004's other consequences are untouched: `tests.intent` is still the Brief,
  `definition.assertions[]` still exists, and Repair Policy still applies to pinned tests however
  they were authored.
- The kind is a property of the **test**, not of its definition, because an Agent-Driven Test's
  behaviour is deliberately **unversioned**: instructions and checkpoints are edited in place and
  write no `test_version`, since iterating on the wording of a prompt is not an audit event. One
  stub version row is written at creation and never again, purely to satisfy
  `runs.test_version_id`.
- A checkpoint's **row id is its identity and its name is a label**, so renaming carries its
  approved baselines instead of orphaning them, and deleting drops them.
- What this design guarantees is narrower than "the verdicts are correct" and harder: **an
  agent-driven run cannot report a green for work it did not do.** Verdict *quality* rests on the
  comparison prompt, on required per-checkpoint reasoning, and on human baseline approval.
- The companion decision is
  [ADR 0007](./0007-no-server-side-browser-for-agent-driven-runs.md): Varys hosts no browser for
  this kind, departing from [ADR 0001](./0001-mcp-authoring-server-side-shared-core.md)'s
  server-side-Playwright posture. It landed with the Agent Run Session; this ADR covers only the
  existence of the kind and the authoring surface.
- **Revisit if** the machinery above proves sufficient in practice and someone wants these
  unattended. That would need a queue a remote Claude can drain, which is designed and deliberately
  deferred — not a relaxation of the Manifest or the pre-seeded rows, which are what make the
  reversal defensible at all.
