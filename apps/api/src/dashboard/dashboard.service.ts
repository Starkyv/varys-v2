import { Inject, Injectable } from "@nestjs/common";
import { environments, runResults, runs, testVersions, tests } from "@varys/db";
import type {
  CheckpointTrend,
  DashboardMatrix,
  DashboardSummary,
  DashboardView,
  MatrixCell,
  MatrixCellStatus,
  Resolution,
  ReviewState,
  RunOutcome,
} from "@varys/review-contract";
import { deriveRunOutcome } from "@varys/review-contract";
import { and, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { RunsService } from "../runs/runs.service";

const DEFAULT_ENV = "default";
/** How many checkpoint trends the sparkline panel shows (worst latest score first). */
const TREND_LIMIT = 8;

const DAY = 86_400_000;
/** Run-level statuses that count as a finished outcome (for the pass-rate math). */
const FINISHED = ["passed", "needs_review", "failed"] as const;
/** How many recent runs the activity feed shows. */
const FEED_LIMIT = 8;

/**
 * Dashboard read-model — everything derived on read from the existing tables; no
 * stored aggregate, no new table, no background job. This slice produces the KPI
 * `summary` and the `recentRuns` feed (the matrix + diff-trends are added by later
 * slices). Pass-rate/failure windows count every replay (including suite-run
 * children) since they are all real execution signal; the recent-runs feed reuses
 * the Runs-history list, which excludes children so one fan-out can't flood it.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RunsService) private readonly runs: RunsService,
  ) {}

  async getDashboard(): Promise<DashboardView> {
    const [summary, matrix, recentRuns, trends] = await Promise.all([
      this.summary(),
      this.matrix(),
      this.runs.listRuns(FEED_LIMIT),
      this.trends(),
    ]);
    return { summary, matrix, recentRuns, trends };
  }

  /**
   * Per-checkpoint diff-score trends over the last 14 days: one series per
   * (test, checkpoint) in run order (oldest→newest), so a checkpoint drifting toward
   * its threshold stands out. Only scored results count (a first-seed checkpoint has
   * no diff). Surfaces the worst latest scores first, capped at TREND_LIMIT.
   */
  private async trends(): Promise<CheckpointTrend[]> {
    const d14 = new Date(Date.now() - 14 * DAY);
    const rows = await this.db
      .select({
        checkpointName: runResults.checkpointName,
        diffScore: runResults.diffScore,
        testId: testVersions.testId,
        testName: tests.name,
      })
      .from(runResults)
      .innerJoin(runs, eq(runs.id, runResults.runId))
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .where(and(gte(runs.createdAt, d14), isNotNull(runResults.diffScore)))
      .orderBy(runs.createdAt); // ascending → series are oldest→newest

    // Group into series keyed by (test, checkpoint) — the same checkpoint name can
    // live in different tests, so the test id is part of the identity.
    const series = new Map<string, { testName: string; checkpointName: string; points: number[] }>();
    for (const r of rows) {
      if (r.diffScore == null) continue;
      const key = `${r.testId}::${r.checkpointName}`;
      let s = series.get(key);
      if (!s) {
        s = { testName: r.testName, checkpointName: r.checkpointName, points: [] };
        series.set(key, s);
      }
      s.points.push(r.diffScore);
    }

    return [...series.values()]
      .filter((s) => s.points.length >= 2) // a trend needs at least two points
      .map((s): CheckpointTrend => {
        const latestScore = s.points[s.points.length - 1];
        const tone = latestScore >= 0.05 ? "danger" : latestScore >= 0.01 ? "warning" : "success";
        return { checkpointName: s.checkpointName, testName: s.testName, points: s.points, latestScore, tone };
      })
      .sort((a, b) => b.latestScore - a.latestScore)
      .slice(0, TREND_LIMIT);
  }

  /**
   * The test × environment status matrix: each cell is the LATEST run for that
   * (test, environment) pairing, mapped to a display status. Counts every run
   * (standalone + suite-run children) since the cell is "current status of this
   * test in this environment", origin-agnostic. Columns are the environments that
   * have any run ("default" for env-less runs); rows are tests that have any run.
   */
  private async matrix(): Promise<DashboardMatrix> {
    const runRows = await this.db
      .select({
        runId: runs.id,
        status: runs.status,
        error: runs.error,
        environmentId: runs.environmentId,
        createdAt: runs.createdAt,
        testId: testVersions.testId,
        testName: tests.name,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(tests, eq(tests.id, testVersions.testId));

    if (runRows.length === 0) return { environments: [], rows: [] };

    // Resolve environment names + creation order (for stable column ordering). A
    // dangling/deleted environment id degrades to "default", mirroring the runner.
    const envIds = [
      ...new Set(runRows.map((r) => r.environmentId).filter((x): x is string => x != null)),
    ];
    const envMeta = new Map<string, { name: string; createdAt: Date }>();
    if (envIds.length) {
      const envs = await this.db
        .select({ id: environments.id, name: environments.name, createdAt: environments.createdAt })
        .from(environments)
        .where(inArray(environments.id, envIds));
      for (const e of envs) envMeta.set(e.id, { name: e.name, createdAt: e.createdAt });
    }
    const envNameOf = (id: string | null) => (id ? (envMeta.get(id)?.name ?? DEFAULT_ENV) : DEFAULT_ENV);

    // Latest run per (test, environment).
    const latest = new Map<string, (typeof runRows)[number] & { envName: string }>();
    for (const r of runRows) {
      const envName = envNameOf(r.environmentId);
      const key = `${r.testId}::${envName}`;
      const cur = latest.get(key);
      if (!cur || r.createdAt > cur.createdAt) latest.set(key, { ...r, envName });
    }

    // Each latest run's checkpoint verdicts, grouped per run — so the cell's outcome
    // (verified vs baseline vs needs_review vs pending-baseline …) comes from the single
    // shared derivation, not an ad-hoc diff probe.
    const latestRunIds = [...latest.values()].map((r) => r.runId);
    const checkpointsByRun = new Map<string, { reviewState: ReviewState; resolution: Resolution | null }[]>();
    if (latestRunIds.length) {
      const resultRows = await this.db
        .select({
          runId: runResults.runId,
          reviewState: runResults.reviewState,
          resolution: runResults.resolution,
        })
        .from(runResults)
        .where(inArray(runResults.runId, latestRunIds));
      for (const rr of resultRows) {
        const list = checkpointsByRun.get(rr.runId) ?? [];
        list.push({ reviewState: rr.reviewState as ReviewState, resolution: rr.resolution as Resolution | null });
        checkpointsByRun.set(rr.runId, list);
      }
    }

    const cellStatus = (run: { runId: string; status: string; error: string | null }): MatrixCellStatus => {
      const outcome = deriveRunOutcome(checkpointsByRun.get(run.runId) ?? [], {
        status: run.status,
        error: run.error,
      });
      // The cell shows a uniform in-progress state; queued and running collapse.
      return outcome === "queued" ? "running" : outcome;
    };

    // Column order: environments by creation order, "default" (env-less) last.
    const usedEnvNames = new Set(runRows.map((r) => envNameOf(r.environmentId)));
    const createdAtOfName = new Map<string, Date>();
    for (const { name, createdAt } of envMeta.values()) {
      const cur = createdAtOfName.get(name);
      if (!cur || createdAt < cur) createdAtOfName.set(name, createdAt);
    }
    const namedEnvs = [...usedEnvNames]
      .filter((n) => n !== DEFAULT_ENV)
      .sort((a, b) => (createdAtOfName.get(a)?.getTime() ?? 0) - (createdAtOfName.get(b)?.getTime() ?? 0));
    const columns = [...namedEnvs, ...(usedEnvNames.has(DEFAULT_ENV) ? [DEFAULT_ENV] : [])];

    // Rows: tests that have any run, by name.
    const testNames = new Map<string, string>();
    for (const r of runRows) testNames.set(r.testId, r.testName);
    const rows = [...testNames.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([testId, testName]) => ({
        testId,
        testName,
        cells: columns.map((envName): MatrixCell => {
          const r = latest.get(`${testId}::${envName}`);
          return r
            ? { environment: envName, status: cellStatus(r), runId: r.runId }
            : { environment: envName, status: "none", runId: null };
        }),
      }));

    return { environments: columns, rows };
  }

  private async summary(): Promise<DashboardSummary> {
    const now = Date.now();
    const d7 = new Date(now - 7 * DAY);
    const d14 = new Date(now - 14 * DAY);
    const h24 = new Date(now - DAY);
    const h48 = new Date(now - 2 * DAY);

    // Tests: total + how many were created in the last 7 days.
    const testRows = await this.db.select({ createdAt: tests.createdAt }).from(tests);
    const totalTests = testRows.length;
    const totalTestsDelta = testRows.filter((t) => t.createdAt >= d7).length;

    // Distinct environments that have any run ("across N environments"); a run with
    // no environment counts as the single "default" environment.
    const envRows = await this.db.selectDistinct({ environmentId: runs.environmentId }).from(runs);
    const hasDefault = envRows.some((r) => r.environmentId == null);
    const environmentsCount =
      envRows.filter((r) => r.environmentId != null).length + (hasDefault ? 1 : 0);

    // Finished runs in the last 14 days — enough to cover both the current and prior
    // 7-day pass-rate windows in one read. Pass-rate measures *verification* only, so each
    // run's derived outcome is computed and only `passed`/`failed` count — baseline-
    // establishment and first-run ("pending baseline") runs are neither a pass nor a fail.
    const finishedRows = await this.db
      .select({ runId: runs.id, status: runs.status, error: runs.error, createdAt: runs.createdAt })
      .from(runs)
      .where(and(gte(runs.createdAt, d14), inArray(runs.status, [...FINISHED])));
    const finishedCheckpoints = new Map<string, { reviewState: ReviewState; resolution: Resolution | null }[]>();
    if (finishedRows.length) {
      const resultRows = await this.db
        .select({
          runId: runResults.runId,
          reviewState: runResults.reviewState,
          resolution: runResults.resolution,
        })
        .from(runResults)
        .where(inArray(runResults.runId, finishedRows.map((r) => r.runId)));
      for (const rr of resultRows) {
        const list = finishedCheckpoints.get(rr.runId) ?? [];
        list.push({ reviewState: rr.reviewState as ReviewState, resolution: rr.resolution as Resolution | null });
        finishedCheckpoints.set(rr.runId, list);
      }
    }
    const finished = finishedRows.map((r) => ({
      outcome: deriveRunOutcome(finishedCheckpoints.get(r.runId) ?? [], { status: r.status, error: r.error }),
      createdAt: r.createdAt,
    }));
    const passRate = this.rate(finished, d7, new Date(now));
    const passRatePrev = this.rate(finished, d14, d7);
    const passRateDeltaPct = (passRate - passRatePrev) * 100;

    // Failed runs in the last 48h — covers the current and prior 24h windows.
    const failedRows = await this.db
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(and(gte(runs.createdAt, h48), eq(runs.status, "failed")));
    const failures24h = failedRows.filter((r) => r.createdAt >= h24).length;
    const failuresPrev24h = failedRows.filter((r) => r.createdAt >= h48 && r.createdAt < h24).length;
    const failures24hDelta = failures24h - failuresPrev24h;

    // Checkpoints currently awaiting a decision; the delta is how many arrived this week.
    const pending = await this.db
      .select({ createdAt: runs.createdAt })
      .from(runResults)
      .innerJoin(runs, eq(runs.id, runResults.runId))
      .where(
        and(
          inArray(runResults.reviewState, ["pending-baseline", "diff"]),
          isNull(runResults.resolution),
        ),
      );
    const needsReview = pending.length;
    const needsReviewDelta = pending.filter((p) => p.createdAt >= d7).length;

    return {
      totalTests,
      environmentsCount,
      totalTestsDelta,
      passRate,
      passRateDeltaPct,
      needsReview,
      needsReviewDelta,
      failures24h,
      failures24hDelta,
    };
  }

  /** Verification pass rate (`passed` ÷ verifications) over [from, to), where a verification is a
   *  run whose outcome is `passed`, `failed`, or `regression`. Baseline-establishment and first-run
   *  ("pending baseline") runs are excluded — they don't verify anything. 0 when no verification
   *  finished in the window. */
  private rate(
    rows: { outcome: RunOutcome; createdAt: Date }[],
    from: Date,
    to: Date,
  ): number {
    const verifications = rows.filter(
      (r) =>
        r.createdAt >= from &&
        r.createdAt < to &&
        // A regression is a verification that failed (the capture differed) — count it as a
        // non-passing verification, same as the pre-split `failed` did.
        (r.outcome === "passed" || r.outcome === "failed" || r.outcome === "regression"),
    );
    if (verifications.length === 0) return 0;
    const passed = verifications.filter((r) => r.outcome === "passed").length;
    return passed / verifications.length;
  }
}
