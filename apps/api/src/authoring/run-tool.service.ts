import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import type { RunOutcome, RunView } from "@varys/review-contract";
import { RunsService } from "../runs/runs.service";

/** How long a `run_test` call waits by default, and the hard cap. A replay is minutes, not
 *  seconds, but an MCP call that never returns is worse than one that says "still going" — so the
 *  wait is bounded and `run_status` picks the run back up. */
const DEFAULT_WAIT_SECONDS = 90;
const MAX_WAIT_SECONDS = 300;
const POLL_MS = 1_500;

/** The statuses a run stops at. Anything else means it is still queued or executing. */
const TERMINAL = new Set(["passed", "needs_review", "failed", "cancelled"]);

/**
 * What one run looks like to the model — the whole verdict in one object, so a repair can be
 * checked without a human reading a screen and reporting back.
 */
export interface McpRunResult {
  runId: string;
  testId: string;
  testName: string;
  environment: string;
  /** False when the wait elapsed before the run finished — poll on with `run_status`. */
  finished: boolean;
  status: string;
  outcome: RunOutcome;
  /** The replay error, and the step it died on, when it died on one. */
  error: string | null;
  failureKind: string | null;
  failingStep: { index: number; label: string } | null;
  /** Every checkpoint the run captured, and how many of them a HUMAN still has to decide. */
  checkpoints: Array<{
    name: string;
    reviewState: string;
    resolution: string | null;
    compareMode: string;
    diffScore: number | null;
    judgeReasoning: string | null;
  }>;
  awaitingHumanReview: number;
  /** Only the assertions that did not hold — a passing one has nothing to say. */
  failingAssertions: Array<{
    id: string;
    check: string;
    outcome: string;
    mode: string;
    left: string | null;
    right: string | null;
    detail: string;
  }>;
  /** Where a human opens this run in Varys, relative to the app's origin. */
  path: string;
  /** What the verdict MEANS, and what may honestly be claimed about it. */
  note: string;
}

/**
 * Running a test from an authoring or repair session (Slice 19, slice 14).
 *
 * The loop this closes: diagnose → fix → **prove it** → report. Before this, an attended repair
 * ended at "I wrote a new version" and the person who asked for it had to go and press Run to find
 * out whether it worked. The fix and the proof of the fix were in different hands, which is a poor
 * place to leave a conversation that began "this test is broken, fix it".
 *
 * It is deliberately NOT on the Repair Agent's toolset. A drainer that could trigger runs could sit
 * in an unattended fix-and-retry loop, burning replays against a real app until something goes
 * green — and "went green eventually" is exactly the evidence the review gate refuses to accept.
 * An unattended repair's re-run is queued by Varys itself, once, after the repair is reported.
 *
 * Two things this can never do, and the `note` says both rather than leaving them to be inferred:
 * approve a baseline (a human's, per DESIGN §4 — approving deletes the previous golden with no
 * rollback), and turn `pending-baseline` into a pass.
 */
@Injectable()
export class RunToolService {
  private readonly log = new Logger(RunToolService.name);

  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  /** Queue a run of a test's LATEST version and wait for the verdict. */
  async runTest(
    testId: string,
    opts: { actor: string; environmentId?: string; waitSeconds?: number },
  ): Promise<McpRunResult> {
    const id = testId.trim();
    if (!id) {
      throw new BadRequestException(
        "run_test needs a testId — pass the id of the test to run, or a sessionId to run the test a repair session is open on.",
      );
    }
    // `create` pins the latest version, so a fix written moments ago is what this replays — which
    // is the only reason the tool is worth having.
    const { runId } = await this.runs.create(id, {
      environmentId: opts.environmentId,
      triggeredBy: opts.actor,
      triggerSource: "manual",
    });
    this.log.log(`run_test: queued run ${runId} of test ${id} for ${opts.actor}`);
    return this.wait(runId, opts.waitSeconds);
  }

  /** Pick a run back up — the continuation of a `run_test` whose wait elapsed. */
  async runStatus(runId: string, waitSeconds?: number): Promise<McpRunResult> {
    const id = runId.trim();
    if (!id) throw new BadRequestException("run_status needs the runId run_test gave you.");
    return this.wait(id, waitSeconds);
  }

  private async wait(runId: string, waitSeconds?: number): Promise<McpRunResult> {
    const budget = clampSeconds(waitSeconds) * 1000;
    const deadline = Date.now() + budget;
    let view = await this.runs.getById(runId);
    while (!TERMINAL.has(view.status) && Date.now() < deadline) {
      await sleep(POLL_MS);
      view = await this.runs.getById(runId);
    }
    return this.shape(view);
  }

  private shape(view: RunView): McpRunResult {
    const finished = TERMINAL.has(view.status);
    const failingStep =
      view.failedStepIndex !== null && view.steps[view.failedStepIndex]
        ? { index: view.failedStepIndex, label: view.steps[view.failedStepIndex].label }
        : null;
    const awaitingHumanReview = view.checkpoints.filter(
      (c) => c.reviewState !== "passed" && c.resolution === null,
    ).length;

    return {
      runId: view.runId,
      testId: view.testId,
      testName: view.testName,
      environment: view.environment,
      finished,
      status: view.status,
      outcome: view.outcome,
      error: view.error,
      failureKind: view.failureKind ?? null,
      failingStep,
      checkpoints: view.checkpoints.map((c) => ({
        name: c.name,
        reviewState: c.reviewState,
        resolution: c.resolution,
        compareMode: c.compareMode,
        diffScore: c.diffScore,
        judgeReasoning: c.judgeReasoning,
      })),
      awaitingHumanReview,
      failingAssertions: view.assertions
        .filter((a) => a.outcome !== "passed")
        .map((a) => ({
          id: a.id,
          check: a.check,
          outcome: a.outcome,
          mode: a.mode,
          left: a.left,
          right: a.right,
          detail: a.detail,
        })),
      path: `/runs/${view.runId}`,
      note: noteFor(view, finished, awaitingHumanReview),
    };
  }
}

/**
 * What the verdict means, in the terms the model has to report it in.
 *
 * Written as prose rather than left to the status string because the two answers most easily
 * misreported are the ones that look like success: `pending-baseline` is not a pass (nothing was
 * compared), and a checkpoint awaiting review is not a pass either (a human has not looked yet).
 */
function noteFor(view: RunView, finished: boolean, awaiting: number): string {
  if (!finished) {
    return `The run is still ${view.status}. Call run_status with runId ${view.runId} to keep waiting — do not report an outcome yet.`;
  }
  switch (view.outcome) {
    case "passed":
      return "The test verified against its baseline. If you have just repaired it, this is the evidence the repair works — say so, and say which version now runs.";
    case "healed":
      return "Everything verified, but the definition it replayed contains a repair NOBODY HAS ACCEPTED. Report it as healed, not passed: a human accepts the repaired version in the Repair queue before this counts as green.";
    case "baseline":
      return "This run set or updated the golden baseline. It verified nothing — do not report it as a pass.";
    case "pending-baseline":
      return "There was no baseline to compare against, so nothing was verified. A HUMAN must approve the capture in Needs review before this test can pass or fail; you cannot approve it, and you must not describe this run as passing.";
    case "regression":
      return `A baseline existed and the capture differs — ${awaiting} checkpoint(s) are waiting for a human decision in Needs review. This is a visual difference, not something to repair by re-pinning a locator.`;
    case "failed":
      return view.failureKind === "locator"
        ? "The run could not find an element it needed — the one class of failure a re-pinned locator fixes. Open a repair session on this run to diagnose it."
        : "The run failed for a reason no re-pinned locator addresses (a crash, a timeout, a failed judge, or an assertion that does not hold). Diagnose and explain it; do not re-pin anything to make it go away.";
    case "cancelled":
      return "The run was cancelled before it finished — nothing was verified.";
    default:
      return `The run finished as ${view.outcome}.`;
  }
}

function clampSeconds(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return DEFAULT_WAIT_SECONDS;
  return Math.min(MAX_WAIT_SECONDS, Math.max(5, Math.floor(v)));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
