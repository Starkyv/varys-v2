# Live verify — partial-replay backend (Slice 16.3a)

**Type:** AFK

## Parent

PRD: `prd/locator-editor-live-verify.md` (DESIGN §14 — Slice 16). Covers user stories
10, 11, 12, 13, 14, 15, 16, 22, 23 (backend portions) and 24.

## What to build

A verify capability that answers "does this candidate locator resolve at this step in
environment X?" by running a **transient, artifact-free partial replay**: launch a
short-lived headless server browser, resolve the test's variable/secret tokens for the
chosen environment, **drive steps `[0 .. stepIndex)`** to reach the page state, then resolve
the **candidate (unsaved, merged) fingerprint** at `stepIndex` with the *real* scored matcher
— the same one Runs use. It returns the verdict and which signal won; it never writes a Run,
run results, baselines, or artifacts, and enqueues nothing.

To guarantee "verified here ⇒ resolves at Run time", extract the runner's step-driving loop
into a reusable **"drive to step N"** core that both Run and verify call (the verify probe
substitutes the candidate target at the final step). Existing Run behavior must be unchanged.
This composes with the override (Slice 16.2): the candidate runs through the same matcher, so
an override is honored during verify too.

Environment selection mirrors the Run pre-flight contract: a test that declares variables
requires a satisfying environment; a no-variable test verifies env-less ("default").

## Acceptance criteria

- [ ] The runner's step-driving loop is factored into a reusable "drive to step N" used by both Run and verify; the existing run / baseline e2e suite stays green (Run behavior unchanged).
- [ ] A verify endpoint accepts `{ stepIndex, environmentId?, candidate target }` and returns `{ status: resolved | ambiguous | not-found, matchedSignal?, healed?, reachedStep, failedStepIndex?/label? }`.
- [ ] A candidate matching a fixture element returns `resolved` with a matched signal; a deliberately broken candidate returns `not-found`; a tie returns `ambiguous`.
- [ ] When an earlier step in the drive cannot be performed, the response identifies the failed step (distinguishing "wrong locator" from "broken path to the step").
- [ ] Variable/secret tokens are resolved for the chosen environment; a no-variable test verifies env-less.
- [ ] Verify writes no run, run results, baselines, or artifacts, and enqueues no job.
- [ ] A new verify supersedes an in-flight verify for the same test (single-flight) and is bounded by a timeout.
- [ ] End-to-end coverage against the fixture app (prior art: the baseline replay e2e and the live-browser authoring e2e).

## Blocked by

- Slice 16.2 — Locator editor: raw selector override (`issues/locator-2-selector-override.md`).
