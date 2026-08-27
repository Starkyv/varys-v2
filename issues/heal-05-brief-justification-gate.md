# Slice 05 — Brief-justification gate on every repair

**Type:** HITL · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** 04

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

The guard that stops a plausible-but-wrong repair from landing. Before a repair is applied, the
agent must state **which clause of the `Brief`** the re-pinned element satisfies, and a one-shot
judge validates that claim. A rejected justification abandons the repair; the run stays `failed`.

This is HITL because the judge's rubric is a **safety property expressed as prose**. Its wording
decides whether the guard actually catches the scenario it exists for: a deploy deletes "Apply
filter", the agent finds a plausible "Refresh" button, and re-pins to it. The rubric must reject
that. Getting the wording wrong produces a guard that always says yes, which is worse than no
guard because it looks like one.

Ride the existing `JudgeProvider` seam rather than inventing a new one — the fake provider then
covers this for free, and a thrown transport error already maps to "not a pass". Here that must
mean **repair abandoned**, never **repair accepted**.

Also in scope: the `Brief` becomes editable and is displayed beside the justification, since the
judge's verdict is meaningless to a reviewer who cannot see what it was checked against.

**Slice 00 gates GA, not development.** Build it, but let the spike's wrong-fix rate decide
whether this guard is sufficient alone or whether the strong-signal rule (rejected in Q11 of the
design interview) needs to sit alongside it.

## Acceptance criteria

- [x] A reported repair without a brief-clause justification is refused
- [x] The justification is validated by a judge before the repair is applied
- [x] A rejected justification abandons the repair, leaves the test unchanged, and leaves the run `failed`
- [x] A judge transport error abandons the repair — never applies it
- [x] An accepted justification is stored on the version and shown beside the brief in review
- [x] The brief is editable, and editing it does not disturb the test's history
- [ ] E2E, both directions: the rubric **accepts** a genuine rename of the same control, and **rejects** re-pinning to a different control when the original was removed
- [ ] Rubric wording reviewed by a human against the "deleted Apply filter → plausible Refresh button" scenario before this ships

## Blocked by

- Slice 04 (there must be a repair to gate)
- Slice 00 gates GA (not development)

## Flags raised

- **The rubric's wording is the one thing here that is NOT verified by a green test, and the two
  unticked criteria are both that.** `REPAIR_JUSTIFICATION_SYSTEM` in `packages/judge-engine/src/index.ts`
  is the safety property; every automated test in this slice scripts the verdict, because a fake
  judge can tell you nothing about the wording of a prompt. `apps/api/test/repair-rubric.live.spec.ts`
  puts the exact "deleted Apply filter → plausible Refresh" scenario (and its opposite, a genuine
  rename) through a REAL model, and is skipped unless `VARYS_JUDGE_API_KEY` + `VARYS_JUDGE_MODEL`
  are set. **It has not been run** — no key was available in this session. Run it before this
  ships, and read the rubric alongside it.

- **A test with no Brief can no longer be repaired automatically at all.** There is no clause to
  check a justification against, so the gate refuses rather than waving it through — the repair is
  abandoned and the message says to give the test a Brief. That is the fail-closed reading of the
  slice, but it is a real product constraint: every `auto`-policy test now needs a Brief, and
  nothing prompts an author to write one at recording time. Worth deciding whether the Tests list
  should surface "auto-repair, but no Brief" as a warning.

- **Same for a deployment with no judge configured**: no judge ⇒ no repair is ever applied. The
  refusal says so plainly, but a project that turns on `auto` without configuring a judge gets a
  queue that drains into refusals. Same question as above — this probably wants surfacing in the
  Repair Policy control rather than only at report time.

- **The two abandonment paths deliberately differ in what becomes of the JOB**, and this is the
  judgement call most worth a second opinion. A *refused* justification ends the job terminally
  (`failed`) — returning it to the queue invites the next drainer to re-pin to the same plausible
  substitute and be refused again. A *broken or absent judge* returns the job to the queue with
  one attempt spent, because an outage says nothing about the repair. Both are pinned by the E2E.

- **Abandoning reverts through the SAME path a human Reject uses** (`RepairReviewsService.revertRepair`,
  extracted from `reject` in this slice) — append the previous definition, mark the repaired
  version(s) `rejected`, migrate any renamed checkpoint's baseline back. Deliberately not a second
  implementation: the more dangerous path should not be the untested one. It also means an
  abandoned repair costs the test two version numbers, exactly as a reject does.

- **The gate undoes EVERY version the claim wrote**, not just the last one. `apply_fix` and
  `edit_test` each append one, so a drainer that did both leaves two — and "the test is unchanged"
  would be a lie if only one were reverted. A human Reject still handles one version at a time
  (slice 04's shape, untouched here).

- **`JudgeInput.baseline`/`current` are now optional, and the input carries an optional `system`
  and `toolSchema`.** That is how the gate rides the existing `JudgeProvider` seam instead of
  inventing a second one — the fake provider covers it for free and a throw is already "not a
  pass". The vision path is unchanged and `context-compare.e2e.spec.ts` still passes, but the
  interface is now looser than it was: a caller that forgets both images gets a text-only call
  rather than a type error.

- **The judge is resolved from the same `app_settings`/`VARYS_JUDGE_*` configuration the worker
  reads** (`apps/api/src/repair-jobs/judge.ts`), so the checkpoint judge and the gate share one
  model. If those should ever diverge — a cheaper model for checkpoints, a stronger one for the
  gate — that is a new setting, not a code change here.

- **`/code-review` was not run**: this session is configured not to spawn subagents. The diff wants
  a human pass over `repair-jobs.service.ts` (`judgeJustification`) and the extracted
  `revertRepair`.

## Promotion candidates

- **`apps/web/src/components/NotesCard`** — already app-shared (run detail + test detail), and this
  slice gave it a `label` prop so the same inline editor carries the Brief. That makes it a
  three-caller, purely presentational, feature-vocabulary-free inline text editor, which is the
  strongest `@dg/ui` signal in this diff. It is not a design invention — it is the existing card,
  generalised. Left where it is; promoting it needs the Storybook/axe/JSDoc/testId work that is its
  own piece.
