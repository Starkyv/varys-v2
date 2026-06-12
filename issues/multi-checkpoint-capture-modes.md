# Issues — Varys v2 Slice 3: Multi-Checkpoint + Capture Modes

> Tracer-bullet issues for the Multi-Checkpoint + Capture Modes slice
> (`prd/multi-checkpoint-capture-modes.md`). Each is a thin vertical cut through every layer
> (step-schema → runner/API → recorder/extension → review-contract → `apps/web` → tests), demoable on
> its own.
> *Not published to an issue tracker — none configured; the `ready-for-agent` label could not be
> applied. Build order = dependency order below.*
>
> **Already plumbed (not re-built here):** multi-checkpoint runs (the runner loops over screenshot
> steps → one `run_result` each; `RunView.checkpoints` is an array; the web `DiffViewer` renders a
> panel per checkpoint; the extension already picks several checkpoints) and rect-mask honoring in the
> `diff-engine`. This slice adds capture modes, the UIs that *produce* masks, instant re-evaluation,
> persisting edits, and bulk approve.
>
> **Dependency shape:** `{1, 2}` can start immediately; `1 → {3, 4}`; `4 → 5`.
>
> **Status: 🟡 Wrapping up — all issues implemented; Issue 4's HITL UX review is the last gate.**
>
> | Issue | Status |
> |---|---|
> | 1 — Capture modes (full-page & region) | ✅ Done |
> | 2 — Bulk "approve all in run" | ✅ Done |
> | 3 — Recorder masking | ✅ Done |
> | 4 — In-viewer masking + re-evaluation + persist | 🟡 Implemented — HITL UX review pending |
> | 5 — In-viewer threshold tuning | ✅ Done |

---

# Issue 1 — Capture modes: full-page & region checkpoints, record → replay → diff

**Type:** AFK · **Status: ✅ Done**

## What to build

Let a checkpoint be captured as the whole page or an arbitrary rectangle, not just a single element.
The screenshot step gains a `captureMode` of `element | fullpage | region`: `element` keeps its
Fingerprint target, `region` carries a `rect`, `fullpage` needs neither. Existing recordings and tests
must keep working — a screenshot step with no `captureMode` is treated as `element`. The runner
captures accordingly (element locator as today; full scrollable page; clipped rectangle), with the same
determinism pinning and the same baseline lifecycle and keying regardless of mode. The recorder and
extension inspect-mode gain a mode selector — element is the existing hover-highlight + click pick,
region is a rubber-band rectangle, full-page takes no target — and designating several checkpoints in
one session continues to work, each with its own name. The review-contract exposes `captureMode` and
the diff viewer labels each checkpoint with how it was captured.

## Acceptance criteria

- [x] The screenshot step accepts `captureMode: element | fullpage | region`; element requires a target, region requires a rect, fullpage requires neither.
- [x] A screenshot step with no `captureMode` parses and replays as `element` (existing tests/recordings unchanged).
- [x] A full-page checkpoint seeds a baseline and diffs against it exactly like an element checkpoint.
- [x] A region checkpoint (clipped rect) seeds a baseline and diffs against it exactly like an element checkpoint.
- [x] The recorder/extension inspect-mode lets the author choose element / full-page / region and designate several named checkpoints in one session. *(overlay mode selector; region = rubber-band, full page = one click)*
- [x] `CheckpointView` carries `captureMode`; the viewer shows each checkpoint's capture mode. *(derived from the run's definition; no DB migration)*
- [x] step-schema unit tests cover all three modes plus the element-default back-compat; recorder/capture unit tests assert the emitted definition carries the right mode + target/rect.
- [x] API full-thread E2E (testcontainers Postgres + fixture-app + local-FS + real replay) proves full-page and region checkpoints seed and diff.

## Blocked by

None - can start immediately.

---

# Issue 2 — Bulk "approve all in run"

**Type:** AFK · **Status: ✅ Done**

## What to build

Resolve a whole run of good checkpoints in one action instead of confirming each. A new
approve-all-in-run API action approves every checkpoint in a run that currently needs review
(`pending-baseline` or `diff`) in a single audited operation — seeding or replacing each baseline
exactly as a single approve does, recording approver + timestamp per baseline — and touches only
checkpoints needing review, never passing or already-decided ones. The diff viewer gains a run-level
"Approve all" action gated behind the same irreversible hard-confirmation as a single approve, worded
to name that it replaces multiple baselines. Single-checkpoint approve/reject (slice 2 of the platform)
is unchanged; bulk reject is out of scope.

## Acceptance criteria

- [x] An approve-all-in-run action approves every `pending-baseline`/`diff` checkpoint in a run in one operation. *(`POST /runs/:id/approve-all` → `RunsService.approveAll`, reusing the single-approve path per checkpoint.)*
- [x] Passing and already-decided checkpoints are untouched by bulk approve. *(candidate filter: `reviewState ∈ {pending-baseline,diff}` AND `resolution IS NULL`.)*
- [x] Each baseline seeded/replaced by a bulk approve records approver + timestamp (audited like a single approve). *(inherits single-approve audit.)*
- [x] The viewer's "Approve all" is reachable only after clearing the irreversible hard-confirm, worded for replacing multiple baselines. *(run-level `RunApproveAll` control + confirm dialog.)*
- [x] After bulk approve, every approved checkpoint leaves the needs-review list and the run reflects its new state. *(mutation invalidates run + needs-review queries.)*
- [x] API full-thread E2E: a multi-checkpoint run is fully resolved by one bulk approve, with per-baseline audit and already-decided checkpoints untouched. *(MSW component test intentionally skipped per direction — UI-level tests are out of scope for this slice.)*

## Blocked by

None - can start immediately *(operates on the existing multi-checkpoint plumbing; parallel with Issue 1)*.

---

# Issue 3 — Recorder masking: draw masks while designating a checkpoint

**Type:** AFK · **Status: ✅ Done** *(extension drawing UX is manual-verified — no MV3 E2E harness.)*

## What to build

Let the author suppress volatile content at record time. While designating a checkpoint (in any capture
mode), the author can draw zero or more mask rectangles over dynamic sub-regions — timestamps, random
data — in the same gesture. The recorder emits these as `masks` (rectangles in screenshot-pixel space)
on the screenshot step; the runner already honors them via the diff-engine, so a masked region that
changes every run produces no diff from the very first run. Each checkpoint keeps its own masks.

## Acceptance criteria

- [x] The recorder/extension lets the author draw mask rectangles in the same gesture as designating a checkpoint. *(after picking element/region/full-page, a mask-drawing phase: drag rects within the capture bounds → Done; Esc skips.)*
- [x] The emitted screenshot step carries the drawn masks as rectangles; each checkpoint has its own masks. *(`CheckpointSpec.masks` → forwarded onto the step; omitted when empty.)*
- [x] A recorded checkpoint with a mask over a region that changes every run does not produce a diff. *(runner already honors `step.masks` via the diff-engine.)*
- [x] Recorder unit test asserts masks appear on the emitted definition; API full-thread E2E proves a masked dynamic sub-region (fixture `stampA`/`stampB`) does not diff while an unmasked control does.

## Implementation notes

- **Recorder package:** `CheckpointSpec` gains an optional `masks?: Rect[]` per variant; `checkpoint()` forwards them onto the screenshot step. The content script computes mask rectangles in **screenshot-pixel space**: it draws in displayed CSS pixels within the capture bounds, then converts by `× devicePixelRatio` (and, for full-page only, adds the scroll offset since that capture starts at page 0,0).
- **Extension UX (manual-verified):** picking a target enters a mask-drawing phase with a floating Done / Clear / Cancel banner; this is the same family of surface as the recorder overlay and is worth a glance alongside Issue 4's HITL review.
- **Fixture:** added `stampA`/`stampB` variants — a stable hero with one volatile sub-region (`#stamp`), so a mask over that region isolates the masking behavior in the E2E.

## Blocked by

- Issue 1 — Capture modes *(extends the same recorder/inspect-mode designation flow)*.

---

# Issue 4 — In-viewer mask drawing + instant re-evaluation + persist

**Type:** HITL — the interactive direct-manipulation mask-drawing canvas is the most novel UX surface in
the slice and gets a human UX review before merge. The behavior (re-evaluation never re-runs; persisting
writes a new test version) is decided in the PRD; the review is on the interaction, not the architecture.

## What to build

Let a reviewer kill a false diff without re-recording. The review-contract exposes each checkpoint's
existing `masks`. The diff viewer gains an interactive overlay to draw, list, and remove mask rectangles
on a checkpoint. On any change, the viewer calls a new **re-evaluate (preview)** API action that re-runs
**only the diff** against the **already-stored baseline and actual** artifacts (via the diff-engine — no
browser, no re-run) and returns the new verdict, score, and a transient diff image, which the viewer
displays live. A **persist** action commits the masks: it writes a new `test_version` with that
screenshot step's masks updated (audited with approver + timestamp), and re-evaluates the current
checkpoint's `run_result` so a now-within-threshold checkpoint flips to `passed` and leaves the
needs-review list. Persisting affects only the current checkpoint and future runs — it never re-judges
other historical runs.

## Acceptance criteria

- [x] `CheckpointView` exposes the checkpoint's current masks; the viewer renders them and lets the reviewer add/remove mask rectangles. *(masks sourced from the latest test version; `MaskEditor` draws/lists/removes rects.)*
- [x] Changing masks triggers a re-evaluate that re-diffs the stored baseline+actual and shows the new score/verdict/diff image — with no new actual captured (no re-run). *(`POST …/re-evaluate` → diff-engine on stored bytes; transient diff as a data URL.)*
- [x] Persisting masks writes a new `test_version` with the updated masks, audited with approver + timestamp. *(`POST …/persist`; `test_versions.created_by` + `created_at`.)*
- [x] Persisting re-evaluates the current checkpoint; one now within threshold flips to `passed` and leaves the needs-review list.
- [x] A subsequent run of the test honors the persisted masks (a region that diffed no longer diffs). *(runs use the latest version's masks.)*
- [x] No other historical run's verdict is changed by a persist. *(only this run_result is updated.)*
- [x] API full-thread E2E: draw a mask on a diffing checkpoint → re-evaluate within threshold → persist → the next run honors it; other runs untouched. *(MSW component + browser E2E skipped per direction — UI-level tests out of scope.)*
- [ ] **The mask-drawing interaction passes human UX review (HITL gate) before merge.** ← open

## Implementation notes

- **Decisions:** two endpoints (`re-evaluate` preview = no mutation; `persist` = commit). `CheckpointView.masks` comes from the **latest** test version (so the editor shows the *current* masks, reflecting a prior persist). Persist branches from the latest version and audits via new `test_versions.created_by`. Both endpoints accept an optional `threshold` so **Issue 5 reuses the same surface**.
- **Masks are in screenshot-pixel (natural image) space.** The editor draws in displayed space and converts via the image's natural/displayed ratio, positioning overlays with percentages so they track the responsively-scaled image.
- **Fixture limitation in the E2E:** the `changed` variant recolors the whole `#hero` element, so the test masks the full element to force a match. A sub-region mask scenario needs a fixture variant that changes only part of an element.

## Blocked by

- Issue 1 — Capture modes *(shares the review-contract and capture-mode-aware viewer)*.

---

# Issue 5 — In-viewer threshold tuning

**Type:** AFK · **Status: ✅ Done**

## What to build

Add live sensitivity tuning alongside in-viewer masking. The diff viewer gains a per-checkpoint
threshold control; changing it feeds the same re-evaluate (preview) action built in Issue 4 (candidate
threshold + current masks → re-diff of stored artifacts) and shows the new verdict/score/diff live.
Persisting writes the threshold into the new `test_version` (alongside masks) and re-evaluates the
current checkpoint, exactly as masking does. No re-run.

## Acceptance criteria

- [x] The viewer offers a per-checkpoint threshold control. *(slider in `TuningEditor`, initialised to the checkpoint's current threshold.)*
- [x] Changing the threshold triggers an instant re-evaluation of the stored artifacts (no re-run) and shows the new score/verdict. *(reuses Issue 4's `re-evaluate` with `{ masks, threshold }`.)*
- [x] Persisting writes the threshold into a new `test_version` and re-evaluates the current checkpoint. *(reuses Issue 4's `persist`; the runner already reads `step.threshold`.)*
- [x] A subsequent run uses the persisted threshold. *(covered by API E2E.)*
- [x] API full-thread E2E: a persisted threshold re-judges the checkpoint and is honored by a later run. *(MSW component test skipped per direction — UI-level tests out of scope.)*

## Implementation note

Issue 5 is almost entirely additive UI: the re-evaluate/persist API surface (and `TuningInput.threshold`) was built in Issue 4, and the runner already honored `step.threshold`. The slice adds a threshold slider to the editor (so it tunes masks + threshold together) and one E2E proving the persisted threshold is honored.

## Blocked by

- Issue 4 — In-viewer mask drawing + instant re-evaluation + persist *(reuses its re-evaluate/persist surface)*.
