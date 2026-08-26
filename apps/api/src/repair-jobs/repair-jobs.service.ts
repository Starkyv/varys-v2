import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { deriveClusterKey } from "@varys/repair-policy";
import type {
  ClaimedRepairJob,
  RepairJobKind,
  RepairJobStatus,
  RepairJobSummary,
} from "@varys/review-contract";
import { describeStep, type TestDefinition } from "@varys/step-schema";
import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { repairJobs, runs, tests, testVersions } from "../db/schema";
import { CLOCK, type Clock } from "./clock";

/** Statuses the queue view shows by default — the work that is still outstanding. */
const OPEN_STATUSES = ["queued", "claimed"] as const;

/**
 * How long a Claim holds before it lapses. Long enough for a real repair (open a session, drive
 * the prefix, iterate on candidates, write a version) and short enough that a drainer killed
 * mid-repair does not park the job for a whole night.
 */
const CLAIM_MS = 15 * 60_000;

/**
 * How many failed attempts a job gets before it is abandoned. Without a cap, one break nothing
 * can fix is claimed, lapsed and re-claimed forever, and every drainer that takes it spends a
 * Claude session on it — the queue quietly becomes a treadmill instead of a backlog.
 */
const ATTEMPT_CAP = 3;

/**
 * The repair queue's read + human-control surface (Slice 19, slice 01).
 *
 * Enqueueing normally happens in the WORKER, at the point a run's unresolvable locator is
 * already detected (`enqueueRepairIfAuto` in `@varys/runner`) — there is no scanner here that
 * could disagree with a run about whether it failed. What lives in the API is what a person
 * does with the queue: read it, enqueue a job by hand for a test whose policy is `manual`, and
 * cancel one they have decided to fix themselves.
 *
 * Slice 03 adds the drainer's half — {@link claimNext} and {@link release}, reached over `/mcp`
 * by an agent principal. A Claim is a LEASE: it is taken with a single conditional UPDATE (so two
 * drainers cannot both win one job), it hides the job from every other claimer while it holds,
 * and it lapses if the claimer stops reporting, returning the job to the queue with its attempt
 * count incremented until the cap abandons it.
 */
@Injectable()
export class RepairJobsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

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
    // Sweep lapsed claims before reading, so the view never shows a dead drainer's job as
    // "in progress" — the distinction this view exists for is only true if it is current.
    await this.sweepLapsedClaims();
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
        claimExpiresAt: repairJobs.claimExpiresAt,
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
      claimExpiresAt: r.claimExpiresAt ? r.claimExpiresAt.toISOString() : null,
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
   * A LAPSED claim is not a claim: the expiry is checked in the predicate rather than trusted to
   * have been swept already, so the moment a lease runs out the credential's reach shrinks back —
   * even between sweeps, and even if the drainer never notices its claim ended.
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
          gt(repairJobs.claimExpiresAt, this.clock.now()),
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
   * Take exclusive ownership of the oldest claimable job — the drainer's entry point (ADR-0003:
   * Varys queues, something external claims). Returns null when there is nothing to do, which is
   * the ordinary answer for a healthy corpus and must not read as an error.
   *
   * The queue is project-wide and first-claim-wins, so this walks the candidates oldest-first and
   * takes each with ONE conditional UPDATE (`status = 'queued'` in the WHERE) — the same
   * optimistic-claim pattern `SchedulerService` uses to make overlapping ticks safe. A drainer
   * that loses the race on a job simply continues to the next one, which is why this is a loop
   * and not a single statement: two drainers arriving together end up with two different jobs,
   * not one job and one empty-handed caller.
   *
   * Jobs at the attempt cap are excluded by the same predicate, so an abandoned job is invisible
   * here rather than claimable-but-refused.
   */
  async claimNext(claimant: string): Promise<ClaimedRepairJob | null> {
    if (!claimant) throw new BadRequestException("a claim needs a claimant");
    const now = await this.sweepLapsedClaims();

    const candidates = await this.db
      .select({ id: repairJobs.id })
      .from(repairJobs)
      .where(and(eq(repairJobs.status, "queued"), lt(repairJobs.attempts, ATTEMPT_CAP)))
      .orderBy(asc(repairJobs.createdAt))
      .limit(50);

    for (const candidate of candidates) {
      const [claimed] = await this.db
        .update(repairJobs)
        .set({
          status: "claimed",
          claimedBy: claimant,
          claimedAt: now,
          claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
          updatedAt: now,
        })
        // The whole exclusivity guarantee: only a still-queued row is claimable, so the loser of
        // a race matches 0 rows and moves on.
        .where(and(eq(repairJobs.id, candidate.id), eq(repairJobs.status, "queued")))
        .returning({ id: repairJobs.id });
      if (!claimed) continue;
      return this.claimedPayload(claimed.id);
    }
    return null;
  }

  /**
   * Give a claimed job back — "I can't do this one." It returns to the queue IMMEDIATELY rather
   * than waiting out the lease, so a drainer that bails does not park the work for fifteen
   * minutes.
   *
   * It counts as an attempt, exactly as a lapsed lease does: a drainer looping claim → release on
   * a break it cannot fix would otherwise burn a session per pass forever, which is the treadmill
   * the cap exists to stop.
   *
   * Only the holder may release: releasing someone else's claim is not-found, not a conflict, for
   * the same reason another user's session id is — a claimant learns nothing about jobs it does
   * not hold.
   */
  async release(claimant: string, jobId: string): Promise<{ ok: true; status: RepairJobStatus }> {
    const [released] = await this.db
      .update(repairJobs)
      .set(this.giveBack(this.clock.now()))
      .where(
        and(
          eq(repairJobs.id, jobId),
          eq(repairJobs.status, "claimed"),
          eq(repairJobs.claimedBy, claimant),
        ),
      )
      .returning({ status: repairJobs.status });
    if (!released) throw new NotFoundException(`No repair job ${jobId} is claimed by ${claimant}`);
    return { ok: true, status: released.status as RepairJobStatus };
  }

  /**
   * Return every lapsed claim to the queue, and hand back the `now` the sweep ran at so a caller
   * that is about to claim uses the same instant.
   *
   * This is the "a dead claimer cannot strand work" half of the lease. It runs lazily — on the
   * two paths that care, reading the queue and claiming from it — rather than on a background
   * tick, so there is no sweeper to be down and no window in which the queue and the view
   * disagree about what is in progress.
   */
  private async sweepLapsedClaims(): Promise<Date> {
    const now = this.clock.now();
    await this.db
      .update(repairJobs)
      .set(this.giveBack(now))
      .where(and(eq(repairJobs.status, "claimed"), lte(repairJobs.claimExpiresAt, now)));
    return now;
  }

  /**
   * The columns that end a claim: one more attempt spent, the claim record cleared, and the job
   * back in the queue — unless that attempt was its last, in which case it is abandoned to the
   * terminal `failed` state and no drainer will see it again. Expressed as SQL rather than read
   * → decide → write so a sweep over many rows stays one statement and cannot race itself.
   */
  private giveBack(now: Date) {
    return {
      status: sql<string>`case when ${repairJobs.attempts} + 1 >= ${ATTEMPT_CAP} then 'failed' else 'queued' end`,
      attempts: sql<number>`${repairJobs.attempts} + 1`,
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
      updatedAt: now,
    };
  }

  /** Everything a drainer needs to start work on the job it just claimed, in one read: the test,
   *  the Brief the repair will have to be justified against (slice 05), and the step that broke. */
  private async claimedPayload(jobId: string): Promise<ClaimedRepairJob> {
    const [job] = await this.db
      .select({
        id: repairJobs.id,
        kind: repairJobs.kind,
        testId: repairJobs.testId,
        testName: tests.name,
        brief: tests.intent,
        runId: repairJobs.runId,
        clusterKey: repairJobs.clusterKey,
        attempts: repairJobs.attempts,
        claimedAt: repairJobs.claimedAt,
        claimExpiresAt: repairJobs.claimExpiresAt,
      })
      .from(repairJobs)
      .innerJoin(tests, eq(tests.id, repairJobs.testId))
      .where(eq(repairJobs.id, jobId))
      .limit(1);
    if (!job) throw new NotFoundException(`Repair job ${jobId} not found`);

    let failingStep: ClaimedRepairJob["failingStep"] = null;
    if (job.runId) {
      const [run] = await this.db
        .select({
          error: runs.error,
          failedStepIndex: runs.failedStepIndex,
          definition: testVersions.definition,
        })
        .from(runs)
        .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
        .where(eq(runs.id, job.runId))
        .limit(1);
      const index = run?.failedStepIndex ?? null;
      // The step is read off the version that ACTUALLY ran, not the test's latest: the drainer is
      // being told what broke, and a later edit must not rewrite that account.
      const step = index === null ? undefined : (run?.definition as TestDefinition).steps[index];
      if (index !== null && step) {
        failingStep = { index, label: describeStep(step), error: run?.error ?? null };
      }
    }

    return {
      jobId: job.id,
      kind: job.kind as RepairJobKind,
      testId: job.testId,
      testName: job.testName,
      runId: job.runId,
      brief: job.brief,
      clusterKey: job.clusterKey,
      failingStep,
      attempts: job.attempts,
      attemptsRemaining: Math.max(0, ATTEMPT_CAP - job.attempts),
      claimedAt: (job.claimedAt ?? new Date()).toISOString(),
      claimExpiresAt: (job.claimExpiresAt ?? new Date()).toISOString(),
    };
  }

  /**
   * Cancel a queued job — "I'll do this one by hand." Only an UNCLAIMED job can be cancelled:
   * a claimed one belongs to a drainer that is mid-repair, and yanking it out from under a live
   * session is the release / lapsed-lease path, not a cancel. A job whose claim has LAPSED is
   * cancellable again, which is why the sweep runs first.
   */
  async cancel(id: string): Promise<{ ok: true }> {
    const now = await this.sweepLapsedClaims();
    const cancelled = await this.db
      .update(repairJobs)
      .set({ status: "cancelled", updatedAt: now })
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
