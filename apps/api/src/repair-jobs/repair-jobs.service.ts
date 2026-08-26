import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { deriveClusterKey } from "@varys/repair-policy";
import type {
  RepairJobKind,
  RepairJobStatus,
  RepairJobSummary,
} from "@varys/review-contract";
import type { TestDefinition } from "@varys/step-schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { repairJobs, runs, tests, testVersions } from "../db/schema";

/** Statuses the queue view shows by default — the work that is still outstanding. */
const OPEN_STATUSES = ["queued", "claimed"] as const;

/**
 * The repair queue's read + human-control surface (Slice 19, slice 01).
 *
 * Enqueueing normally happens in the WORKER, at the point a run's unresolvable locator is
 * already detected (`enqueueRepairIfAuto` in `@varys/runner`) — there is no scanner here that
 * could disagree with a run about whether it failed. What lives in the API is what a person
 * does with the queue: read it, enqueue a job by hand for a test whose policy is `manual`, and
 * cancel one they have decided to fix themselves.
 *
 * Claiming under a lease is slice 03; nothing here writes `claimed_by`.
 */
@Injectable()
export class RepairJobsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The queue, newest first. Defaults to the OPEN jobs (`queued` + `claimed`) because those are
   * the ones a human can act on; `all` includes finished and cancelled ones for an audit read.
   *
   * `queued` is deliberately a distinct status from `claimed` rather than one "pending": a
   * project with no drainer accumulates unclaimed jobs (ADR-0003 accepts that), and the whole
   * point of this view is that the accumulation reads as "nobody has picked this up" instead of
   * "this is taking a while".
   */
  async list(opts?: { all?: boolean }): Promise<RepairJobSummary[]> {
    const rows = await this.db
      .select({
        id: repairJobs.id,
        testId: repairJobs.testId,
        testName: tests.name,
        runId: repairJobs.runId,
        kind: repairJobs.kind,
        status: repairJobs.status,
        clusterKey: repairJobs.clusterKey,
        attempts: repairJobs.attempts,
        claimedBy: repairJobs.claimedBy,
        claimedAt: repairJobs.claimedAt,
        createdAt: repairJobs.createdAt,
      })
      .from(repairJobs)
      .innerJoin(tests, eq(tests.id, repairJobs.testId))
      .where(opts?.all ? undefined : inArray(repairJobs.status, [...OPEN_STATUSES]))
      .orderBy(desc(repairJobs.createdAt));

    return rows.map((r) => ({
      id: r.id,
      testId: r.testId,
      testName: r.testName,
      runId: r.runId,
      kind: r.kind as RepairJobKind,
      status: r.status as RepairJobStatus,
      clusterKey: r.clusterKey,
      attempts: r.attempts,
      claimedBy: r.claimedBy,
      claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Enqueue a Repair Job by hand from a failed run — the escape hatch that lets a drainer fix a
   * test whose policy is `manual`, without opting that test into unattended editing forever.
   *
   * Gated on the run having failed on a LOCATOR: the cluster key is derived from the fingerprint
   * that missed, and more importantly a pixel regression or a crash must not become repairable
   * just because a human asked loudly. Those get a Triage Job instead (slice 08).
   *
   * Idempotent: asking twice hands back the job that is already OPEN for this test and cluster
   * rather than stacking a second one — including when a drainer has already claimed it, which
   * the partial unique index alone would not catch.
   */
  async enqueueForRun(runId: string): Promise<RepairJobSummary> {
    const [run] = await this.db
      .select({
        status: runs.status,
        failureKind: runs.failureKind,
        failedStepIndex: runs.failedStepIndex,
        testId: testVersions.testId,
        definition: testVersions.definition,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) throw new NotFoundException(`Run ${runId} not found`);
    if (run.status !== "failed" || run.failureKind !== "locator") {
      throw new BadRequestException(
        "only a run that failed on an unresolvable locator can be repaired",
      );
    }

    const step = (run.definition as TestDefinition).steps[run.failedStepIndex ?? -1];
    const target = step && "target" in step ? step.target : undefined;
    if (!target) {
      throw new BadRequestException("the failing step has no recorded locator to repair");
    }
    const clusterKey = deriveClusterKey(target);

    const openJob = () =>
      this.db
        .select({ id: repairJobs.id })
        .from(repairJobs)
        .where(
          and(
            eq(repairJobs.testId, run.testId),
            eq(repairJobs.clusterKey, clusterKey),
            inArray(repairJobs.status, [...OPEN_STATUSES]),
          ),
        )
        .limit(1);

    const [existing] = await openJob();
    let id = existing?.id;
    if (!id) {
      const [inserted] = await this.db
        .insert(repairJobs)
        .values({ testId: run.testId, runId, kind: "repair", status: "queued", clusterKey })
        .onConflictDoNothing()
        .returning({ id: repairJobs.id });
      // Lost the insert race against the worker (or another request): the partial unique index
      // refused the duplicate, so read back whichever job won.
      id = inserted?.id ?? (await openJob())[0]?.id;
    }
    if (!id) throw new ConflictException("the repair job could not be enqueued");

    const [job] = (await this.list({ all: true })).filter((j) => j.id === id);
    return job;
  }

  /**
   * Is any repair job covering `testId` currently CLAIMED by this principal? The scope half of
   * ADR-0005: a Repair Agent credential reaches "the repair toolset **and** the tests covered by
   * a job it has claimed", so every test-addressing tool asks this before touching anything.
   *
   * Nothing writes `claimed_by` yet — claiming under a lease is slice 03 — so today this answers
   * `false` for every test, which is exactly the refusal slice 02 is specced to produce. When
   * slice 03 lands, the same call starts returning true for the claimed test with no change here.
   */
  async hasClaimOn(principalId: string, testId: string): Promise<boolean> {
    if (!principalId || !testId) return false;
    const [row] = await this.db
      .select({ id: repairJobs.id })
      .from(repairJobs)
      .where(
        and(
          eq(repairJobs.testId, testId),
          eq(repairJobs.status, "claimed"),
          eq(repairJobs.claimedBy, principalId),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** The test a run exercised, or null — so a tool given a `runId` can be scope-checked against
   *  the test behind it rather than waving the run through. */
  async testIdForRun(runId: string): Promise<string | null> {
    if (!runId) return null;
    const [row] = await this.db
      .select({ testId: testVersions.testId })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .where(eq(runs.id, runId))
      .limit(1);
    return row?.testId ?? null;
  }

  /**
   * Cancel a queued job — "I'll do this one by hand." Only an UNCLAIMED job can be cancelled:
   * a claimed one belongs to a drainer that is mid-repair, and yanking it out from under a live
   * session is slice 03's release/lease-expiry path, not a cancel.
   */
  async cancel(id: string): Promise<{ ok: true }> {
    const cancelled = await this.db
      .update(repairJobs)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(repairJobs.id, id), eq(repairJobs.status, "queued")))
      .returning({ id: repairJobs.id });
    if (cancelled.length > 0) return { ok: true };

    const [existing] = await this.db
      .select({ status: repairJobs.status })
      .from(repairJobs)
      .where(eq(repairJobs.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException(`Repair job ${id} not found`);
    throw new ConflictException(`a ${existing.status} job cannot be cancelled`);
  }
}
