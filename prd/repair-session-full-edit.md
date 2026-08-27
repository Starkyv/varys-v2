# PRD — Repair session: full test editing (Slice 18)

> A repair session can change **anything** about the test it opened — not just the locator on
> the step the run happened to die on. The session that re-drives a test to its failure and
> parks a live browser there becomes the session in which the test is fixed, whatever "fixed"
> turns out to mean: a renamed checkpoint, an LLM judge instead of a pixel diff, a mask over a
> volatile region, a stale typed value, a missing step, two steps in the wrong order.

## Problem Statement

A repair session already does the expensive, valuable part: it replays the exact definition
version that failed, in a real browser, with the run's environment, and parks on the page the
failing step faced. From there Claude can see why the recorded locator no longer resolves, try
candidates against the live page, and write a verified fix with `apply_fix`.

But `apply_fix` writes exactly one thing: a `FingerprintPatch` on the one step the session was
opened on. Every other change the same conversation produces has nowhere to go:

- "while you're in there, the checkpoint should be judged by context, not pixel-diffed"
- "rename that checkpoint, the name is meaningless"
- "mask the timestamp in the header"
- "that typed value is stale — it should be the new report name"
- "add a checkpoint after the filter is applied"
- "delete step 4, we removed that button"
- "the wait belongs before step 6, not step 5"

Each one ends the same way: Claude reports the diagnosis, the user leaves for the web editor
and re-derives from scratch what Claude already had in front of it. Worse, the two surfaces
are not equivalent — the web editor cannot *capture* an element, so a step added there hangs
off one hand-written CSS selector with no multi-signal bundle behind it, while the repair
session is looking straight at the live element it could have fingerprinted properly.

The mismatch is not a missing feature so much as an arbitrary edge: the session holds the
diagnosis, the page, and the write path, and is allowed to use only a sliver of it.

## Solution

Two general tools alongside the narrow verified-fix path, plus a way to move around the test.

**`read_test`** prints the test's current definition as an editable surface: every step with its
0-based index, human label, and every field an edit can address — the checkpoint's
name/captureMode/compareMode/prompt/threshold/masks/rect, a type step's value, a navigate step's
URL, the waits before it, and its locator. It always reports the **latest** version, which is
what an edit lands on even inside a session opened on an older one. It works with a session id
(the test under repair) or a bare test id (any test, no browser needed).

**`edit_test`** applies an arbitrary patch and writes a new audited version: per-step field
edits, step removal, step insertion, and reordering, plus the test's name and notes. It goes
through the same `TestsService.saveConfig` seam the web editor writes through — same schema
validation, same optimistic lock, previous version retained — so an MCP-applied edit and a
hand-applied one are the same operation with the same audit trail.

Two things it does that the web editor cannot. A step's locator can be **re-captured** from the
live page by `ref`, and an inserted click/hover/type/element-checkpoint can be **built** on a
real captured fingerprint rather than a raw selector — the difference between a step that
self-heals and a step one CSS change from failing. And `baseVersion` is resolved server-side
rather than supplied: the model has no editor tab to go stale, and making it guess a version
number only invents 409s.

**`goto_step`** re-drives the test from the top on a fresh page and parks on any step, so the
live page in front of Claude is the one that step faces. It drives the test **as it stands now**,
including edits made this session — which is also how an edit gets verified after the fact.

`apply_fix` stays exactly as it is, and stays the way locators get fixed: it re-checks the
candidate against the live page and refuses one that does not resolve. `edit_test` deliberately
does not do that (see below).

## User Stories

- As an engineer whose nightly run failed, I ask Claude to fix it; it diagnoses the locator,
  applies the verified fix, and — in the same breath — masks the timestamp I complain about and
  renames the checkpoint I never liked, telling me the version number for each.
- As an engineer, I say "that checkpoint can't be pixel-diffed, the summary is generated" and
  Claude switches it to `context` with a judge prompt describing what counts as broken, without
  me opening the web app.
- As an engineer, I say "add a fullpage checkpoint after the filter applies"; Claude drives to
  that point, sees the settled page, and inserts the step where it belongs.
- As an engineer, I say "step 4 is dead, we removed that button"; Claude removes it and tells me
  what the step list is now.
- As an engineer, I ask about a step the run never reached; Claude re-parks there and tells me
  what that page actually shows, rather than reasoning about it from the definition.
- As an engineer, I rename a checkpoint and my approved baseline is still the baseline —
  the rename moves it rather than orphaning it.

## Implementation Decisions

### One write path, widened — not a second one

Every edit rides `PUT /tests/:id/config`'s service seam (`TestsService.saveConfig`). Rather than
give MCP its own definition writer, the shared `TestConfigPatch` grows the fields it was missing:
a screenshot step's `name`, `captureMode` and `rect`; a navigate step's `url`; a whole-fingerprint
`recapture`; and a test-level `order` permutation. `NewStepInput` grows `hover`, element/region
checkpoints, and an optional captured `target` beside the existing `selector`.

The web editor gets those capabilities for free the day its UI exposes them, and the two surfaces
cannot drift into different validation.

### Checkpoint rename moves the baseline, atomically

A checkpoint's name IS its baseline key `(test, checkpoint, env, viewport)`. This is precisely why
Slice 16 did locator editing *before* checkpoint rename. Renaming the step alone would silently
orphan every approved golden and send the next run back to `pending-baseline` — a data-loss bug
wearing the costume of a text edit.

So a rename migrates this test's `baselines` and `draft_previews` rows onto the new name **inside
the same transaction as the version insert**. Half-applied is worse than rejected. Checkpoint
names are re-checked for uniqueness whenever a patch adds or renames one.

### `edit_test` is not verified against the page, and says so

`apply_fix` re-resolves its candidate against the parked page and refuses anything `not-found` or
`ambiguous`. That guarantee exists because replacing one broken locator with another broken
locator is the specific failure the whole repair path exists to prevent.

A general edit cannot carry the same guarantee: most of what it changes (a judge prompt, a mask,
a typed value, step order) has nothing to resolve, and the ones that do may deliberately target a
page the session is not parked on. Rather than fake it, the split is explicit — in the tool
description, in the mode guidance, and in the response note: edit a locator through `edit_test`
and you must `goto_step` back and confirm with `try_locator` before calling it fixed.

### Re-parking is a fresh page, not the dirty one

`goto_step` opens a new page in the already-seeded context and closes the old one, then re-drives
from step 0. Re-driving on top of whatever the previous drive left behind would make the parked
state depend on where the session had been before — exactly the kind of inheritance a diagnosis
must not carry.

### Indices are the contract, so `read_test` is the precondition

Every edit is keyed by step index, and an index inferred from a run's error message is how you
edit the wrong step. `read_test` is therefore not a convenience: the tool descriptions and the
operator prompt both require it first, `edit_test` rejects an out-of-range index and a field
aimed at the wrong step type before writing anything, and every `edit_test` response returns the
step list **after** the edit, because adding, removing or reordering shifts everything below.

### Guidance carries the intent the schema can't

The repair-mode `guidance`, the MCP tool descriptions, the seeded middleware prompt and the
operator prompt all say the same two things: this session can change anything about the test, and
it changes **only what was asked**. A tool that can rewrite a test is a tool that can quietly stop
it asserting what it was written to assert.

## Testing Decisions

`apps/api/test/repair-edit.e2e.spec.ts` drives the MCP surface with a deterministic JSON-RPC
script (no LLM) against a seeded failed run whose test has a checkpoint with a threshold and an
approved baseline behind its name:

- `read_test` reports every step's editable fields, keyed by index, without a session.
- A checkpoint rename + compare-mode switch writes a new version **and** the baseline row follows
  the new name, keeping its artifact.
- A field aimed at the wrong step type, an out-of-range index, and an `order` that doesn't account
  for every surviving step are all rejected **before** anything is written (version count unchanged).
- An insert addressed by a live `ref` stores a real captured fingerprint (tag/role/attributes),
  not a bare `selectorOverride`; a follow-up remove + reorder produces the expected step list; and
  a reorder that displaces the entry navigation is refused.
- `goto_step` re-parks on another step of the test **as edited**, and rejects an out-of-range one.

## Out of Scope

- **Running the test from the repair session.** Verifying a fix end-to-end still means triggering
  a Run from the web app. `try_locator` + `goto_step` cover the locator question; a full run also
  captures screenshots and touches baselines, which is a different blast radius.
- **Re-baselining from a repair session.** Baseline approval stays a human, per-environment gate
  (DESIGN §4). A checkpoint rename moves an existing baseline; it never approves a new one.
- **Promotion.** Unchanged and deliberately web-UI-only (ADR 0001) — Claude must not self-promote.
- **Editing a test's schedule, folder, tags, or environments** from MCP. `name` and `notes` are
  in because they are what a repair conversation naturally produces; the rest is organization
  work with no connection to the failure in front of you.
- **Opening a live session on a test that has never failed.** `open_repair_session` still enters
  through a failed run, because that is what supplies the environment (base URL + cookies) the
  drive needs. `read_test`/`edit_test` work on any test by id with no session at all, so editing a
  healthy test is covered — what is missing is a *live page* to capture a `ref` from, which would
  need an explicit environment argument. Its own slice.
- **A web UI for reorder / rename / capture-mode.** The contract and the server support them now;
  surfacing them in Test Details is its own slice.

## Further Notes

The narrow tool did not become redundant. `apply_fix` remains the right instrument for the
specific repair it was built for, and its refusal-on-unresolvable is the whole reason a repair
can be trusted. What changed is that it is no longer the *only* thing the session can do — the
rest of the conversation now has somewhere to land.
