# Locator editor — raw selector override (Slice 16.2)

**Type:** AFK

## Parent

PRD: `prd/locator-editor-live-verify.md` (DESIGN §14 — Slice 16). Covers user stories 5, 6.

## What to build

Let the author pin a stubborn element with a **raw selector override** (CSS or test-id),
edited under an Advanced disclosure in the locator editor. The override is **used as-is when
set**: the scored matcher tries it first and, if it resolves to exactly one element, that
wins (matched signal reported as `override`). If the override is stale or matches more than
one element, the matcher **falls through to the existing multi-signal scoring** (self-heal) —
so a hand-written selector is authoritative without becoming a new single point of failure.

The override is stored as a new **author-only** field on the fingerprint, distinct from the
recorder-captured CSS path (whose existing last-resort-for-screenshots semantics are left
unchanged). It round-trips through the config read-model, the patch, and a save into a new
version, exactly like the structured signals.

## Acceptance criteria

- [ ] The step schema gains an optional author-only selector override on the fingerprint, distinct from the recorder's captured CSS path.
- [ ] The matcher honors the override as top priority: a unique match wins with matched signal `override`.
- [ ] A stale or non-unique override does not win — the matcher falls through to the scored bundle and reports the bundle's matched signal (and the healed flag where applicable).
- [ ] The override is surfaced (read) and editable (patch) via the test-config contract and the editor's Advanced section, and round-trips through a save into a new version.
- [ ] Unit tests in the locator engine cover: override wins on a unique match; stale override falls through to the bundle; an override matching multiple elements does not win (prior art: the existing locator-engine resolve tests against the fixture app).

## Blocked by

- Slice 16.1 — Locator editor: edit structured signals (`issues/locator-1-edit-structured-signals.md`).
