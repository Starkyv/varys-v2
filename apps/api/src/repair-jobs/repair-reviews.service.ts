import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Logger } from "@nestjs/common";
import type {
  RepairReviewDecision,
  RepairReviewItem,
  Resolution,
  ReviewState,
  RunOutcome,
} from "@varys/review-contract";
import { deriveRunOutcome } from "@varys/review-contract";
import type { Step, TestDefinition } from "@varys/step-schema";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { baselines, repairJobs, runResults, runs, tests, testVersions } from "../db/schema";
import { CLOCK, type Clock } from "./clock";

/**
 * The repair review queue and the human decision on it (Slice 19, slice 04).
 *
 * A repaired version is written `unreviewed`, which is what stops an unattended agent's edit from
 * quietly becoming the definition every run uses. This service is the other half — without it the
 * slice would produce versions nobody can act on:
 *
 *  - **accept** marks the version reviewed. It writes no new version, because the repaired one is
 *    already the test's latest and therefore already what a run replays; accepting records that a
 *    human looked at it, which is the whole gate (ADR-0001: Claude proposes, a person decides).
 *  - **reject** reverts the test by APPENDING its previous definition as a new version. It does
 *    not delete the rejected one — the history keeps the attempt, so "the agent tried this and we
 *    said no" stays readable, and every run that already ran against it still resolves its
 *    version row.
 *
 * The richer side-by-side signal diff, the justification, and a clustered repair's blast radius
 * are slice 13's; what is here is the minimum that makes an unreviewed version actionable.
 */
@Injectable()
export class RepairReviewsService {
  private readonly log = new Logger(RepairReviewsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Every repaired version awaiting a decision, newest first. */
  async list(): Promise<RepairReviewItem[]> {
    const rows = await this.db
      .select({
        versionId: testVersions.id,
        testId: testVersions.testId,
        testName: tests.name,
        brief: tests.intent,
        version: testVersions.version,
        createdBy: testVersions.createdBy,
        createdAt: testVersions.createdAt,
        jobId: testVersions.repairJobId,
        justification: testVersions.justification,
        justificationReasoning: testVersions.justificationReasoning,
        // The test's highest version number, so the caller can tell an unreviewed version that
        // IS the active definition from one a later edit has already landed on top of.
        latestVersion: sql<number>`(select max(version) from test_versions v where v.test_id = ${testVersions.testId})`,
        previousVersion: sql<
          number | null
        >`(select max(version) from test_versions v where v.test_id = ${testVersions.testId} and v.version < ${testVersions.version})`,
        runId: repairJobs.runId,
        report: repairJobs.report,
        /** The job's ANCHOR test — the one a clustered repair is shown under. */
        jobTestId: repairJobs.testId,
      })
      .from(testVersions)
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .leftJoin(repairJobs, eq(repairJobs.id, testVersions.repairJobId))
      .where(eq(testVersions.reviewState, "unreviewed"))
      .orderBy(desc(testVersions.createdAt));

    // The re-run each repair triggered (slice 06). It is found by the VERSION it replayed, not by
    // a link on the run: a run of this exact version IS a run of this repair, whoever started it.
    const rerunByVersion = await this.rerunOutcomes(rows.map((r) => r.versionId));

    // A CLUSTERED repair (slice 07) wrote one unreviewed version per test in its Failure Cluster,
    // all under one job. That is one app change and must read as one decision, so the queue shows
    // the ANCHOR — the job's own test — and names the rest, rather than listing thirty-eight rows
    // a reviewer would have to accept one at a time and could accept inconsistently.
    const anchorByJob = new Map<string, string>();
    for (const r of rows) {
      if (r.jobId && r.testId === r.jobTestId && !anchorByJob.has(r.jobId)) {
        anchorByJob.set(r.jobId, r.versionId);
      }
    }
    const clusterNames = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.jobId) continue;
      const list = clusterNames.get(r.jobId) ?? [];
      list.push(r.testName);
      clusterNames.set(r.jobId, list);
    }
    const visible = rows.filter((r) => {
      if (!r.jobId) return true; // no job behind it — it stands alone
      const anchor = anchorByJob.get(r.jobId);
      // No anchor version (the job's own test was already decided, or its member row is gone):
      // fall back to showing every sibling rather than hiding work from the reviewer.
      return anchor === undefined ? true : anchor === r.versionId;
    });

    return visible.map((r) => ({
      versionId: r.versionId,
      testId: r.testId,
      testName: r.testName,
      version: r.version,
      previousVersion: r.previousVersion === null ? null : Number(r.previousVersion),
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      jobId: r.jobId,
      runId: r.runId ?? null,
      report: r.report ?? null,
      brief: r.brief,
      justification: r.justification ?? null,
      justificationReasoning: r.justificationReasoning ?? null,
      isActiveDefinition: Number(r.latestVersion) === r.version,
      rerunRunId: rerunByVersion.get(r.versionId)?.runId ?? null,
      rerunOutcome: rerunByVersion.get(r.versionId)?.outcome ?? null,
      clusterSize: r.jobId ? (clusterNames.get(r.jobId)?.length ?? 1) : 1,
      clusterTestNames: r.jobId ? (clusterNames.get(r.jobId) ?? [r.testName]) : [r.testName],
    }));
  }

  /**
   * The latest run of each given version, with its derived outcome — the evidence a reviewer
   * weighs beside the justification. A repair that verified reads `healed`; one whose re-run
   * failed or regressed says so, which is the more valuable of the two answers.
   */
  private async rerunOutcomes(
    versionIds: string[],
  ): Promise<Map<string, { runId: string; outcome: RunOutcome }>> {
    const byVersion = new Map<string, { runId: string; outcome: RunOutcome }>();
    if (versionIds.length === 0) return byVersion;
    const runRows = await this.db
      .select({
        runId: runs.id,
        versionId: runs.testVersionId,
        status: runs.status,
        error: runs.error,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .where(inArray(runs.testVersionId, versionIds))
      .orderBy(desc(runs.createdAt));

    // Latest run per version — the ordering above means the first one wins.
    const latest = new Map<string, (typeof runRows)[number]>();
    for (const r of runRows) if (!latest.has(r.versionId)) latest.set(r.versionId, r);
    if (latest.size === 0) return byVersion;

    const checkpoints = new Map<string, { reviewState: ReviewState; resolution: Resolution | null }[]>();
    const resultRows = await this.db
      .select({
        runId: runResults.runId,
        reviewState: runResults.reviewState,
        resolution: runResults.resolution,
      })
      .from(runResults)
      .where(inArray(runResults.runId, [...latest.values()].map((r) => r.runId)));
    for (const rr of resultRows) {
      const list = checkpoints.get(rr.runId) ?? [];
      list.push({
        reviewState: rr.reviewState as ReviewState,
        resolution: rr.resolution as Resolution | null,
      });
      checkpoints.set(rr.runId, list);
    }

    for (const [versionId, run] of latest) {
      byVersion.set(versionId, {
        runId: run.runId,
        // These versions are all `unreviewed` repairs by definition of the query above, so the
        // repair flag is unconditionally true here.
        outcome: deriveRunOutcome(checkpoints.get(run.runId) ?? [], {
          status: run.status,
          error: run.error,
          repairApplied: true,
        }),
      });
    }
    return byVersion;
  }

  /**
   * Accept a repaired version: it is reviewed, by a named human, at a recorded instant.
   *
   * Nothing is written to the definition — an accept is a decision, not an edit. The repaired
   * version is already the test's latest, so the active definition IS the repaired one the moment
   * it was written; what was missing was a human's name against it.
   */
  async accept(versionId: string, reviewer: string): Promise<RepairReviewDecision> {
    const version = await this.unreviewed(versionId);
    // A CLUSTERED repair is one app change, so it is one decision (Slice 19, slice 07): accepting
    // it accepts every test the job repaired. Accepting them one at a time would let a reviewer
    // leave half a cluster agreeing with the new button name and half with the old.
    const siblings = await this.clusterVersions(version);
    await this.db
      .update(testVersions)
      .set({ reviewState: "reviewed", reviewedBy: reviewer, reviewedAt: this.clock.now() })
      .where(
        inArray(
          testVersions.id,
          siblings.map((v) => v.id),
        ),
      );
    const extra = siblings.length - 1;
    this.log.log(
      `accepted repaired v${version.version} of test ${version.testId}${extra > 0 ? ` and ${extra} clustered sibling(s)` : ""} (${reviewer})`,
    );
    return {
      ok: true,
      versionId,
      reviewState: "reviewed",
      revertedToVersion: null,
      note:
        extra > 0
          ? `Accepted across the whole Failure Cluster — ${siblings.length} tests, one app change. Each is now its test's active definition.`
          : `v${version.version} is accepted and is the test's active definition.`,
    };
  }

  /**
   * Reject a repaired version: the test goes back to what it said before, and the job that
   * produced the repair is finished — unsuccessfully, and terminally, so no drainer picks it up
   * again on the strength of a fix a human already refused.
   *
   * The revert is an APPEND, not a delete: the previous definition is written as a new version.
   * That keeps the audit trail (the rejected attempt is still there, marked `rejected`) and keeps
   * every run that already executed against the rejected version pointing at a row that exists.
   */
  async reject(versionId: string, reviewer: string): Promise<RepairReviewDecision> {
    const version = await this.unreviewed(versionId);
    // Same reasoning as accept, and more load-bearing: rejecting a clustered repair has to revert
    // EVERY test in the cluster (Slice 19, slice 07). Reverting only the one a reviewer happened to
    // click would leave the other thirty-seven quietly repaired by a fix a human just refused.
    const siblings = await this.clusterVersions(version);
    // Group by test — each one is its own append-the-previous-definition revert.
    const byTest = new Map<string, typeof siblings>();
    for (const v of siblings) byTest.set(v.testId, [...(byTest.get(v.testId) ?? []), v]);

    let anchor: { previousVersion: number; revertedToVersion: number } | null = null;
    // Terminal, and terminally UNSUCCESSFUL: `failed` is how the queue already says "every
    // attempt was spent and the test is still yours to fix", which is exactly true here. It moves
    // once, however many tests the cluster covers.
    let jobUpdate = version.repairJobId
      ? { id: version.repairJobId, set: { status: "failed" } as Record<string, unknown> }
      : null;
    for (const [testId, versions] of byTest) {
      const result = await this.revertRepair({
        testId,
        versionIds: versions.map((v) => v.id),
        revertBefore: Math.min(...versions.map((v) => v.version)),
        actor: reviewer,
        because: `rejected repair v${version.version}`,
        jobUpdate,
      });
      jobUpdate = null;
      if (testId === version.testId) anchor = result;
    }
    if (!anchor) throw new NotFoundException(`Version ${versionId} could not be reverted`);
    const extra = byTest.size - 1;
    this.log.log(
      `rejected repaired v${version.version} of test ${version.testId}${extra > 0 ? ` and ${extra} clustered sibling test(s)` : ""}: reverted to v${anchor.previousVersion}'s definition as v${anchor.revertedToVersion} (${reviewer})`,
    );
    return {
      ok: true,
      versionId,
      reviewState: "rejected",
      revertedToVersion: anchor.revertedToVersion,
      note:
        extra > 0
          ? `The repair was rejected across the whole Failure Cluster — all ${byTest.size} tests are back on what they said before, each written as a new version. The rejected versions are retained in their histories.`
          : `The repair was rejected. The test is back on what v${anchor.previousVersion} said, written as v${anchor.revertedToVersion}; the rejected version is retained in the history.`,
    };
  }

  /**
   * Every still-unreviewed version this repair covers: the one being decided, plus its clustered
   * siblings when a job wrote across a whole Failure Cluster (Slice 19, slice 07).
   *
   * A version with no job behind it is a cluster of one — the same shape, so accept and reject need
   * no "is this clustered?" branch.
   */
  private async clusterVersions(version: {
    id: string;
    testId: string;
    version: number;
    repairJobId: string | null;
  }): Promise<Array<{ id: string; testId: string; version: number }>> {
    if (!version.repairJobId) {
      return [{ id: version.id, testId: version.testId, version: version.version }];
    }
    const rows = await this.db
      .select({ id: testVersions.id, testId: testVersions.testId, version: testVersions.version })
      .from(testVersions)
      .where(
        and(
          eq(testVersions.repairJobId, version.repairJobId),
          eq(testVersions.reviewState, "unreviewed"),
        ),
      )
      .orderBy(desc(testVersions.version));
    return rows.length ? rows : [{ id: version.id, testId: version.testId, version: version.version }];
  }

  /**
   * Undo a repair: put the test back on the definition it had before, mark the repaired
   * version(s) `rejected`, and (optionally) move the job that produced them.
   *
   * Shared by the two things that undo a repair — a human pressing Reject, and the
   * justification gate refusing one (Slice 19, slice 05) — because they must undo it the SAME
   * way. A gate that abandoned a repair differently from a reject would be a second, untested
   * revert path guarding the more dangerous case.
   *
   * The revert is an APPEND, not a delete: the previous definition is written as a new version.
   * That keeps the audit trail (the rejected attempt is still there, marked `rejected`) and keeps
   * every run that already executed against the rejected version pointing at a row that exists.
   *
   * `revertBefore` is the LOWEST repaired version number — an agent that wrote two versions under
   * one claim must have both undone, or "the test is unchanged" would be a lie.
   */
  async revertRepair(opts: {
    testId: string;
    versionIds: string[];
    revertBefore: number;
    actor: string;
    because: string;
    jobUpdate: { id: string; set: Record<string, unknown> } | null;
  }): Promise<{ previousVersion: number; revertedToVersion: number }> {
    const [previous] = await this.db
      .select({ version: testVersions.version, definition: testVersions.definition })
      .from(testVersions)
      .where(and(eq(testVersions.testId, opts.testId), lt(testVersions.version, opts.revertBefore)))
      .orderBy(desc(testVersions.version))
      .limit(1);
    if (!previous) {
      // A first version has nothing behind it to restore. Refused rather than half-done: an agent
      // cannot produce this (a repair is always an edit to something that ran), so it means the
      // history was truncated, and inventing a definition to revert to would be worse.
      throw new ConflictException(
        `v${opts.revertBefore} is the test's first version — there is no previous definition to revert to.`,
      );
    }

    const [latest] = await this.db
      .select({ version: testVersions.version, definition: testVersions.definition })
      .from(testVersions)
      .where(eq(testVersions.testId, opts.testId))
      .orderBy(desc(testVersions.version))
      .limit(1);
    const nextVersion = (latest?.version ?? opts.revertBefore) + 1;

    // A rejected repair may have renamed a checkpoint, and a checkpoint's name IS its baseline
    // key — so reverting the definition without moving the golden back would leave it orphaned
    // and send the next run to `pending-baseline`. Paired positionally, and only when the two
    // definitions hold the same checkpoints, which is the shape every locator repair has.
    const renames = checkpointRenames(
      latest?.definition as TestDefinition | undefined,
      previous.definition as TestDefinition,
    );

    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      await tx.insert(testVersions).values({
        testId: opts.testId,
        version: nextVersion,
        definition: previous.definition,
        createdBy: `${opts.actor} (${opts.because})`,
      });
      await tx
        .update(testVersions)
        .set({ reviewState: "rejected", reviewedBy: opts.actor, reviewedAt: now })
        .where(inArray(testVersions.id, opts.versionIds));
      for (const { from, to } of renames) {
        await tx
          .delete(baselines)
          .where(and(eq(baselines.testId, opts.testId), eq(baselines.checkpointName, to)));
        await tx
          .update(baselines)
          .set({ checkpointName: to, updatedAt: now })
          .where(and(eq(baselines.testId, opts.testId), eq(baselines.checkpointName, from)));
      }
      if (opts.jobUpdate) {
        await tx
          .update(repairJobs)
          .set({ ...opts.jobUpdate.set, updatedAt: now })
          .where(eq(repairJobs.id, opts.jobUpdate.id));
      }
    });
    return { previousVersion: previous.version, revertedToVersion: nextVersion };
  }

  /** The version, if it is actually awaiting a decision. A version already accepted or rejected
   *  is a CONFLICT rather than a silent no-op, so two reviewers racing on the same row learn that
   *  one of them lost instead of both being told "done". */
  private async unreviewed(versionId: string) {
    const [row] = await this.db
      .select({
        id: testVersions.id,
        testId: testVersions.testId,
        version: testVersions.version,
        reviewState: testVersions.reviewState,
        repairJobId: testVersions.repairJobId,
      })
      .from(testVersions)
      .where(eq(testVersions.id, versionId))
      .limit(1);
    if (!row) throw new NotFoundException(`Version ${versionId} not found`);
    if (row.reviewState !== "unreviewed") {
      throw new ConflictException(
        `v${row.version} has already been ${row.reviewState === "rejected" ? "rejected" : "reviewed"}.`,
      );
    }
    return row;
  }
}

/**
 * Checkpoint renames to undo when reverting `from` back to `to`, paired by position among the
 * screenshot steps. Empty when the two definitions disagree about how many checkpoints there are
 * — a repair that added or removed one cannot be paired up positionally, and guessing which
 * golden belongs to which name is worse than leaving the baselines where they are (the next run
 * then reports `pending-baseline`, which is visible, rather than comparing against the wrong
 * golden, which is not).
 */
function checkpointRenames(
  from: TestDefinition | undefined,
  to: TestDefinition,
): Array<{ from: string; to: string }> {
  const names = (def: TestDefinition | undefined): string[] =>
    (def?.steps ?? [])
      .filter((s: Step): s is Extract<Step, { type: "screenshot" }> => s.type === "screenshot")
      .map((s) => s.name);
  const before = names(from);
  const after = names(to);
  if (before.length !== after.length) return [];
  return before
    .map((name, i) => ({ from: name, to: after[i] }))
    .filter((r) => r.from !== r.to);
}
