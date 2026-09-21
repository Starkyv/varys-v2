import { describe, expect, it } from "vitest";
import {
  deriveAgentSessionState,
  deriveRunOutcome,
  describeLease,
  deriveUnreachedRootCause,
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

  it("a run that captured nothing to compare is failed, not a queue item", () => {
    // No error text, but nothing verified either — there is no reading of this that is green.
    expect(deriveRunOutcome([], { status: "needs_review" })).toBe("failed");
  });

  it("empty passed run falls back to passed", () => {
    expect(deriveRunOutcome([], { status: "passed" })).toBe("passed");
  });

  it("treats an empty-string error as no error", () => {
    expect(deriveRunOutcome([cp("passed")], { status: "passed", error: "" })).toBe("passed");
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

  it("is failed when every slot is missing", () => {
    expect(deriveRunOutcome([cp("missing"), cp("missing")], { status: "needs_review" })).toBe("failed");
  });

  it("does not disturb queued / running / cancelled", () => {
    expect(deriveRunOutcome([cp("missing")], { status: "queued" })).toBe("queued");
    expect(deriveRunOutcome([cp("missing")], { status: "running" })).toBe("running");
    expect(deriveRunOutcome([cp("missing")], { status: "cancelled" })).toBe("cancelled");
  });
});

/**
 * An Agent Run Session is created ALREADY RED, every Manifest slot `missing`, and stays that way
 * until the agent reports one. That is the honest answer to "what has this run verified?" — but
 * while the session is inside its lease it is not yet an answer to "how did this run END", and a
 * runs list that says `failed` about a session currently walking the journey is asserting
 * something that is not true yet.
 *
 * The rule is narrow on purpose: an OPEN session softens an UNFILLED slot and nothing else. It
 * cannot rescue a diff, and it cannot outlive the lease.
 */
describe("deriveRunOutcome — an Agent Run Session still inside its lease", () => {
  it("reads running rather than failed while slots are merely unreported", () => {
    expect(
      deriveRunOutcome([cp("passed"), cp("missing")], { status: "failed", agentSession: "open" }),
    ).toBe("running");
  });

  it("reads running for a session that has reported nothing at all yet", () => {
    expect(
      deriveRunOutcome([cp("missing"), cp("missing")], { status: "failed", agentSession: "open" }),
    ).toBe("running");
  });

  it("goes red the instant the lease is over — expired is a verdict, open is not", () => {
    expect(
      deriveRunOutcome([cp("passed"), cp("missing")], { status: "failed", agentSession: "expired" }),
    ).toBe("failed");
  });

  it("goes red when the agent closed the session having left a slot unreported", () => {
    expect(
      deriveRunOutcome([cp("passed"), cp("missing")], { status: "failed", agentSession: "finished" }),
    ).toBe("failed");
  });

  it("softens an unfilled slot and NOTHING else — an open session cannot hide a real diff", () => {
    // Every slot reported, one of them differing: the session being open says nothing about that,
    // and a run that found a regression should say so while it is still running.
    expect(
      deriveRunOutcome([cp("passed"), cp("diff")], { status: "failed", agentSession: "open" }),
    ).toBe("regression");
  });

  it("still reports a real execution error over an open session", () => {
    expect(
      deriveRunOutcome([cp("missing")], { status: "failed", error: "boom", agentSession: "open" }),
    ).toBe("failed");
  });

  it("leaves every caller that does not pass a session exactly as it was", () => {
    // The compatibility guarantee: a pinned run, and every one of the callers that has no session
    // to offer, must derive the same answer as before the parameter existed.
    for (const session of [undefined, null] as const) {
      expect(
        deriveRunOutcome([cp("passed"), cp("missing")], { status: "passed", agentSession: session }),
      ).toBe("failed");
    }
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

/**
 * The wall-clock lease (Agent-Driven Tests, ticket #7).
 *
 * Three states, and the whole reason the function exists is that two of them look identical from
 * the outside. An agent that closed its laptop and an agent still patiently retrying both leave a
 * run with unfilled slots and no summary — before the lease there was nothing that could tell them
 * apart, so the run view had to word itself around the ambiguity. The deadline resolves it: past
 * it, "still walking" is no longer one of the possibilities.
 *
 * Shared rather than decided twice because both callers act on it — the API REFUSES a submission
 * on an expired session, and the run view SAYS the session hit its bound. Those two disagreeing
 * would mean a run that reads as still running while the tools tell its agent it is over.
 */
const HOUR = 3_600_000;
const startedAt = Date.parse("2026-09-16T10:00:00.000Z");
const deadline = new Date(startedAt + HOUR).toISOString();

describe("deriveAgentSessionState", () => {
  it("is open while the clock is still inside the lease", () => {
    expect(
      deriveAgentSessionState({ summaryWritten: false, leaseExpiresAt: deadline }, startedAt + 60_000),
    ).toBe("open");
  });

  it("is expired once the deadline has passed", () => {
    expect(
      deriveAgentSessionState({ summaryWritten: false, leaseExpiresAt: deadline }, startedAt + HOUR + 1),
    ).toBe("expired");
  });

  // The boundary belongs to the bound, not to the session: a lease "until 10:00" is over at 10:00.
  it("treats the instant of the deadline as expired, not as the last moment of the lease", () => {
    expect(
      deriveAgentSessionState({ summaryWritten: false, leaseExpiresAt: deadline }, startedAt + HOUR),
    ).toBe("expired");
  });

  /**
   * A finished session stays finished however long the clock runs afterwards. The alternative —
   * letting a deadline overtake a summary — would turn every completed agent run into an expired
   * one an hour later, which is the single most misleading thing this could do.
   */
  it("keeps a finished session finished long after its deadline", () => {
    expect(
      deriveAgentSessionState({ summaryWritten: true, leaseExpiresAt: deadline }, startedAt + 500 * HOUR),
    ).toBe("finished");
  });

  it("is finished the moment a summary exists, even well inside the lease", () => {
    expect(
      deriveAgentSessionState({ summaryWritten: true, leaseExpiresAt: deadline }, startedAt + 60_000),
    ).toBe("finished");
  });

  /**
   * A run started before leases existed carries no deadline, and nothing may invent one for it.
   * It reads `open` forever — the honestly ambiguous state the lease was introduced to retire,
   * kept for the runs that genuinely have it rather than backdated onto them.
   */
  it("leaves a run with no lease open rather than guessing a deadline for it", () => {
    expect(
      deriveAgentSessionState({ summaryWritten: false, leaseExpiresAt: null }, startedAt + 500 * HOUR),
    ).toBe("open");
  });

  it("still reports a finished pre-lease session as finished", () => {
    expect(deriveAgentSessionState({ summaryWritten: true, leaseExpiresAt: null }, startedAt)).toBe(
      "finished",
    );
  });

  // The API passes a `Date` straight off the row; the web passes the ISO string the read-model
  // serialised. One rule, so the two cannot drift over a parsing detail.
  it("reads a Date and its ISO string identically", () => {
    const at = startedAt + HOUR + 1;
    expect(
      deriveAgentSessionState({ summaryWritten: false, leaseExpiresAt: new Date(deadline) }, at),
    ).toBe(deriveAgentSessionState({ summaryWritten: false, leaseExpiresAt: deadline }, at));
  });
});

/**
 * The lease is said twice — once to the agent that is bounded by it, once to the person reading
 * the run afterwards — so the wording is shared rather than written at each end. What the tests
 * below protect is exactness: a bound is the one number here that has to be literally true, and a
 * formatter that rounds "90 seconds" up to "2 minutes" overstates it by a third.
 */
describe("describeLease", () => {
  it("says a whole number of minutes or hours in those units", () => {
    expect(describeLease(900)).toBe("15 minutes");
    expect(describeLease(60)).toBe("1 minute");
    expect(describeLease(3600)).toBe("1 hour");
    expect(describeLease(7200)).toBe("2 hours");
  });

  it("steps down to the finer unit rather than rounding a bound it cannot say exactly", () => {
    expect(describeLease(90)).toBe("90 seconds");
    expect(describeLease(5400)).toBe("90 minutes");
    expect(describeLease(1)).toBe("1 second");
  });
});
