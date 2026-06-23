# Live verify — editor UI (Slice 16.3b)

**Type:** AFK

## Parent

PRD: `prd/locator-editor-live-verify.md` (DESIGN §14 — Slice 16). Covers user stories
10, 11, 12, 13, 14, 15, 16, 23 (UI portions) and 24.

## What to build

Wire a **"Verify against [environment ▾]"** control into the locator editor that checks the
author's **current unsaved candidate** locator against the verify backend and renders the
verdict inline: **resolved** (with the matched signal), **ambiguous**, or **not-found**; a
**self-heal / fragile-match** warning when the match leaned on a weaker signal; or the
**failed drive step** when the path to the step is broken. The author can iterate
edit → verify → edit before saving anything.

The environment picker mirrors the Run pre-flight: required (with the satisfied-check) when
the test declares variables, hidden/optional for a no-variable test. A short note makes clear
that verify performs a **real partial replay** — the preceding steps execute, with the same
side effects a Run would have.

## Acceptance criteria

- [ ] The Verify control sends the current unsaved candidate locator + chosen step + selected environment to the verify endpoint.
- [ ] The verdict renders inline: resolved (with matched signal), ambiguous, or not-found.
- [ ] A healed / fragile match is visibly flagged; a failed drive step names the step that could not be performed.
- [ ] The environment picker mirrors the Run pre-flight (required + satisfied-check when the test has variables; absent/optional otherwise).
- [ ] The user can iterate edit → verify → edit before saving (the candidate, not the saved state, is what is verified).
- [ ] A note communicates that verify is a real partial replay (preceding steps execute with their side effects).

## Blocked by

- Slice 16.3a — Live verify: partial-replay backend (`issues/locator-3a-verify-backend.md`).
