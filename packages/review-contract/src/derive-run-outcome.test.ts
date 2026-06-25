import { describe, expect, it } from "vitest";
import {
  deriveRunOutcome,
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
