import { describe, expect, it } from "vitest";
import {
  deriveRunOutcome,
  isRepairInReview,
  type ReviewState,
  type Resolution,
  type RunOutcome,
  type RunOutcomeCheckpoint,
} from "./index";

/** Terse checkpoint builder: `cp("passed")`, `cp("diff", "approved")`. */
const cp = (reviewState: ReviewState, resolution: Resolution | null = null): RunOutcomeCheckpoint => ({
  reviewState,
  resolution,
});

/**
 * One case per row of the PRD rollup matrix (`prd/run-outcome-baseline-vs-verified.md`,
 * "Test-case matrix"), plus the empty-run fallbacks.
 */
describe("deriveRunOutcome", () => {
  const cases: Array<{
    row: string;
    checkpoints: RunOutcomeCheckpoint[];
    run: { status: string; error?: string | null };
    expected: RunOutcome;
  }> = [
    { row: "1 — all passed, none resolved", checkpoints: [cp("passed"), cp("passed")], run: { status: "passed" }, expected: "passed" },
    { row: "2 — all pending-baseline, unresolved (first run, no baseline yet)", checkpoints: [cp("pending-baseline"), cp("pending-baseline")], run: { status: "needs_review" }, expected: "pending-baseline" },
    { row: "3 — all pending-baseline, set as baseline", checkpoints: [cp("pending-baseline", "approved"), cp("pending-baseline", "approved")], run: { status: "passed" }, expected: "baseline" },
    { row: "4 — diff, not accepted (regression)", checkpoints: [cp("diff")], run: { status: "needs_review" }, expected: "regression" },
    { row: "5 — diff set as baseline", checkpoints: [cp("diff", "approved")], run: { status: "passed" }, expected: "baseline" },
    { row: "6 — diff rejected (confirmed regression)", checkpoints: [cp("diff", "rejected")], run: { status: "failed", error: null }, expected: "regression" },
    { row: "7 — passed re-baselined, rest matched", checkpoints: [cp("passed", "approved"), cp("passed")], run: { status: "passed" }, expected: "baseline" },
    { row: "8 — mix: passed (matched) + seed set as baseline", checkpoints: [cp("passed"), cp("pending-baseline", "approved")], run: { status: "passed" }, expected: "baseline" },
    { row: "9 — pending seed + unaccepted diff (diff outranks)", checkpoints: [cp("pending-baseline"), cp("diff")], run: { status: "needs_review" }, expected: "regression" },
    { row: "10 — one seed approved, another still unapproved", checkpoints: [cp("pending-baseline", "approved"), cp("pending-baseline")], run: { status: "needs_review" }, expected: "pending-baseline" },
    { row: "11 — diff rejected + a diff still unaccepted", checkpoints: [cp("diff", "rejected"), cp("diff")], run: { status: "needs_review" }, expected: "regression" },
    { row: "12 — execution error, no checkpoints", checkpoints: [], run: { status: "failed", error: "navigation timeout" }, expected: "failed" },
    { row: "13 — crash after partial checkpoints", checkpoints: [cp("passed"), cp("pending-baseline", "approved")], run: { status: "failed", error: "boom" }, expected: "failed" },
    { row: "14 — re-run after baselining → all match", checkpoints: [cp("passed"), cp("passed")], run: { status: "passed" }, expected: "passed" },
  ];

  for (const c of cases) {
    it(`row ${c.row} → ${c.expected}`, () => {
      expect(deriveRunOutcome(c.checkpoints, c.run)).toBe(c.expected);
    });
  }

  it("passes through queued / running regardless of checkpoints", () => {
    expect(deriveRunOutcome([], { status: "queued" })).toBe("queued");
    expect(deriveRunOutcome([cp("passed")], { status: "running" })).toBe("running");
  });

  it("any red checkpoint marks the run a regression even when another was set as baseline", () => {
    // a visual difference outranks a baseline write
    expect(deriveRunOutcome([cp("diff", "approved"), cp("diff")], { status: "needs_review" })).toBe("regression");
  });

  it("baseline wins over a clean pass when nothing is red", () => {
    expect(deriveRunOutcome([cp("passed"), cp("passed"), cp("diff", "approved")], { status: "passed" })).toBe("baseline");
  });

  it("empty passed run falls back to passed", () => {
    expect(deriveRunOutcome([], { status: "passed" })).toBe("passed");
  });

  it("treats an empty-string error as no error", () => {
    expect(deriveRunOutcome([cp("passed")], { status: "passed", error: "" })).toBe("passed");
  });
});

/**
 * `healed` (Slice 19, slice 06) — the rung a repair adds. It is not derivable from the
 * checkpoints: a clean re-run after a repair is pixel-for-pixel an ordinary pass, and the
 * difference — that its greenness rests on an edit no human has accepted — is a property of the
 * VERSION the run replayed. So it enters as its own input, and the only question worth pinning is
 * where it sits relative to everything else.
 *
 * Precedence, restated as the slice states it:
 *
 *     failed → regression → pending-baseline → healed → baseline → passed
 *
 * Every pairing below is one row of that order, asserted both ways round: with the repair in
 * play and without, so each case shows what the repair flag DID and did not change.
 */
describe("deriveRunOutcome — the healed rung", () => {
  /** Same checkpoints, once with an unaccepted repair in the definition and once without. */
  const pair = (
    checkpoints: RunOutcomeCheckpoint[],
    run: { status: string; error?: string | null },
  ) => ({
    withRepair: deriveRunOutcome(checkpoints, { ...run, repairApplied: true }),
    without: deriveRunOutcome(checkpoints, { ...run, repairApplied: false }),
  });

  it("a re-run where everything verified reads healed, not passed", () => {
    const r = pair([cp("passed"), cp("passed")], { status: "passed" });
    expect(r.withRepair).toBe("healed");
    expect(r.without).toBe("passed");
  });

  it("healed outranks baseline — a repaired run that also re-baselined is still a queue item", () => {
    const r = pair([cp("passed"), cp("diff", "approved")], { status: "passed" });
    expect(r.withRepair).toBe("healed");
    expect(r.without).toBe("baseline");
  });

  it("a pixel diff reads regression, NOT healed, even though a locator was re-pinned", () => {
    // The rung that matters most: a re-pinned locator must never soften a real visual break.
    const r = pair([cp("passed"), cp("diff")], { status: "needs_review" });
    expect(r.withRepair).toBe("regression");
    expect(r.without).toBe("regression");
  });

  it("a rejected diff reads regression, not healed", () => {
    const r = pair([cp("diff", "rejected")], { status: "failed", error: null });
    expect(r.withRepair).toBe("regression");
  });

  it("a re-run that crashes reads failed, not healed", () => {
    const r = pair([], { status: "failed", error: "navigation timeout" });
    expect(r.withRepair).toBe("failed");
    expect(r.without).toBe("failed");
  });

  it("a crash AFTER some checkpoints passed is still failed, not healed", () => {
    const r = pair([cp("passed")], { status: "failed", error: "boom" });
    expect(r.withRepair).toBe("failed");
  });

  it("a repaired run that captured nothing to compare is failed, not healed", () => {
    // No error text, but nothing verified either — a repair must not dress that up as amber.
    const r = pair([], { status: "needs_review" });
    expect(r.withRepair).toBe("failed");
    expect(r.without).toBe("failed");
  });

  it("pending-baseline outranks healed — an unapproved first capture is the headline", () => {
    const r = pair([cp("pending-baseline")], { status: "needs_review" });
    expect(r.withRepair).toBe("pending-baseline");
    expect(r.without).toBe("pending-baseline");
  });

  it("a repaired run whose seeds were all approved reads healed, not baseline", () => {
    const r = pair([cp("pending-baseline", "approved")], { status: "passed" });
    expect(r.withRepair).toBe("healed");
    expect(r.without).toBe("baseline");
  });

  it("queued / running / cancelled are unchanged by a repair", () => {
    expect(deriveRunOutcome([], { status: "queued", repairApplied: true })).toBe("queued");
    expect(deriveRunOutcome([], { status: "running", repairApplied: true })).toBe("running");
    expect(deriveRunOutcome([], { status: "cancelled", repairApplied: true })).toBe("cancelled");
  });

  it("an absent repairApplied behaves exactly as false (every pre-slice-06 caller)", () => {
    expect(deriveRunOutcome([cp("passed")], { status: "passed" })).toBe("passed");
  });
});

describe("isRepairInReview", () => {
  it("is true only for a repair version still awaiting a human", () => {
    expect(isRepairInReview("job-1", "unreviewed")).toBe(true);
    // Accepted: signed off, so runs against it are ordinary passes again — healed is a review
    // marker, not a permanent scar on the test's history.
    expect(isRepairInReview("job-1", "reviewed")).toBe(false);
    expect(isRepairInReview("job-1", "rejected")).toBe(false);
    // A human's own unreviewed-by-accident version is not a repair: no job behind it.
    expect(isRepairInReview(null, "unreviewed")).toBe(false);
    expect(isRepairInReview(null, null)).toBe(false);
  });
});
