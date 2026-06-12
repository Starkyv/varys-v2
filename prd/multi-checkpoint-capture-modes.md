# PRD — Varys v2 Slice 3: Multi-Checkpoint + Capture Modes

> **Scope:** many checkpoints per test, **full-page & region** capture modes alongside element, and
> **recorder + in-viewer masking** with live per-checkpoint **threshold tuning** and **instant
> re-evaluation**. Slice 3 of the roadmap in `DESIGN.md` (table row 3): *"Many checkpoints/test,
> full-page & region modes, recorder/in-viewer masking. Depends on 1."* Picks up the items the
> Visual Review UI slice (slice 2) explicitly deferred here.
> **Status:** ready for implementation. *(Not published to an issue tracker — none configured; the
> `ready-for-agent` triage label could not be applied. Living here until a tracker is wired up.)*
> **Source of truth for the full platform:** `DESIGN.md` (esp. §2 screenshot-target selection, §3 step
> schema, §8 diff/comparison viewer). **Prior slices:** `prd/mvp.md`, `prd/visual-review-ui.md`.

## Problem Statement

A recorded test can check only **one element** in **one way**, and once a checkpoint diffs there is no
way to deal with a *false* diff except to let it fail or re-record from scratch. Three gaps bite in
real use:

1. **One checkpoint per test is too coarse.** A real screen has several regions worth guarding (header,
   a chart, a results table). Today each needs its own test and its own recording, which is tedious and
   fragments the review.
2. **Element-only capture can't express what I want to guard.** Some things are a whole page (a print
   layout, a dashboard), some are an arbitrary rectangle (a canvas, a map, a slice of a busy view) that
   isn't a single clean DOM element. I can only point at one element.
3. **Volatile content makes good tests cry wolf.** A timestamp, a random avatar, a live counter inside
   my checkpoint diffs on every run. I have no way to mask it out, and no way to nudge the sensitivity
   threshold and *see* whether that fixes it — so I either drown in false diffs or set the threshold so
   loose that real regressions slip through. And when several checkpoints in a run are all fine, I have
   to approve them one tediously-confirmed click at a time.

## Solution

A recording can designate **as many checkpoints as I like**, each captured in the mode that fits it —
**element**, **full-page**, or a **region** I rubber-band on the page. While designating a checkpoint
I can **draw mask rectangles** over the dynamic sub-regions (timestamps, random data) so the diff
ignores them. In the **diff viewer**, every checkpoint in a run shows up as its own panel; for a
diffing checkpoint I can **draw masks** and **nudge its threshold** right there and the viewer
**instantly re-evaluates** — re-diffing the images already captured, no re-run — so I can see whether
my tuning clears the false diff before I commit. When it's right, I **persist** the masks + threshold
back to the test so future runs inherit them. And when a run has several checkpoints all looking good,
I can **approve them all at once** behind the same irreversible confirmation.

This turns the single-element MVP loop into the real authoring-and-review loop: guard many regions,
capture them the way they actually look, and tune away false positives in seconds instead of
re-recording.

## User Stories

**Many checkpoints per test**
1. As a test author, I want to designate several checkpoints in one recording, so that I can guard multiple regions of a screen with a single test.
2. As a test author, I want each checkpoint to carry its own name, so that its baseline and review stay identifiable.
3. As a test author, I want each checkpoint to keep its own threshold and masks, so that a noisy region's tuning doesn't affect a clean one.
4. As a reviewer, I want a run with many checkpoints to show every checkpoint as its own panel in the diff viewer, so that I can review each independently.
5. As a reviewer, I want each checkpoint in a run that needs a decision to appear as its own entry in the needs-review list, so that nothing waiting on me is hidden behind a run-level summary.
6. As a tester, I want a run to be `needs_review` if *any* checkpoint needs review and `passed` only when all pass, so that the run status reflects the whole picture.

**Capture modes**
7. As a test author, I want to choose how a checkpoint is captured — element, full-page, or a region I draw — so that I can guard things that aren't a single clean DOM element.
8. As a test author capturing an **element**, I want to hover-highlight and click to pick it (as today), so that the common case stays one gesture.
9. As a test author capturing a **region**, I want to rubber-band a rectangle on the page, so that I can guard an arbitrary area like a canvas or a slice of a busy view.
10. As a test author capturing a **full page**, I want the whole scrollable page captured, so that I can guard a layout in one shot.
11. As a tester, I want full-page and region checkpoints to seed a baseline and diff against it exactly like element checkpoints, so that the lifecycle is identical regardless of mode.
12. As a tester, I want capture mode pinned in the test definition, so that replay captures the same way every run.
13. As a test author, I want my existing element-only tests to keep working unchanged, so that adding capture modes doesn't break what I already recorded.

**Recorder masking**
14. As a test author, I want to draw mask rectangles over dynamic sub-regions while designating a checkpoint, so that volatile content doesn't cause false diffs from the very first run.
15. As a test author, I want masks captured in the same gesture as the checkpoint, so that masking is part of authoring, not a separate chore.
16. As a tester, I want masked regions ignored by the diff on every run, so that a region that changes every run never produces a diff.

**In-viewer masking, threshold tuning & instant re-evaluation**
17. As a reviewer looking at a diff, I want to draw mask rectangles directly on the checkpoint, so that I can suppress a false diff I didn't anticipate at record time.
18. As a reviewer, I want to see the masks already on a checkpoint and remove or add to them, so that I can correct masking over time.
19. As a reviewer, I want to nudge the checkpoint's threshold with a control, so that I can tune sensitivity to the content.
20. As a reviewer, I want the viewer to **instantly re-evaluate** the diff when I change masks or threshold — re-diffing the images already captured, with no re-run — so that I can tell in seconds whether my tuning clears the false diff.
21. As a reviewer, I want the re-evaluation to show the new diff score, the new verdict, and an updated diff image, so that I'm deciding on the tuned result, not the original.
22. As a reviewer, I want to **persist** my masks + threshold back to the test, so that future runs inherit them and the false diff doesn't recur.
23. As a reviewer, I want persisting to also resolve the checkpoint I'm looking at when the tuned result is now within threshold, so that clearing a false positive and moving on is one flow.
24. As a reviewer, I want re-evaluation and persisting to never launch a browser or re-run the test, so that tuning stays instant.
25. As a test author, I want persisted masks/threshold to produce a new test version, so that the edit is captured in history like any other definition change.
26. As an auditor, I want a persisted tuning edit recorded with who and when, so that there's a trail for changes to what a test ignores.
27. As a reviewer, I want tuning to affect only this checkpoint and only future runs (plus the checkpoint I'm resolving) — not silently re-judge other past runs — so that history stays truthful.

**Bulk approval**
28. As a reviewer, I want to approve every checkpoint needing a decision in a run in one action, so that I don't click through a dozen confirms when they're all fine.
29. As a reviewer, I want bulk approve gated behind the same irreversible hard-confirm as a single approve — naming that it replaces multiple baselines — so that a destructive batch action isn't a stray click.
30. As a reviewer, I want bulk approve to act only on checkpoints currently needing review, so that it never touches already-decided or passing ones.
31. As an auditor, I want each baseline a bulk approve creates/replaces recorded with who and when, so that the batch is as audited as individual approvals.

**Fit & operability**
32. As a reviewer, I want the viewer to show each checkpoint's capture mode, so that I understand what I'm looking at (an element vs. the full page vs. a region).
33. As a developer, I want capture mode and masks expressed in the shared step schema and review-contract, so that recorder, runner, API, and SPA agree on one shape.

## Implementation Decisions

**This slice fills gaps in modules that already exist** — it adds no new service. Multi-checkpoint is
already plumbed (the runner loops over screenshot steps → one `run_result` per checkpoint; the
review-contract `RunView.checkpoints` is already an array; the web `DiffViewer` already maps a panel
per checkpoint; the recorder/extension already let you pick several checkpoints). The diff-engine
already honors `rect` masks, and `screenshotStep.masks: Rect[]` already exists. The work is **capture
modes, the UIs that *produce* masks, instant re-evaluation, persisting edits, and bulk approve.**

**Step schema (`step-schema`) — capture mode on the screenshot step.** The screenshot step gains
`captureMode: 'element' | 'fullpage' | 'region'`. `target` (Fingerprint) is required for `element`,
`rect` (Rect) is required for `region`, and `fullpage` needs neither. **Backward compatibility:** a
screenshot step with no `captureMode` parses as `element` (existing recordings and tests keep working).
Masks stay `Rect[]` in **screenshot-pixel space** — the diff-engine's coordinate space — so they apply
directly at diff time; the recorder and viewer translate from on-screen coordinates when drawing. This
follows the `DESIGN.md` §3 shape; fingerprint-based masks are out of scope (the diff-engine is
rect-based).

**Runner — capture by mode.** Element captures the resolved locator (as today); `fullpage` captures
the whole scrollable page; `region` captures the clipped rectangle. Determinism pinning (fixed
viewport/DPR, reduced motion, masks) applies to all modes. Baseline keying is unchanged
(`test, checkpoint_name, environment, viewport`) and works for every mode. Masks continue to be applied
by the diff-engine.

**Recorder + extension — capture modes and masking.** Inspect mode gains a **mode selector** (element /
full-page / region). Element is the existing hover-highlight + click pick; region is a rubber-band
rectangle; full-page takes no target. After designating a checkpoint, the author can draw zero or more
**mask rectangles** over dynamic sub-regions in the same gesture (`DESIGN.md` §2). The recorder's
`checkpoint(...)` API widens to carry `captureMode`, `target | rect`, and `masks`; designating several
checkpoints in one session already works.

**Review-contract — expose mode and masks.** `CheckpointView` gains `captureMode` and `masks: Rect[]`
so the viewer can label the capture and render/edit existing masks. `NeedsReviewItem` stays
per-checkpoint (unchanged). The verdict remains server-computed and display-only on the client.

**API — instant re-evaluation (the false-positive-fatigue defense).** A new **re-evaluate (preview)**
action takes a run + checkpoint + candidate `masks` + candidate `threshold` and re-runs **only the
diff** against the **already-stored baseline and actual** artifacts (via `diff-engine`, no browser, no
re-run), returning the new `verdict`, `score`, and a transient diff image. Nothing is persisted — this
powers the live preview. A separate **persist tuning** action commits the masks + threshold: it writes
a **new `test_version`** with that screenshot step's `masks`/`threshold` updated (definitions are
versioned and edited atomically per `DESIGN.md` §3), records approver + timestamp (audited), and
**re-evaluates the current checkpoint's `run_result`** to the tuned verdict — so a now-within-threshold
checkpoint flips to `passed` and leaves the needs-review list. It does **not** re-judge any other
historical run.

**API — bulk approve.** A new **approve-all-in-run** action approves every checkpoint in a run that
currently needs review (`pending-baseline` or `diff`) in one audited operation — seeding/replacing each
baseline exactly as a single approve does, recording approver + timestamp per baseline. It touches only
checkpoints needing review; passing/already-decided ones are untouched. Bulk *reject* is out of scope
(rejection is per-regression). Single-checkpoint approve/reject (slice 2) is unchanged.

**Web (`apps/web`) — the authoring-grade viewer.** Per checkpoint panel: show the **capture mode**; an
interactive **mask-drawing overlay** on the image (rubber-band rects, list, remove); a **threshold
control**; on any mask/threshold change, call the re-evaluate preview and show the new score/verdict +
previewed diff image; a **persist** button to commit (new version + resolve current). At the run level:
an **"Approve all"** action behind the existing irreversible hard-confirm, worded for replacing
multiple baselines.

## Testing Decisions

**What makes a good test here:** it asserts **external behavior** — the *emitted definition shape*
(recorder/capture), *HTTP responses + persisted state + stored artifacts + computed verdicts* (API),
and *what the reviewer sees plus the requests that cross the HTTP boundary* (web) — never component
internals, hook state, or class names. Tests are deterministic, run against the in-repo `fixture-app`
(using `setVariant()` to force a diff) and committed image fixtures, never the live network. **All
seams already exist — no new harness.**

**Pure-unit seams:**
- **`step-schema`** — parse round-trips for all three capture modes (element requires `target`, region
  requires `rect`, fullpage needs neither) and for masks; **backward-compat**: a step with no
  `captureMode` parses as `element`.
- **`recorder`** — designate element / full-page / region checkpoints and draw masks → assert the
  emitted screenshot steps carry the right `captureMode`, `target | rect`, and `masks`; assert several
  checkpoints in one session.
- **`capture`** — region/mode capture produces the expected `rect`.
- **`diff-engine`** — masks already covered (prior art); add a "mask clears an otherwise-diffing region"
  case since re-evaluation leans on it.

**API full-thread E2E seam** (`apps/api/test/baseline.e2e.spec.ts` pattern — testcontainers Postgres +
`fixture-app` + `LocalFsAdapter` + real `processRun`):
- a **full-page** checkpoint seeds a baseline and diffs against it; a **region** checkpoint does the same;
- a **multi-checkpoint** run produces one `run_result` per checkpoint, surfaces one needs-review item
  each, and is `needs_review` when any checkpoint needs review;
- **instant re-evaluation**: re-diffing stored baseline+actual with new masks lowers the score / flips
  the verdict, and captures **no new actual** (asserting no re-run happened);
- **persist tuning**: writes a new `test_version` with the updated masks/threshold, resolves the current
  checkpoint, and a **subsequent run honors the masks** (a region that changes every run no longer diffs);
- **bulk approve**: every needing-review checkpoint's baseline is seeded/replaced and audited; passing
  ones are untouched.

**Web seams (slice-2 conventions):**
- **MSW component tests** (`DiffViewer.test.tsx`) — drawing a mask emits rects and fires a re-evaluate
  request; the previewed score/verdict/diff render; the threshold control triggers re-evaluation;
  persist fires the commit request; **"Approve all"** is reachable only after clearing the hard-confirm
  and fires the bulk request.
- **Playwright browser E2E over the real stack** — open a diffing checkpoint → draw a mask → watch it
  re-evaluate to within-threshold → persist → assert (via the API) the next run honors it; bulk-approve
  a multi-checkpoint run and assert all baselines were created.

**Prior art:** `apps/api/test/baseline.e2e.spec.ts` (full-thread, `fixture-app.setVariant()` to force
diffs), the `diff-engine` mask tests, `packages/recorder` unit spec, and the slice-2
`DiffViewer.test.tsx` / `NeedsReviewList.test.tsx` MSW tests plus the slice-2 browser E2E.

## Out of Scope

- **Swipe-slider and onion-skin/blink view modes** (`§8`) — still deferred; this slice keeps
  side-by-side + diff-highlight overlay.
- **Fingerprint-based masks** — masks stay rectangles in screenshot-pixel space (the diff-engine is
  rect-based); a mask that follows a moving element is not in scope.
- **Re-judging other historical runs** when masks/threshold change — only the checkpoint being resolved
  re-evaluates; only future runs use the new test version. Past runs stay as recorded.
- **Bulk reject** — only bulk *approve* is in scope.
- **Confidence-scored locator** (slice 13), **suite runs / parallelism** (slice 6), **dashboard**
  (slice 7), **scheduling + notifications** (slice 8), **timeline / trace viewer** (slice 9),
  **auth / RBAC** (slice 10), **cloud storage** (slice 11) — all later slices.
- **Responsive multi-viewport and cross-browser** capture — single captured viewport, chromium-only,
  per `DESIGN.md` §3.
- **Environment management UI** (slice 4) — runs still target an environment by id as today.

## Further Notes

- **Instant re-evaluation must never re-run.** It re-diffs the already-stored baseline + actual via the
  diff-engine — no browser launch, no new capture. That "no re-run" property is what makes tuning
  instant and is the slice's primary defense against false-positive fatigue (`DESIGN.md` §8); assert it
  explicitly (no new actual artifact is written during a re-evaluation).
- **Backward compatibility is a hard requirement.** Existing element-only recordings and tests must
  parse and replay unchanged; `captureMode` defaults to `element` when absent.
- **Persisting tuning is a versioned edit**, not an in-place mutation — it produces a new `test_version`
  (consistent with the versioned-immutable definition model, `DESIGN.md` §3) and is audited like a
  baseline approval. It re-evaluates only the current checkpoint's result; it does not rewrite history.
- **Coordinate space:** masks and region rects live in screenshot-pixel space (what the diff-engine
  consumes); the recorder and viewer translate from on-screen coordinates when drawing them.
- **Bulk approve is more destructive than a single approve** (it replaces N baselines, each irreversibly
  — accepted risk #1) — it reuses the same hard-confirm, worded to name the batch.
- Determinism pinning applies equally to full-page and region captures.
- Suggested build order: schema `captureMode` + runner full-page/region (prove via API E2E) →
  multi-checkpoint review polish + bulk approve → recorder masking + capture-mode selection (recorder
  unit + extension) → review-contract `captureMode`/`masks` → instant re-evaluation endpoint →
  in-viewer mask drawing + threshold tuning + persist (MSW + browser E2E last).
- Next step after this PRD: run **`/to-issues`** to cut it into tracer-bullet vertical slices (e.g.
  capture modes → recorder masking → in-viewer masking + re-eval + persist → bulk approve).
