# PRD — Locator editor + live verify (Slice 16)

> Editable locators in the Test Details screen, plus a one-click "does this still
> resolve?" check that runs the **real** matcher against a chosen environment — so a
> brittle or wrong click target can be fixed in place instead of re-recording the whole
> test, and the fix is verified *before* the next Run rather than discovered when a Run
> fails with "could not locate target".

This is the first slice of the broader "configurable Test Details" effort. It deliberately
covers **only the locator** (the click/type/element-screenshot `target` fingerprint) plus
the verify probe. Editing typed values, URLs, capture modes, masks, checkpoint names, step
order, and test-level metadata are separate later slices.

## Problem Statement

When I open a test in the Test Details screen, each step shows a read-only label (e.g.
`click "Submit"`). If the recorder captured a brittle or wrong locator for a step — it
targets the wrong element, leans on volatile visible text, or stops resolving after the app
changes — I have **no way to fix that locator**. My only options are to delete the whole
step or re-record the entire test from scratch, both of which throw away unrelated work.

Worse, I find out a locator is broken only **after** I trigger a Run and it hard-fails with
`could not locate <type> target` / `no fingerprint signal matched`. There is no way to ask,
ahead of a Run, "does this locator still point at the right element in environment X?" So
fixing locator drift is a slow, blind, trial-and-error loop of edit-by-re-recording →
run → read the failure → repeat.

## Solution

The Test Details screen gains an editable **Locator** section on every step that has a
target (click, type, and element-mode screenshot). I can edit the locator's high-value
signals as structured fields — **role**, **accessible name**, **visible text**, **test id**
— and, under an Advanced disclosure, set a **raw selector override** that is used as-is when
present. The rest of the captured multi-signal fingerprint (ancestor chain, stable classes,
bounding box, scope, neighbor text) is preserved untouched, so editing a locator never
collapses it to a single brittle selector.

Next to the editor is a **Verify** control: pick an environment and Varys runs a transient,
artifact-free **partial replay** — it drives the preceding steps in a short-lived
server-side browser to reach the right page state, then resolves my candidate locator there
using the *exact same scored matcher and variable resolution a real Run uses_. It reports
back **resolved / ambiguous / not-found**, **which signal won**, and whether it had to
**self-heal** (lean on a weaker signal) — and, if the drive failed earlier, which step it
got stuck on. Because it's the real matcher on the real page, "verified here" means "will
resolve at Run time."

Saving an edit writes a new audited test version through the existing config-save path
(optimistic-locked, schema-validated, attributed to me), applied on the next Run. Editing a
locator never changes a checkpoint's name, so baselines are untouched — no re-seed.

## User Stories

1. As a test maintainer, I want to see a step's current locator broken into its meaningful signals (role, name, text, test id), so that I understand *why* it matches and what I can safely change.
2. As a test maintainer, I want to edit a click step's accessible name, so that I can fix a locator that broke when the button's label changed — without re-recording the test.
3. As a test maintainer, I want to edit a step's role and visible text, so that I can disambiguate a locator that started matching the wrong element.
4. As a test maintainer, I want to clear a volatile signal (e.g. environment-specific visible text) from a locator, so that the matcher leans on the durable structural signals instead.
5. As a test maintainer, I want to set a raw selector override (CSS or test-id) under an Advanced section, so that I can pin a stubborn element exactly when the structured signals can't.
6. As a test maintainer, I want the override to be used as-is when set but to fall back to the multi-signal bundle if it goes stale, so that a hand-written selector is authoritative without becoming a new single point of failure.
7. As a test maintainer, I want to edit the locator for a `type` step the same way as a click, so that data-entry steps are as fixable as clicks.
8. As a test maintainer, I want to edit the locator for an element-mode checkpoint, so that I can re-aim a screenshot at the right element without re-recording.
9. As a test maintainer, I want locators to be read-only / hidden for steps that have no element target (the entry navigation, full-page and region screenshots), so that I'm never offered an edit that doesn't apply.
10. As a test maintainer, I want to click "Verify" and pick an environment, so that I can check my edited locator resolves before committing it.
11. As a test maintainer, I want Verify to report whether the locator **resolved**, was **ambiguous** (a tie), or was **not found**, so that I know exactly what's wrong.
12. As a test maintainer, I want Verify to tell me **which signal matched** (e.g. role+name, override, stable classes), so that I know how robust the match is.
13. As a test maintainer, I want Verify to flag when the match **self-healed** onto a weaker signal, so that I know the locator is fragile even though it technically resolved.
14. As a test maintainer, I want Verify to tell me when an **earlier step in the drive** failed (and which one), so that I can tell "my locator is wrong" apart from "the path to this step is broken".
15. As a test maintainer verifying a test that uses variables/secrets, I want to choose an environment whose values fill the tokens, so that the partial replay reaches the same page a real Run would.
16. As a test maintainer of a no-variable test, I want Verify to run without forcing me to pick an environment, so that simple tests stay frictionless.
17. As a test maintainer, I want my locator edits to accumulate with my other config edits (waits, thresholds) and save together, so that one "Save changes" writes one new version.
18. As a test maintainer, I want a stale edit (someone saved a newer version meanwhile) to be rejected with a clear message, so that I don't silently clobber their change.
19. As a test maintainer, I want an invalid locator (e.g. nothing left to match on) to be rejected at save with a clear reason, so that I can't persist a definition that can never resolve.
20. As a test maintainer, I want the saved edit attributed to me with a new version number, so that the change is auditable and I can see it took effect.
21. As a test maintainer, I want to know that editing a locator won't disturb the checkpoint's baseline, so that I can fix locators without an unexpected re-approval cycle.
22. As a reviewer, I want the verify result to be transient (no Run, no artifacts, no history rows), so that probing a locator doesn't pollute the Runs list or storage.
23. As a test maintainer, I want a clear indication that Verify performs a real partial replay (it executes the preceding steps), so that I'm not surprised that it can have the same side effects as a Run.
24. As a test maintainer, I want my unsaved candidate locator to be the one Verify checks, so that I can iterate edit→verify→edit before saving anything.

## Implementation Decisions

### Locator as structured signals + a raw override (the "both" decision)
- The editor surfaces four **structured signals** — `role`, `accessibleName`, `text`,
  `testId` — and, under Advanced, a **raw selector override**. Editing the structured
  fields merges onto the step's existing `Fingerprint`; all other captured signals
  (`ancestors`, `stableClasses`, `moduleClasses`, `domIndex`, `neighborText`, `scope`,
  `boundingBox`) are **preserved untouched**. We never collapse a step to a single selector
  (DESIGN §2: "capturing only a single selector is the one unrecoverable mistake").
- A new **author-only** optional field is added to the `Fingerprint` step-schema:
  `selectorOverride?: string`. It is distinct from the recorder-captured `cssPath` (whose
  semantics — last-resort fallback for screenshots only — are left unchanged). The matcher
  (`@varys/locator-engine`) gains a **top-priority override branch**: when
  `selectorOverride` is set, try it first; if it resolves to exactly one element, use it
  (`matchedSignal: "override"`); otherwise fall through to the existing scored bundle. This
  makes "used as-is when set" true for clicks *and* screenshots while keeping the self-heal
  guarantee — a stale override degrades to the bundle rather than hard-failing.

### Editing rides the existing config-save seam (no new write path, no new tables)
- Extend the existing test-config read-model and patch (the `GET`/`PUT /tests/:id/config`
  contract), rather than adding a parallel surface:
  - `TestConfigStep` gains `target: FingerprintSummary | null` — the editable locator,
    populated for `click` / `type` / element-mode `screenshot`; `null` for `navigate`,
    full-page and region screenshots. Reuse the existing `FingerprintSummary` shape and the
    server's `summarizeFingerprint` projection (already used by the Run-detail "what the
    locator looked for" panel).
  - `TestConfigStepPatch` gains `target?: FingerprintPatch` — the editable subset
    `{ role?, accessibleName?, text?, testId?, selectorOverride? }`. An empty string clears
    that signal; an omitted key leaves it unchanged.
- `saveConfig` applies `target` by merging the patch onto the step's fingerprint, then
  re-validates the whole definition with the Zod step schema and writes a **new
  `test_version`** (latest+1, `created_by` = the editor) under the existing optimistic
  concurrency check (`baseVersion` mismatch → 409). No DB schema changes; locator edits live
  in the versioned `test_versions.definition` like every other definition edit.
- Editing a `target` does **not** touch `screenshot.name`, so the `(test, checkpoint, env,
  viewport)` baseline key is unchanged — no baseline orphaning, no re-seed. (Checkpoint
  rename is explicitly a later slice precisely because it *does* touch that key.)

### Live verify = transient, artifact-free partial replay with the real matcher
- New endpoint **`POST /tests/:id/config/verify`**. Request:
  `{ stepIndex, environmentId?, target: FingerprintPatch }`. Response:
  `{ status: "resolved" | "ambiguous" | "not-found", matchedSignal?, healed?, reachedStep, failedStepIndex?, failedStepLabel? }`.
- Mechanism: launch a short-lived headless Chromium (same launch args as the Authoring
  Session), resolve the test's variable/secret tokens for the chosen environment via
  `@varys/variable-resolver`, **drive steps `[0 .. stepIndex)`** to reach the page state,
  then resolve the **candidate** (merged) fingerprint at `stepIndex` via
  `@varys/locator-engine.resolve`. No run row, no `run_results`, no baselines, no queue
  enqueue, no stored artifacts.
- To guarantee "verified here = resolves at Run time", factor the step-driving core out of
  the runner's `processRun` into a reusable "drive to step N" function in `@varys/runner`,
  and have both the Run and the Verify probe call it. The probe substitutes the candidate
  target at the final step instead of the saved one. (Proposed new seam — see Testing.)
- Environment selection mirrors the Run pre-flight contract: a test that declares variables
  requires an environment that satisfies them; a no-variable test verifies env-less
  ("default").
- Bound cost and contention: a per-step timeout on the matcher (reuse the matcher's
  `timeoutMs`), an overall verify timeout, and single-flight per test (a new verify cancels
  an in-flight one for the same test).

### Editor UX (Test Details)
- Each targetable step gets a collapsible **Locator** section: the four structured fields,
  an **Advanced** disclosure with the raw override, and a **Verify against [environment ▾]**
  control that shows the verdict inline (resolved/ambiguous/not-found + matched signal +
  healed badge, or the failed drive step).
- Locator edits feed the **existing** dirty-state / `buildPatch` / save-bar flow — one "Save
  changes" persists locator edits alongside any wait/threshold edits as a single new
  version. A successful save remounts the editor on the new version (clearing dirty state),
  as today.

## Testing Decisions

Good tests assert **external behavior** through the highest existing seam, never matcher
internals or DOM-scan details.

- **Locator editing — at the `PUT /tests/:id/config` API seam.** Prior art:
  `apps/api/test/schedules-config.e2e.spec.ts` and `apps/api/test/audit.e2e.spec.ts` already
  drive `/config`. New cases: editing a step's `target` produces a new version whose
  definition carries the merged fingerprint; non-edited structural signals are preserved; a
  `selectorOverride` round-trips; a stale `baseVersion` returns 409; a locator left with
  nothing to match on is rejected (400). Also assert the read-model: `GET /config` surfaces
  `target` for click/type/element-screenshot and `null` otherwise.
- **Override matching — unit, in `@varys/locator-engine`.** Prior art: the locator-engine's
  existing resolve tests against the `@varys/fixture-app` real page. New cases: a valid
  `selectorOverride` wins with `matchedSignal: "override"`; a stale override falls through to
  the scored bundle (and reports `healed` appropriately); an override matching multiple
  elements does not win.
- **Live verify — at the `POST /tests/:id/config/verify` API seam, against the fixture-app.**
  Prior art: the replay/baseline e2e (`apps/api/test/baseline.e2e.spec.ts`) and the
  live-browser authoring e2e (`apps/api/test/authoring-live.e2e.spec.ts`). New cases: a
  candidate that matches a fixture element returns `resolved` + `matchedSignal`; a deliberately
  broken candidate returns `not-found`; a candidate that ties returns `ambiguous`; a test
  whose earlier step can't be driven returns `failedStepIndex`/label; verify writes no run,
  run_results, or artifacts.
- **The extracted "drive to step N" core** is exercised transitively by both the existing
  replay e2e (unchanged behavior — the refactor must keep Runs green) and the new verify
  e2e. The refactor is validated by the existing run/baseline suite continuing to pass.
- UI is not unit-tested (per repo convention); the editor is covered manually and by the API
  contract tests above.

## Out of Scope

- Editing typed **values**, **navigate URLs**, **capture mode**, **masks**, **region rect**,
  or **checkpoint names** (later slices — checkpoint rename especially, because it touches
  the baseline key).
- **Reordering, inserting, duplicating, or enabling/disabling** steps (the patch stays
  index-keyed and append/remove-only this slice).
- Test-level metadata in the detail screen (name/folder/tags/description), **viewport**, and
  a **declared-variables** editor.
- **Version history / diff / revert** and a **raw-JSON advanced** definition editor.
- Field-by-field editing of the *full* fingerprint (ancestors, scope, neighbor text, stable
  classes) — only the four high-value signals + raw override are authorable; the rest are
  preserved.
- A truly **side-effect-free** verify: Verify is a real partial replay, so the preceding
  steps (including any mutations) execute, exactly as a Run would. No mutation gating
  (consistent with DESIGN accepted risk #2).
- Verifying against **multiple environments at once**, scheduled verify, or CI-triggered
  verify.

## Further Notes

- **Baseline safety.** Because a locator edit never changes `screenshot.name`, the
  `(test, checkpoint, environment, viewport)` baseline key is stable — existing baselines
  keep applying, no re-approval. This is the key reason locator editing is a clean first
  slice ahead of checkpoint rename.
- **Resilience invariant.** The multi-signal fingerprint is never reduced to one selector;
  the raw override is *additive* and self-heals back to the bundle when stale. Verify makes
  the fragility visible via the `healed` flag and the matched-signal readout.
- **Why partial replay, not navigate-only.** A locator generally lives deep in a flow; only
  driving the preceding steps reaches the page where it must resolve, so a navigate-to-baseUrl
  check would give false confidence. Sharing the runner's drive core is what makes the
  verdict trustworthy.
- **Provenance.** The new version's `created_by` is set by the existing attribution wiring
  (Slice A), so locator fixes are auditable.
