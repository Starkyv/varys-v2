import { Inject, Injectable } from "@nestjs/common";
import { environments, runResults, runs, testVersions, tests } from "@varys/db";
import type {
  CheckpointTrend,
  DashboardMatrix,
  DashboardSummary,
  DashboardView,
  MatrixCell,
  MatrixCellStatus,
} from "@varys/review-contract";
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

    // For the latest runs that are `needs_review`, which carry a real diff (vs only a
    // first-capture pending baseline) — the review-vs-baseline cell distinction.
    const needsReviewRunIds = [...latest.values()]
      .filter((r) => r.status === "needs_review")
      .map((r) => r.runId);
    const hasDiff = new Set<string>();
    if (needsReviewRunIds.length) {
      const diffRows = await this.db
        .select({ runId: runResults.runId })
        .from(runResults)
        .where(and(inArray(runResults.runId, needsReviewRunIds), eq(runResults.reviewState, "diff")));
      for (const d of diffRows) hasDiff.add(d.runId);
    }

    const cellStatus = (status: string, runId: string): MatrixCellStatus => {
      switch (status) {
        case "failed":
          return "failed";
        case "queued":
        case "running":
          return "running";
        case "passed":
          return "passed";
        case "needs_review":
          return hasDiff.has(runId) ? "needs_review" : "pending-baseline";
        default:
          return "running"; // unreachable — run status taxonomy is fixed
      }
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
            ? { environment: envName, status: cellStatus(r.status, r.runId), runId: r.runId }
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
    // 7-day pass-rate windows in one read.
    const finishedRows = await this.db
      .select({ status: runs.status, createdAt: runs.createdAt })
      .from(runs)
      .where(and(gte(runs.createdAt, d14), inArray(runs.status, [...FINISHED])));
    const passRate = this.rate(finishedRows, d7, new Date(now));
    const passRatePrev = this.rate(finishedRows, d14, d7);
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

  /** Pass rate (passed ÷ finished) over [from, to); 0 when nothing finished. */
  private rate(
    rows: { status: string; createdAt: Date }[],
    from: Date,
    to: Date,
  ): number {
    const inWindow = rows.filter((r) => r.createdAt >= from && r.createdAt < to);
    if (inWindow.length === 0) return 0;
    const passed = inWindow.filter((r) => r.status === "passed").length;
    return passed / inWindow.length;
  }
}
