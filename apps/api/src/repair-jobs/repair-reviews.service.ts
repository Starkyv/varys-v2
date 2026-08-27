import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Logger } from "@nestjs/common";
import type { RepairReviewDecision, RepairReviewItem } from "@varys/review-contract";
import type { Step, TestDefinition } from "@varys/step-schema";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { baselines, repairJobs, tests, testVersions } from "../db/schema";
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
        // The test's highest version number, so the caller can tell an unreviewed version that
        // IS the active definition from one a later edit has already landed on top of.
        latestVersion: sql<number>`(select max(version) from test_versions v where v.test_id = ${testVersions.testId})`,
        previousVersion: sql<
          number | null
        >`(select max(version) from test_versions v where v.test_id = ${testVersions.testId} and v.version < ${testVersions.version})`,
        runId: repairJobs.runId,
        report: repairJobs.report,
      })
      .from(testVersions)
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .leftJoin(repairJobs, eq(repairJobs.id, testVersions.repairJobId))
      .where(eq(testVersions.reviewState, "unreviewed"))
      .orderBy(desc(testVersions.createdAt));

    return rows.map((r) => ({
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
      isActiveDefinition: Number(r.latestVersion) === r.version,
    }));
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
    await this.db
      .update(testVersions)
      .set({ reviewState: "reviewed", reviewedBy: reviewer, reviewedAt: this.clock.now() })
      .where(eq(testVersions.id, versionId));
    this.log.log(`accepted repaired v${version.version} of test ${version.testId} (${reviewer})`);
    return {
      ok: true,
      versionId,
      reviewState: "reviewed",
      revertedToVersion: null,
      note: `v${version.version} is accepted and is the test's active definition.`,
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

    const [previous] = await this.db
      .select({ version: testVersions.version, definition: testVersions.definition })
      .from(testVersions)
      .where(and(eq(testVersions.testId, version.testId), lt(testVersions.version, version.version)))
      .orderBy(desc(testVersions.version))
      .limit(1);
    if (!previous) {
      // A first version has nothing behind it to restore. Refused rather than half-done: an agent
      // cannot produce this (a repair is always an edit to something that ran), so it means the
      // history was truncated, and inventing a definition to revert to would be worse.
      throw new ConflictException(
        `v${version.version} is the test's first version — there is no previous definition to revert to.`,
      );
    }

    const [latest] = await this.db
      .select({ version: testVersions.version, definition: testVersions.definition })
      .from(testVersions)
      .where(eq(testVersions.testId, version.testId))
      .orderBy(desc(testVersions.version))
      .limit(1);
    const nextVersion = (latest?.version ?? version.version) + 1;

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
        testId: version.testId,
        version: nextVersion,
        definition: previous.definition,
        createdBy: `${reviewer} (rejected repair v${version.version})`,
      });
      await tx
        .update(testVersions)
        .set({ reviewState: "rejected", reviewedBy: reviewer, reviewedAt: now })
        .where(eq(testVersions.id, versionId));
      for (const { from, to } of renames) {
        await tx
          .delete(baselines)
          .where(and(eq(baselines.testId, version.testId), eq(baselines.checkpointName, to)));
        await tx
          .update(baselines)
          .set({ checkpointName: to, updatedAt: now })
          .where(and(eq(baselines.testId, version.testId), eq(baselines.checkpointName, from)));
      }
      if (version.repairJobId) {
        // Terminal, and terminally UNSUCCESSFUL: `failed` is how the queue already says "every
        // attempt was spent and the test is still yours to fix", which is exactly true here.
        await tx
          .update(repairJobs)
          .set({ status: "failed", updatedAt: now })
          .where(eq(repairJobs.id, version.repairJobId));
      }
    });
    this.log.log(
      `rejected repaired v${version.version} of test ${version.testId}: reverted to v${previous.version}'s definition as v${nextVersion} (${reviewer})`,
    );
    return {
      ok: true,
      versionId,
      reviewState: "rejected",
      revertedToVersion: nextVersion,
      note: `The repair was rejected. The test is back on what v${previous.version} said, written as v${nextVersion}; the rejected version is retained in the history.`,
    };
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
