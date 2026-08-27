# Brief-authored tests converge into ordinary tests — there is no agentic test kind

A test authored from a natural-language **Brief** is not a new kind of test. Claude drives
**once**, during an Authoring Session, and Varys **pins** what it decided — the steps, the
multi-signal Fingerprint of every element it chose, and how each Assertion is to be evaluated.
Every run after that is an ordinary deterministic replay in the worker, costing nothing.
Claude is re-engaged only when a pinned locator stops resolving.

## Context

The feature was conceived as "Claude-native tests": no deterministic replay at all, just an
elaborate prompt that Claude follows fresh each run, adapting to whatever the app has become.
A reader who knows that history will look for `kind: 'agentic'` and not find it.

Two things killed the permanently-agent-driven design. First, **cost and latency**: an agent
session per test per environment per schedule, forever, when the overwhelming majority of runs
face an app that has not changed. Second, and worse, **silent skipping**: an agent that
re-decides the path each run can quietly fail to check something and still report pass. A
broken locator fails *loudly*; a skipped assertion fails *silently*, and false greens ship bugs
that false reds do not. The original motivation — locator brittleness — is real, but it is
answered by re-pinning on break, not by abandoning pinning.

What survives from the original idea is everything that was actually new: the Brief as a durable
statement of intent that any repair must still satisfy, **Assertions** (checks no single
screenshot can express, which nothing in Varys did before), and an automatic repair path.

## Consequences

- No `tests.kind`. Instead: `tests.intent` becomes the Brief, `definition.assertions[]` is new,
  and a per-test **Repair Policy** (`manual | auto`) gates enqueueing a Repair Job.
- The capabilities are not agentic-specific, so **hand-recorded tests self-heal too** — which is
  strictly more valuable than scoping them to brief-authored ones.
- A brief-authored test gets *cheaper and more deterministic over time*, inverting the usual
  expectation that an AI feature costs more the longer you use it.
- An auto-repair may never produce a green run. Claude must state which clause of the Brief the
  re-pinned element satisfies, a one-shot judge validates that claim, and the re-run's outcome is
  **`healed`** — amber, outranked by `regression` and `failed`, outranking `passed`. It does not
  fail a suite, and it stays in the review queue until a human accepts the version.
- A pinned Assertion is **data, never code**: fingerprints to read, coercions, and a relation from
  a vocabulary Varys owns. Nothing model-authored executes in the worker. Assertions the
  vocabulary cannot express fall back to the existing one-shot vision judge, and the author is
  told which ones did.
- Rejected alternative worth remembering: pinning only checkpoint *targets* and letting Claude
  re-decide the *path* every run. It preserves briefs whose path should legitimately vary, at the
  price of paying for an agent session on every run forever. Revisit only if such briefs turn out
  to be common.
