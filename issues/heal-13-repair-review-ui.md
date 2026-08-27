# Slice 13 — Repair review: what changed, and why Claude thought it was right

**Type:** AFK · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** 04

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

The surface that decides whether self-healing is trusted or ignored. Slice 04 gave a minimal
accept/reject; this makes the decision fast enough that the queue does not rot.

Side by side: the old locator and the new one, with the signals that changed highlighted — role,
accessible name, text, ancestors, neighbours. Beside it, the `Brief` and Claude's justification
against it, so a reviewer can judge whether the re-pinned element is genuinely the same thing
without navigating away.

The design's whole review gate rests on this being a seconds-long decision. If it takes minutes,
authors will bulk-accept, and bulk-accepting is functionally identical to having no gate at all.

Clustered repairs (slice 07) must show their **blast radius**: a reviewer accepting a fix across
thirty-eight tests needs to see that number before clicking, not after.

## Acceptance criteria

- [x] The review surface shows the previous and repaired locator side by side
- [x] Signals that changed are visually distinguished from signals that did not
- [x] The brief and Claude's justification are shown together with the diff
- [x] Accept and reject are one click each, from the same view
- [x] Rejecting reverts the test to its previous version
- [x] A clustered repair shows how many tests it will affect before it is accepted
- [x] The count of versions awaiting review is visible from the review queue and links here
- [x] A screenshot of the page the repair was made against is available for context
- [ ] Verified by hand — UI tests are out of scope per house practice

## Blocked by

- Slice 04 (there must be unreviewed versions to review)

## Flags raised

- **The diff is computed from the two stored definitions, not from the agent's report.** That is
  the load-bearing choice of the slice: `diffRepairSignals` reads the repaired version and the one
  it was written on top of, so a drainer that described a re-pin generously cannot make the table
  agree with it. The prose form of the same comparison (`repair-diff.ts`) still feeds the
  justification judge — deliberately two renderings, because the judge reads text and the reviewer
  reads a table, and collapsing them would make one of the two worse.
- **Unchanged signals are shown, marked unchanged, and that is not padding.** "Role is still
  button, still inside `#form-panel`, only the name moved" is the entire evidence that a re-pinned
  element is the same control. A changes-only diff would make a re-pin to a *different* control
  read identically to a rename. Changed rows sort first so the scan is still seconds long.
- **`nonSignalChange` is surfaced in danger tone.** A locator repair that also edited a url, a
  typed value or a checkpoint name is doing more than re-finding an element; a reviewer shown only
  signals would never learn that it did. Worth a second opinion on the wording.
- **The screenshot is captured at write time, in the repair session, and its failure is
  swallowed.** `apply_fix` captures the live page it just verified against; a repair-session
  `edit_test` captures the page the session is PARKED on (a general edit is not verified against
  it — said so in the code, because the difference matters to a reviewer). A capture that throws is
  logged and ignored: a screenshot is context for a human, not part of the repair, and turning a
  verified fix into an error over a lost PNG would be the wrong trade.
- **A CLUSTERED repair's siblings have no screenshot.** The fan-out writes its versions through
  `TestsService.saveConfig` with no live page behind them, so only the anchor — the version the
  queue actually shows and decides — carries a capture. Correct for the surface as built; it would
  need revisiting if the queue ever expanded a cluster into per-test rows.
- **Repair captures are never purged.** One PNG per repaired version accumulates under
  `repairs/<versionId>.png` with no retention rule, unlike run artifacts. Small, but it is a new
  unbounded store and a reviewer should decide whether it wants a purge path.
- **The awaiting-review count landed in two places, and only one of them is what the criterion
  literally asked for.** The Drafts page (labelled "Review queue" in the nav) now carries a
  clickable banner naming the count and linking to the repair queue, shown above the empty state
  too — a project with no drafts is exactly the one whose repaired versions would sit unseen. The
  sidebar's Repair queue entry also badges the count, for the same reason the other two review
  surfaces do.
- **`/code-review` was not run**: this session is configured not to spawn subagents. The diff wants
  a human pass, particularly over the new `SignalDiff` component's density in both themes.
- **Two pre-existing E2E failures in `repair-edit.e2e.spec.ts`**, unchanged by this slice and
  already flagged on slice 04 (an inserted step's captured target has no `role`; a checkpoint
  rename aimed at a click step). Verified they fail on the same two assertions as before.
- **The last acceptance criterion is unticked on purpose.** "Verified by hand" is a human's, and
  the thing to check is the one the gates cannot: whether the decision is genuinely seconds long,
  and whether the changed/unchanged distinction survives dark theme.

## Promotion candidates

None. `SignalDiff` reads repair-queue vocabulary throughout (signals, repairs, versions), has one
caller, and its whole layout is shaped by this one decision — it is this feature's component. The
generic thing underneath it (a two-column labelled before/after table) is a design invention, not
an existing DS shape, so if it is wanted elsewhere that is a request for a design rather than a
promotion.
