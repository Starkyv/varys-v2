import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { environments, runResults, runs, suiteRuns, suites, tests, testVersions } from "@varys/db";
import type {
  Resolution,
  ReviewState,
  SuiteRunChild,
  SuiteRunCounts,
  SuiteRunSummary,
  SuiteRunView,
} from "@varys/review-contract";
import { deriveRunOutcome, isRepairInReview, type RunOutcome } from "@varys/review-contract";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { RunsService } from "../runs/runs.service";
import { effectiveTestIds } from "../suites/suite-membership";

const ENVIRONMENT = "default";

/** Checkpoint verdicts of one run, as the outcome derivation and the pending tally read them. */
type Verdict = { reviewState: ReviewState; resolution: Resolution | null };

/** The child columns every read of a fan-out needs — the shape `summarize` folds. */
interface ChildRow {
  runId: string;
  testId: string;
  status: string;
  error: string | null;
  environmentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  triggeredBy: string | null;
  versionRepairJobId: string | null;
  versionReviewState: string | null;
}

/** A child that has not reached a terminal state — its `updatedAt` is not a finish time. */
const inFlight = (status: string): boolean => status === "queued" || status === "running";

/**
 * Tally child statuses into the aggregate counts (unknown statuses only count toward total —
 * forward-compatible with new run states).
 *
 * `healed` is counted from the children's derived OUTCOMES, not their statuses, and deliberately
 * does not move any other number: a healed child's coarse status is `passed`, so it stays in
 * `passed` and the suite still reports passing (Slice 19, slice 06 — a healed run is a queue item,
 * not an alarm, and must not fail a suite). The healed count sits alongside as "and this much of
 * that pass is resting on repairs nobody has accepted yet".
 */
function countStatuses(statuses: string[], outcomes: RunOutcome[] = []): SuiteRunCounts {
  const counts: SuiteRunCounts = {
    total: statuses.length,
    queued: 0,
    running: 0,
    passed: 0,
    needsReview: 0,
    failed: 0,
    healed: outcomes.filter((o) => o === "healed").length,
  };
  for (const s of statuses) {
    if (s === "queued") counts.queued += 1;
    else if (s === "running") counts.running += 1;
    else if (s === "passed") counts.passed += 1;
    else if (s === "needs_review") counts.needsReview += 1;
    else if (s === "failed") counts.failed += 1;
  }
  return counts;
}

/** Derive the aggregate status from the children — no aggregate state is stored,
 *  so the report always mirrors live child/review state (PRD decision). */
function deriveStatus(counts: SuiteRunCounts): string {
  if (counts.queued === counts.total) return "queued";
  if (counts.queued > 0 || counts.running > 0) return "running";
  if (counts.failed > 0) return "failed";
  if (counts.needsReview > 0) return "needs_review";
  // `counts.healed` is intentionally absent from this ladder: a healed child does not fail or
  // hold up a suite, it just leaves something in the repair review queue.
  return "passed";
}

@Injectable()
export class SuiteRunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RunsService) private readonly runs: RunsService,
  ) {}

  /**
   * Trigger `suite × env(s)`: snapshot the membership NOW, insert the parent
   * (with the suite-name snapshot), then fan out one ordinary child run per
   * (member test × environment) through the existing single-run creation path
   * (latest-version pin + enqueue). No environments selected ⇒ one env-less
   * ("default") child per test, mirroring the optional-env single run.
   */
  async trigger(
    suiteId: string,
    environmentIds?: string[],
    trace?: boolean,
    triggeredBy?: string,
  ): Promise<{ suiteRunId: string }> {
    const [suite] = await this.db
      .select({ id: suites.id, name: suites.name })
      .from(suites)
      .where(eq(suites.id, suiteId))
      .limit(1);
    if (!suite) throw new NotFoundException(`Suite ${suiteId} not found`);

    // Resolve the suite's EFFECTIVE tests NOW: selected folders expand to their tests (+ subfolders,
    // dynamically), unioned with individually-selected tests. Snapshotting at trigger time means a
    // folder-based suite picks up whatever is in the folder at the moment it runs.
    const memberTestIds = await effectiveTestIds(this.db, suiteId);
    if (memberTestIds.length === 0) {
      throw new BadRequestException(
        "suite has no tests to run — add tests or a non-empty folder before running it",
      );
    }

    // Validate the whole env selection up front: a bogus id fails the trigger
    // before any parent/children exist (no half-created fan-out).
    const envIds = [...new Set(environmentIds ?? [])];
    if (envIds.length > 0) {
      const found = await this.db
        .select({ id: environments.id })
        .from(environments)
        .where(inArray(environments.id, envIds));
      const known = new Set(found.map((e) => e.id));
      const missing = envIds.find((id) => !known.has(id));
      if (missing) throw new NotFoundException(`Environment ${missing} not found`);
    }

    const [parent] = await this.db
      .insert(suiteRuns)
      .values({ suiteId: suite.id, suiteName: suite.name })
      .returning({ id: suiteRuns.id });

    // The trace flag fans out to every child (per-trigger on demand only).
    const targets: (string | undefined)[] = envIds.length > 0 ? envIds : [undefined];
    for (const testId of memberTestIds) {
      for (const envId of targets) {
        await this.runs.create(testId, {
          environmentId: envId,
          suiteRunId: parent.id,
          trace,
          triggeredBy,
          triggerSource: "suite",
        });
      }
    }
    return { suiteRunId: parent.id };
  }

  /**
   * Re-run a past fan-out: the SAME suite against the SAME environments, resolved fresh.
   * Membership is re-read at trigger time (that is what `trigger` does), so a re-run answers
   * "does the suite pass now", not "did that exact set of tests pass" — the same choice the
   * single-run re-run makes by pinning the latest version.
   *
   * Two things can make it impossible, and both are refusals rather than a quiet substitution:
   * the suite is gone (nothing to re-resolve membership from), or every environment the fan-out
   * targeted is gone (falling back to env-less would run `{{baseUrl}}` tests with no base URL).
   */
  async rerun(suiteRunId: string, triggeredBy?: string): Promise<{ suiteRunId: string }> {
    const [parent] = await this.db
      .select({ id: suiteRuns.id, suiteId: suiteRuns.suiteId, suiteName: suiteRuns.suiteName })
      .from(suiteRuns)
      .where(eq(suiteRuns.id, suiteRunId))
      .limit(1);
    if (!parent) throw new NotFoundException(`Suite run ${suiteRunId} not found`);
    if (!parent.suiteId) {
      throw new ConflictException(
        `The suite “${parent.suiteName}” no longer exists — this report is history only`,
      );
    }

    const children = await this.db
      .select({ environmentId: runs.environmentId, trace: runs.trace })
      .from(runs)
      .where(eq(runs.suiteRunId, suiteRunId));
    const targeted = [...new Set(children.map((c) => c.environmentId).filter((x): x is string => x != null))];
    const surviving = await this.survivingEnvironmentIds(targeted);
    if (targeted.length > 0 && surviving.length === 0) {
      throw new ConflictException(
        "Every environment this suite run targeted has been deleted — pick environments and run the suite again",
      );
    }

    return this.trigger(parent.suiteId, surviving, children.some((c) => c.trace), triggeredBy);
  }

  /**
   * Delete a fan-out: every child run (through the single-run delete, so results, steps, network
   * rows and orphaned blobs go with them, and an in-flight child is cancelled first), then the
   * parent row. Irreversible. Baselines are untouched, and `test_schedules.lastSuiteRunId` clears
   * itself through its ON DELETE SET NULL FK.
   */
  async deleteSuiteRun(suiteRunId: string): Promise<{ ok: true; deletedRuns: number }> {
    const [parent] = await this.db
      .select({ id: suiteRuns.id })
      .from(suiteRuns)
      .where(eq(suiteRuns.id, suiteRunId))
      .limit(1);
    if (!parent) throw new NotFoundException(`Suite run ${suiteRunId} not found`);

    const children = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.suiteRunId, suiteRunId));
    for (const child of children) {
      await this.runs.deleteRun(child.id);
    }
    await this.db.delete(suiteRuns).where(eq(suiteRuns.id, suiteRunId));
    return { ok: true, deletedRuns: children.length };
  }

  /** Suite-run history, newest first — aggregates derived on read. */
  async list(limit = 50): Promise<SuiteRunSummary[]> {
    const parents = await this.db
      .select({
        id: suiteRuns.id,
        suiteId: suiteRuns.suiteId,
        suiteName: suiteRuns.suiteName,
        createdAt: suiteRuns.createdAt,
      })
      .from(suiteRuns)
      .orderBy(desc(suiteRuns.createdAt))
      .limit(limit);
    if (parents.length === 0) return [];

    const children = await this.db
      .select({
        runId: runs.id,
        suiteRunId: runs.suiteRunId,
        testId: testVersions.testId,
        status: runs.status,
        error: runs.error,
        environmentId: runs.environmentId,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        triggeredBy: runs.triggeredBy,
        versionRepairJobId: testVersions.repairJobId,
        versionReviewState: testVersions.reviewState,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .where(
        inArray(
          runs.suiteRunId,
          parents.map((p) => p.id),
        ),
      );
    const envNames = await this.environmentNames(children.map((c) => c.environmentId));
    // The history rows carry a healed count too, not just the report: a suite that reads "passed"
    // while three of its tests are running on unaccepted repairs is exactly the thing you want to
    // see WITHOUT opening it.
    const checkpoints = await this.checkpointsByRun(children.map((c) => c.runId));

    return parents.map((p) =>
      this.summarize(
        p,
        children.filter((c) => c.suiteRunId === p.id),
        envNames,
        checkpoints,
      ),
    );
  }

  /** The report: the aggregate plus child rows in stable test×env order. */
  async getById(suiteRunId: string): Promise<SuiteRunView> {
    const [parent] = await this.db
      .select({
        id: suiteRuns.id,
        suiteId: suiteRuns.suiteId,
        suiteName: suiteRuns.suiteName,
        createdAt: suiteRuns.createdAt,
      })
      .from(suiteRuns)
      .where(eq(suiteRuns.id, suiteRunId))
      .limit(1);
    if (!parent) throw new NotFoundException(`Suite run ${suiteRunId} not found`);

    const rows = await this.db
      .select({
        runId: runs.id,
        testId: testVersions.testId,
        status: runs.status,
        error: runs.error,
        environmentId: runs.environmentId,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        trace: runs.trace,
        triggeredBy: runs.triggeredBy,
        testName: tests.name,
        versionRepairJobId: testVersions.repairJobId,
        versionReviewState: testVersions.reviewState,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .where(eq(runs.suiteRunId, suiteRunId))
      .orderBy(asc(tests.name));
    const envNames = await this.environmentNames(rows.map((r) => r.environmentId));

    // Each child's checkpoint verdicts, grouped per run, for the shared outcome derivation
    // (baseline vs verified, …) and the per-child review-debt tally. The parent aggregate stays on
    // coarse `status`; of the counts, only `healed` reads the derived outcome — see countStatuses.
    const checkpointsByRun = await this.checkpointsByRun(rows.map((r) => r.runId));

    const children: SuiteRunChild[] = rows
      .map((r) => ({
        runId: r.runId,
        testId: r.testId,
        testName: r.testName,
        environment: this.envName(r.environmentId, envNames),
        environmentId: r.environmentId,
        // An env-less child cannot be "missing" an environment; one that named an id we can no
        // longer resolve had its environment deleted since the run.
        environmentMissing: r.environmentId != null && !envNames.has(r.environmentId),
        status: r.status,
        outcome: this.outcomeOf(r, checkpointsByRun),
        error: r.error,
        trace: r.trace,
        runTimestamp: r.createdAt.toISOString(),
        durationMs: inFlight(r.status)
          ? null
          : Math.max(0, r.updatedAt.getTime() - r.createdAt.getTime()),
        pendingCheckpoints: (checkpointsByRun.get(r.runId) ?? []).filter(
          (v) => v.resolution == null && (v.reviewState === "pending-baseline" || v.reviewState === "diff"),
        ).length,
      }))
      .sort(
        (a, b) =>
          a.testName.localeCompare(b.testName) || a.environment.localeCompare(b.environment),
      );

    return {
      ...this.summarize(parent, rows, envNames, checkpointsByRun),
      children,
    };
  }

  /**
   * Fold a parent + its children into the history/report aggregate. One place, so the row you
   * scan in the list and the header you open are computed from the same rules.
   */
  private summarize(
    parent: { id: string; suiteId: string | null; suiteName: string; createdAt: Date },
    children: ChildRow[],
    envNames: Map<string, string>,
    checkpoints: Map<string, Verdict[]>,
  ): SuiteRunSummary {
    const counts = countStatuses(
      children.map((c) => c.status),
      children.map((c) => this.outcomeOf(c, checkpoints)),
    );
    const targetedEnvIds = [
      ...new Set(children.map((c) => c.environmentId).filter((x): x is string => x != null)),
    ];
    // A fan-out is finished when no child is still in flight — then its last child's `updatedAt`
    // is the wall-clock end. An empty fan-out (every child deleted) has no end and no duration.
    const settled = children.length > 0 && !children.some((c) => inFlight(c.status));
    const finishedAt = settled
      ? new Date(Math.max(...children.map((c) => c.updatedAt.getTime())))
      : null;

    return {
      suiteRunId: parent.id,
      suiteName: parent.suiteName,
      suiteId: parent.suiteId,
      environments: [...new Set(children.map((c) => this.envName(c.environmentId, envNames)))].sort(),
      environmentIds: targetedEnvIds.filter((id) => envNames.has(id)),
      environmentsMissing: targetedEnvIds.filter((id) => !envNames.has(id)).length,
      testCount: new Set(children.map((c) => c.testId)).size,
      status: deriveStatus(counts),
      counts,
      runTimestamp: parent.createdAt.toISOString(),
      finishedAt: finishedAt?.toISOString() ?? null,
      durationMs: finishedAt ? Math.max(0, finishedAt.getTime() - parent.createdAt.getTime()) : null,
      // Every child of a fan-out carries the same launcher attribution, so the first one speaks
      // for the parent.
      triggeredBy: children[0]?.triggeredBy ?? null,
    };
  }

  /** One batched read of every listed run's checkpoint verdicts, grouped per run — the input the
   *  shared outcome derivation needs. */
  private async checkpointsByRun(runIds: string[]): Promise<Map<string, Verdict[]>> {
    const byRun = new Map<string, Verdict[]>();
    if (runIds.length === 0) return byRun;
    const resultRows = await this.db
      .select({
        runId: runResults.runId,
        reviewState: runResults.reviewState,
        resolution: runResults.resolution,
      })
      .from(runResults)
      .where(inArray(runResults.runId, runIds));
    for (const rr of resultRows) {
      const list = byRun.get(rr.runId) ?? [];
      list.push({
        reviewState: rr.reviewState as ReviewState,
        resolution: rr.resolution as Resolution | null,
      });
      byRun.set(rr.runId, list);
    }
    return byRun;
  }

  /** A child's derived outcome, through the one shared derivation — including whether the version
   *  it replayed carries a repair nobody has accepted (`healed`). */
  private outcomeOf(
    row: {
      runId: string;
      status: string;
      error: string | null;
      versionRepairJobId: string | null;
      versionReviewState: string | null;
    },
    checkpoints: Map<string, Verdict[]>,
  ): RunOutcome {
    return deriveRunOutcome(checkpoints.get(row.runId) ?? [], {
      status: row.status,
      error: row.error,
      repairApplied: isRepairInReview(row.versionRepairJobId, row.versionReviewState),
    });
  }

  /** Batch-resolve environment ids → names (same pattern as the runs read-model). */
  private async environmentNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const envIds = [...new Set(ids.filter((x): x is string => x != null))];
    const map = new Map<string, string>();
    if (envIds.length > 0) {
      const envs = await this.db
        .select({ id: environments.id, name: environments.name })
        .from(environments)
        .where(inArray(environments.id, envIds));
      for (const e of envs) map.set(e.id, e.name);
    }
    return map;
  }

  /** Of the given environment ids, the ones that still exist — in the order given. */
  private async survivingEnvironmentIds(ids: string[]): Promise<string[]> {
    const names = await this.environmentNames(ids);
    return ids.filter((id) => names.has(id));
  }

  /** "default" when env-less or the environment was since deleted (graceful). */
  private envName(environmentId: string | null, names: Map<string, string>): string {
    return environmentId ? (names.get(environmentId) ?? ENVIRONMENT) : ENVIRONMENT;
  }
}
