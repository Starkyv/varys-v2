# Locator editor — edit structured signals (Slice 16.1)

**Type:** AFK

## Parent

PRD: `prd/locator-editor-live-verify.md` (DESIGN §14 — Slice 16). Covers user stories
1, 2, 3, 4, 7, 8, 9, 17, 18, 19, 20, 21, 24.

## What to build

Make a recorded step's locator editable in the Test Details screen, end-to-end, for every
step that has an element target — `click`, `type`, and element-mode `screenshot`. The author
can edit the four high-value fingerprint signals — **role**, **accessible name**, **visible
text**, **test id** — and clear any of them. Saving merges those changes onto the step's
existing multi-signal fingerprint, **preserving every other captured signal** (ancestor
chain, stable/module classes, DOM index, neighbor text, scope, bounding box), re-validates
the whole definition, and writes a new audited test version through the existing config-save
path (optimistic-locked); the edit applies on the next Run.

Steps with no element target — the entry navigation, full-page and region screenshots — must
not offer an editable locator. Editing a locator never changes a Checkpoint's name, so
baselines are untouched (no re-seed).

No step-schema change is needed (these signals already exist on the fingerprint); this slice
extends the test-config read-model and patch and the Test Details UI only.

## Acceptance criteria

- [ ] The test-config read-model exposes each step's current locator signals for click / type / element-mode screenshot, and exposes none for navigate, full-page and region screenshots.
- [ ] Editing role / accessibleName / text / testId and saving produces a new test version whose definition carries the merged fingerprint, with all non-edited signals preserved verbatim.
- [ ] Clearing a signal (empty value) removes just that signal; an omitted signal is left unchanged.
- [ ] A save based on a stale version is rejected (409) with a clear message.
- [ ] A locator that would be left with nothing to match on is rejected at save (400) with a reason.
- [ ] The new version is attributed to the editing user, and the editor remounts on the new version (dirty state cleared).
- [ ] Locator edits accumulate with wait / threshold edits and persist together in a single save.
- [ ] Editing a target does not change any checkpoint name; existing baselines are unaffected.
- [ ] End-to-end coverage at the test-config API seam (prior art: the schedules-config and audit config e2e specs).

## Blocked by

None — can start immediately.
