import { describe, expect, it } from "vitest";
import {
  deriveRunOutcome,
  deriveUnreachedRootCause,
  isRepairInReview,
  rollupRunStatus,
  type ReviewState,
  type Resolution,
  type RunOutcome,
  type RunOutcomeCheckpoint,
  type UnreachedCheckpoint,
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

/**
 * `missing` — a Checkpoint Manifest slot that was expected and never filled (Agent-Driven Tests).
 *
 * Every case here is the same claim from a different angle: a run that did not check something
 * cannot report anything but red. The rows are pre-seeded before an agent starts, so these
 * outcomes hold whether the agent skipped deliberately, crashed, or never reported at all —
 * which is the whole reason the state exists rather than being inferred from a missing row.
 */
describe("deriveRunOutcome — a missing checkpoint", () => {
  it("makes an otherwise-clean run failed", () => {
    expect(deriveRunOutcome([cp("passed"), cp("missing")], { status: "passed" })).toBe("failed");
  });

  it("is failed even when every other slot matched and the run status says passed", () => {
    expect(deriveRunOutcome([cp("passed"), cp("passed"), cp("missing")], { status: "passed" })).toBe("failed");
  });

  it("outranks a regression — the journey breaking is more urgent than a pixel that moved", () => {
    expect(deriveRunOutcome([cp("diff"), cp("missing")], { status: "needs_review" })).toBe("failed");
  });

  it("outranks a rejected diff", () => {
    expect(deriveRunOutcome([cp("diff", "rejected"), cp("missing")], { status: "needs_review" })).toBe("failed");
  });

  it("outranks pending-baseline — a first run that reached nothing is not awaiting approval", () => {
    expect(deriveRunOutcome([cp("pending-baseline"), cp("missing")], { status: "needs_review" })).toBe("failed");
  });

  it("outranks a baseline write", () => {
    expect(deriveRunOutcome([cp("pending-baseline", "approved"), cp("missing")], { status: "passed" })).toBe("failed");
  });

  it("outranks healed — a repair can never dress an unreached checkpoint up as amber", () => {
    expect(
      deriveRunOutcome([cp("passed"), cp("missing")], { status: "passed", repairApplied: true }),
    ).toBe("failed");
  });

  it("is failed when every slot is missing", () => {
    expect(deriveRunOutcome([cp("missing"), cp("missing")], { status: "needs_review" })).toBe("failed");
  });

  it("does not disturb queued / running / cancelled", () => {
    expect(deriveRunOutcome([cp("missing")], { status: "queued" })).toBe("queued");
    expect(deriveRunOutcome([cp("missing")], { status: "running" })).toBe("running");
    expect(deriveRunOutcome([cp("missing")], { status: "cancelled" })).toBe("cancelled");
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

/**
 * The coarse `runs.status` rollup — deliberately separate from `deriveRunOutcome`, which refines
 * how a run READS. This one decides what is stored, and two writers depend on it agreeing with
 * itself: a human resolving a checkpoint, and an agent filling a Manifest slot.
 */
describe("rollupRunStatus", () => {
  it("is passed only when every checkpoint matched or was promoted", () => {
    expect(rollupRunStatus([cp("passed"), cp("passed")])).toBe("passed");
    expect(rollupRunStatus([cp("pending-baseline", "approved"), cp("diff", "approved")])).toBe("passed");
    expect(rollupRunStatus([])).toBe("passed");
  });

  it("is needs_review while anything is still undecided", () => {
    expect(rollupRunStatus([cp("passed"), cp("pending-baseline")])).toBe("needs_review");
    expect(rollupRunStatus([cp("diff")])).toBe("needs_review");
  });

  it("is failed when a checkpoint was rejected", () => {
    expect(rollupRunStatus([cp("passed"), cp("diff", "rejected")])).toBe("failed");
  });

  // The rule the whole Agent-Driven story rests on: an unfilled Manifest slot is neither work
  // awaiting a human nor something a decision on a SIBLING checkpoint can resolve.
  it("is failed whenever a slot is missing, whatever else happened", () => {
    expect(rollupRunStatus([cp("missing")])).toBe("failed");
    expect(rollupRunStatus([cp("passed"), cp("missing")])).toBe("failed");
    expect(rollupRunStatus([cp("pending-baseline", "approved"), cp("missing")])).toBe("failed");
    // Every reviewable sibling resolved — the one thing that would otherwise roll up to passed.
    expect(rollupRunStatus([cp("diff", "approved"), cp("missing")])).toBe("failed");
  });

  it("outranks a pending checkpoint, so a half-walked run never reads as amber", () => {
    expect(rollupRunStatus([cp("pending-baseline"), cp("missing")])).toBe("failed");
  });
});

/**
 * The "one root cause, not five failures" derivation.
 *
 * A Checkpoint Manifest is CUMULATIVE — slot 3's instructions assume slots 1–2 already happened —
 * so when a journey breaks, everything after it is unreachable by construction. Presenting those
 * as independent findings is what makes a reader stop reading: four mysteries where there is one
 * fact. This picks the fact.
 */
describe("deriveUnreachedRootCause", () => {
  /** A named slot in Manifest order — the shape the run view holds. */
  const slot = (name: string, reviewState: ReviewState): UnreachedCheckpoint => ({ name, reviewState });

  it("is null when every slot was reached", () => {
    expect(deriveUnreachedRootCause([])).toBeNull();
    expect(
      deriveUnreachedRootCause([slot("home", "passed"), slot("detail", "diff")]),
    ).toBeNull();
  });

  it("names the first unfilled slot as the root cause and the rest as its consequences", () => {
    const cause = deriveUnreachedRootCause([
      slot("login", "passed"),
      slot("dashboard", "passed"),
      slot("filters", "missing"),
      slot("export", "missing"),
      slot("confirmation", "missing"),
    ]);
    expect(cause).toEqual({
      checkpointName: "filters",
      step: 3,
      lastReached: "dashboard",
      alsoUnreached: ["export", "confirmation"],
      resumed: false,
    });
  });

  // The login-broke case the PRD names: nothing was reached, so there is no "it got this far".
  it("reports no last-reached slot when the journey never started", () => {
    const cause = deriveUnreachedRootCause([
      slot("login", "missing"),
      slot("dashboard", "missing"),
    ]);
    expect(cause).toMatchObject({
      checkpointName: "login",
      step: 1,
      lastReached: null,
      alsoUnreached: ["dashboard"],
    });
  });

  it("carries no consequences when only the last slot went unfilled", () => {
    const cause = deriveUnreachedRootCause([slot("home", "passed"), slot("detail", "missing")]);
    expect(cause).toMatchObject({ checkpointName: "detail", step: 2, alsoUnreached: [], resumed: false });
  });

  /**
   * The honesty flag. If a later slot WAS filled, the break did not stop the session — so "the
   * journey stopped at X" is not the whole story, and the view must not claim it is. One root
   * cause is a summary, not a licence to hide the second thing that went wrong.
   */
  it("flags a run that carried on past the break, so one cause is not claimed to explain all of it", () => {
    const cause = deriveUnreachedRootCause([
      slot("login", "passed"),
      slot("filters", "missing"),
      slot("export", "passed"),
      slot("confirmation", "missing"),
    ]);
    expect(cause).toMatchObject({
      checkpointName: "filters",
      step: 2,
      lastReached: "login",
      // "confirmation" is NOT fallout from the break at "filters": the session filled "export"
      // in between, so it demonstrably got past it. Claiming it as a consequence would collapse
      // two independent failures into one — the same dishonesty as the five-failure view, with
      // the sign flipped.
      alsoUnreached: [],
      resumed: true,
    });
  });

  // The contiguous block is what the break actually explains, and it stops where the session
  // recovers — not at the end of the Manifest.
  it("claims only the unbroken run of slots behind the break, not everything after it", () => {
    const cause = deriveUnreachedRootCause([
      slot("login", "passed"),
      slot("filters", "missing"),
      slot("chart", "missing"),
      slot("export", "passed"),
      slot("confirmation", "missing"),
    ]);
    expect(cause).toMatchObject({
      checkpointName: "filters",
      alsoUnreached: ["chart"],
      resumed: true,
    });
  });

  // Manifest order is the caller's, taken as given: `run_results` is stamped in journey order at
  // seed time precisely so this reads the sequence the agent was asked to walk.
  it("reads order from the array, not from the names", () => {
    const cause = deriveUnreachedRootCause([
      slot("zulu", "passed"),
      slot("alpha", "missing"),
    ]);
    expect(cause).toMatchObject({ checkpointName: "alpha", step: 2, lastReached: "zulu" });
  });

  // A slot resolved by a human is a slot that WAS reached; only `missing` means unreached.
  it("counts only missing slots — a rejected capture is a different fact with a different owner", () => {
    expect(
      deriveUnreachedRootCause([slot("home", "diff"), slot("detail", "pending-baseline")]),
    ).toBeNull();
  });
});
