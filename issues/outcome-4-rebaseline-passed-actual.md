# Re-baseline a passed actual (Slice 17.4)

**Type:** AFK

## Parent

PRD: `prd/run-outcome-baseline-vs-verified.md` (DESIGN §4 / §8 — Slice 17). Covers Goal **G2**
(promote a passed actual to a new golden baseline).

## What to build

Let a reviewer promote a **passed** checkpoint's actual to the new golden baseline — impossible
today (approve refuses anything that isn't `pending-baseline` or `diff`).

**Backend:** the approve action accepts a checkpoint whose current `reviewState` is `passed` and
treats it exactly like an approved `diff` — replaces the existing golden with this run's actual,
records who/when, and deletes the previous golden blob (destructive, no rollback — consistent with
DESIGN §4 / accepted-risk #1). It reads the *current* review state, so a live re-judge
(mask/threshold tuning) that flipped the verdict is respected. **"Approve all in run" is
unchanged** — it selects only unresolved pending-baseline/diff checkpoints, so a passed checkpoint
is never re-baselined implicitly. Rejecting a passed checkpoint is refused.

**UI:** Run Detail shows a secondary **"Set as new baseline"** action on each passed checkpoint,
behind the same irreversible-replace confirm used for a diff approve. When the diff score is ~0
(pixel-identical to the current golden), show an "already matches the baseline" hint before the
confirm. After it runs, the run's `outcome` derives to **Baseline**.

## Acceptance criteria

- [ ] Approving a checkpoint whose current review state is `passed` writes this run's actual as the new golden for that (test, checkpoint, environment, viewport), updates the approver + approved-at audit, and deletes the previous golden blob.
- [ ] The approve path reads the live review state (a re-judge that changed the verdict is honored).
- [ ] "Approve all in run" still resolves only unresolved pending-baseline/diff checkpoints — passed checkpoints are never re-baselined implicitly.
- [ ] Rejecting a passed checkpoint is refused (400) — you cannot reject a pass.
- [ ] Run Detail offers a "Set as new baseline" action on passed checkpoints, gated by the existing irreversible-replace confirm, with an "already matches" hint when the diff score is ~0.
- [ ] After re-baselining, the run's outcome reads **Baseline** and the checkpoint shows it was re-baselined by the signed-in user.
- [ ] API e2e: approve a passed checkpoint → golden artifact key equals the actual, audit set, old blob deleted, run outcome derives to `baseline`; the existing approve/reject e2e stays green.

## Blocked by

- Slice 17.1 — Derived RunOutcome + Run Detail badge (`issues/outcome-1-derived-runoutcome-run-detail.md`).
