import {
  BadRequestException,
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
import { deriveRunOutcome } from "@varys/review-contract";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { RunsService } from "../runs/runs.service";
import { effectiveTestIds } from "../suites/suite-membership";

const ENVIRONMENT = "default";

/** Tally child statuses into the aggregate counts (unknown statuses only count
 *  toward total — forward-compatible with new run states). */
function countStatuses(statuses: string[]): SuiteRunCounts {
  const counts: SuiteRunCounts = {
    total: statuses.length,
    queued: 0,
    running: 0,
    passed: 0,
    needsReview: 0,
    failed: 0,
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

  /** Suite-run history, newest first — aggregates derived on read. */
  async list(limit = 50): Promise<SuiteRunSummary[]> {
    const parents = await this.db
      .select({
        id: suiteRuns.id,
        suiteName: suiteRuns.suiteName,
        createdAt: suiteRuns.createdAt,
      })
      .from(suiteRuns)
      .orderBy(desc(suiteRuns.createdAt))
      .limit(limit);
    if (parents.length === 0) return [];

    const children = await this.db
      .select({
        suiteRunId: runs.suiteRunId,
        status: runs.status,
        environmentId: runs.environmentId,
      })
      .from(runs)
      .where(
        inArray(
          runs.suiteRunId,
          parents.map((p) => p.id),
        ),
      );
    const envNames = await this.environmentNames(children.map((c) => c.environmentId));

    return parents.map((p): SuiteRunSummary => {
      const own = children.filter((c) => c.suiteRunId === p.id);
      const counts = countStatuses(own.map((c) => c.status));
      const environmentNames = [
        ...new Set(own.map((c) => this.envName(c.environmentId, envNames))),
      ].sort();
      return {
        suiteRunId: p.id,
        suiteName: p.suiteName,
        environments: environmentNames,
        status: deriveStatus(counts),
        counts,
        runTimestamp: p.createdAt.toISOString(),
      };
    });
  }

  /** The report: the aggregate plus child rows in stable test×env order. */
  async getById(suiteRunId: string): Promise<SuiteRunView> {
    const [parent] = await this.db
      .select({
        id: suiteRuns.id,
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
        status: runs.status,
        error: runs.error,
        environmentId: runs.environmentId,
        testName: tests.name,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .where(eq(runs.suiteRunId, suiteRunId))
      .orderBy(asc(tests.name));
    const envNames = await this.environmentNames(rows.map((r) => r.environmentId));

    // Each child's checkpoint verdicts, grouped per run, for the shared outcome derivation
    // (baseline vs verified, …). The parent aggregate + counts stay on coarse `status`.
    const childIds = rows.map((r) => r.runId);
    const checkpointsByRun = new Map<string, { reviewState: ReviewState; resolution: Resolution | null }[]>();
    if (childIds.length) {
      const resultRows = await this.db
        .select({
          runId: runResults.runId,
          reviewState: runResults.reviewState,
          resolution: runResults.resolution,
        })
        .from(runResults)
        .where(inArray(runResults.runId, childIds));
      for (const rr of resultRows) {
        const list = checkpointsByRun.get(rr.runId) ?? [];
        list.push({ reviewState: rr.reviewState as ReviewState, resolution: rr.resolution as Resolution | null });
        checkpointsByRun.set(rr.runId, list);
      }
    }

    const children: SuiteRunChild[] = rows
      .map((r) => ({
        runId: r.runId,
        testName: r.testName,
        environment: this.envName(r.environmentId, envNames),
        status: r.status,
        outcome: deriveRunOutcome(checkpointsByRun.get(r.runId) ?? [], {
          status: r.status,
          error: r.error,
        }),
        error: r.error,
      }))
      .sort(
        (a, b) =>
          a.testName.localeCompare(b.testName) || a.environment.localeCompare(b.environment),
      );

    const counts = countStatuses(children.map((c) => c.status));
    return {
      suiteRunId: parent.id,
      suiteName: parent.suiteName,
      environments: [...new Set(children.map((c) => c.environment))].sort(),
      status: deriveStatus(counts),
      counts,
      runTimestamp: parent.createdAt.toISOString(),
      children,
    };
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

  /** "default" when env-less or the environment was since deleted (graceful). */
  private envName(environmentId: string | null, names: Map<string, string>): string {
    return environmentId ? (names.get(environmentId) ?? ENVIRONMENT) : ENVIRONMENT;
  }
}
