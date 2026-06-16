# MCP test authoring: server-side Playwright session, steps built through a shared recorder core

Claude authors tests via a hosted MCP server that drives a **server-side Playwright
session** (reusing the runner's pinned-chromium browser infra) with `@varys/recorder`'s
logic available to it. Each MCP action **explicitly** resolves Claude's chosen target
(by aria-snapshot ref), captures a fingerprint, performs the action, and appends a step
through **step-building factories shared with the human recorder** — so AI-authored and
human-authored tests are byte-identical in schema and quality by construction. Perception
is a separate, always-required layer: an aria/accessibility snapshot with stable refs as
the primary channel, plus screenshots on demand.

## Considered options

- **(Chosen) Explicit perform-then-capture (A1).** Reuse the recorder's *leaf* logic
  (`captureFingerprint`, password→secret + classify→variable rules, `variablesFromSteps`,
  `sanitizeEntryUrl`) via a DOM-free shared core in `@varys/recorder`; the MCP orchestrator
  builds exactly one step per action.
- **(Rejected) "Exactly like a human" (A2).** Load the real WXT extension into a headed,
  Claude-driven Chrome and let the content-script DOM event-listeners record passively.
  Playwright's input *is* trusted, so clicks would record — but it doesn't reproduce the
  human event sequences the listeners depend on (e.g. `change` fires on blur, which
  `fill()` never triggers → silently dropped type steps), checkpoints can't go through the
  inspect-mode overlay anyway (they need an explicit tool), and it requires heavier
  headed-Chrome-with-extension infra distinct from the replay pipeline. It reuses the one
  part of the human pipeline that is *unsafe* under synthetic input, for marginal code
  savings.

## Consequences

- Requires extracting a DOM-free shared core (pure step factories + an accumulator) out of
  `startRecorder`; the human path becomes a thin DOM-listener driver over that core.
- The shared core lives in `@varys/recorder` (no new package); its pure exports must stay
  DOM-free so the server can import them.
- Perception (aria snapshot + screenshots) is net-new regardless of recording mechanism —
  the recorder is passive and tells Claude nothing.
