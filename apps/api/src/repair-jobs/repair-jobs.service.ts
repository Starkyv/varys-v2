import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { judgeRepairJustification, type JudgeProvider, type JudgeResult } from "@varys/judge-engine";
import {
  breakerVerdict,
  clusterFailures,
  DEFAULT_BREAKER_THRESHOLD,
  deriveClusterKey,
} from "@varys/repair-policy";
import {
  BREAKER_THRESHOLD_KEY,
  BREAKER_WINDOW_MS,
  breakerThreshold,
  joinCluster,
  recentLocatorFailures,
} from "@varys/runner";
import type {
  ClaimedRepairJob,
  RepairBreakerOverride,
  RepairBreakerView,
  RepairJobKind,
  RepairJobStatus,
  RepairJobSummary,
  ReportedRepair,
  ReportedTriage,
  SuppressedFailureItem,
} from "@varys/review-contract";
import { describeStep, type Fingerprint, type TestDefinition } from "@varys/step-schema";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { appSettings, repairJobs, repairJobTests, runs, suppressedFailures, tests, testVersions } from "../db/schema";
import { RunsService } from "../runs/runs.service";
import { TestsService } from "../tests/tests.service";
import { CLOCK, type Clock } from "./clock";
import { JUDGE_SOURCE, type JudgeSource } from "./judge";
import { describeRepairChange } from "./repair-diff";
import { RepairReviewsService } from "./repair-reviews.service";

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
  private readonly log = new Logger(RepairJobsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(JUDGE_SOURCE) private readonly judgeSource: JudgeSource,
    // The gate abandons a refused repair through the SAME revert a human Reject uses — one
    // implementation, so the more dangerous path is not a second, untested one.
    @Inject(RepairReviewsService) private readonly reviews: RepairReviewsService,
    // The re-run a stood-up repair triggers (slice 06) goes through the ordinary single-run path.
    @Inject(RunsService) private readonly runs: RunsService,
    // The cluster fan-out (slice 07) writes its versions through the SAME `saveConfig` a drainer's
    // own `apply_fix` uses — version numbering, attribution and the unreviewed flag all in one place.
    @Inject(TestsService) private readonly tests: TestsService,
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

    // The Failure Cluster each job covers (slice 07). A job is one app change, not one test, so
    // the queue has to say how many tests it will fix — otherwise "1 job" reads as "1 test" and a
    // thirty-eight-test repair looks like a trivial one.
    const members = await this.clusterMembers(rows.map((r) => r.id));

    return rows.map((r) => ({
      id: r.id,
      testId: r.testId,
      testName: r.testName,
      runId: r.runId,
      kind: r.kind as RepairJobKind,
      status: r.status as RepairJobStatus,
      clusterKey: r.clusterKey,
      clusterSize: members.get(r.id)?.length ?? 1,
      clusterTestNames: (members.get(r.id) ?? []).map((m) => m.testName),
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
   * Idempotent: asking twice hands back the job that is already OPEN for this cluster rather than
   * stacking a second one — including when a drainer has already claimed it, which the partial
   * unique index alone would not catch.
   *
   * **The circuit breaker does not gate this path, deliberately** (slice 07). The breaker exists to
   * stop a bad deploy rewriting the corpus *unattended*; a person opening one failed run and asking
   * for it to be repaired IS the human decision the breaker is holding out for, at the finest grain
   * there is. Gating it would leave a tripped breaker with no way to repair a single known-good case
   * short of releasing everything.
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

    // Project-wide, not per test (slice 07): if this locator is already open as a job, this run's
    // test JOINS that Failure Cluster rather than opening a rival job for the same app change.
    const openJob = () =>
      this.db
        .select({ id: repairJobs.id })
        .from(repairJobs)
        .where(
          and(
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
    await joinCluster(this.db, id, { testId: run.testId, runId });

    const [job] = (await this.list({ all: true })).filter((j) => j.id === id);
    return job;
  }

  /**
   * The tests each job's Failure Cluster covers, keyed by job id (Slice 19, slice 07).
   *
   * Read from `repair_job_tests`, which the DDL backfills for every pre-clustering job, so there
   * is no "clustered or not?" branch anywhere: a single-test break is simply a cluster of one.
   */
  private async clusterMembers(
    jobIds: string[],
  ): Promise<Map<string, Array<{ testId: string; testName: string; runId: string | null }>>> {
    const byJob = new Map<string, Array<{ testId: string; testName: string; runId: string | null }>>();
    if (jobIds.length === 0) return byJob;
    const rows = await this.db
      .select({
        jobId: repairJobTests.jobId,
        testId: repairJobTests.testId,
        testName: tests.name,
        runId: repairJobTests.runId,
      })
      .from(repairJobTests)
      .innerJoin(tests, eq(tests.id, repairJobTests.testId))
      .where(inArray(repairJobTests.jobId, jobIds))
      .orderBy(asc(repairJobTests.createdAt));
    for (const r of rows) {
      const list = byJob.get(r.jobId) ?? [];
      list.push({ testId: r.testId, testName: r.testName, runId: r.runId });
      byJob.set(r.jobId, list);
    }
    return byJob;
  }

  /**
   * The circuit breaker's current state (Slice 19, slice 07) — what the queue view reads so a
   * project whose jobs have stopped appearing can see why.
   *
   * Recomputed on read from the same census the enqueue path uses, rather than stored: a stored
   * "tripped" flag would need clearing, and something has to decide when — which is exactly the
   * judgement the window already makes. Reading it live means the breaker un-trips by itself an
   * hour after the mass failure stops, and the answer is never stale.
   */
  async breaker(): Promise<RepairBreakerView> {
    const threshold = await breakerThreshold(this.db);
    const verdict = breakerVerdict(await recentLocatorFailures(this.db, this.clock.now()), threshold);
    const rows = await this.db
      .select({
        id: suppressedFailures.id,
        testId: suppressedFailures.testId,
        testName: tests.name,
        runId: suppressedFailures.runId,
        clusterKey: suppressedFailures.clusterKey,
        threshold: suppressedFailures.threshold,
        failingTests: suppressedFailures.failingTests,
        createdAt: suppressedFailures.createdAt,
      })
      .from(suppressedFailures)
      .innerJoin(tests, eq(tests.id, suppressedFailures.testId))
      .where(isNull(suppressedFailures.releasedAt))
      .orderBy(desc(suppressedFailures.createdAt));

    return {
      tripped: verdict.tripped,
      threshold: verdict.threshold,
      defaultThreshold: DEFAULT_BREAKER_THRESHOLD,
      windowMinutes: Math.round(BREAKER_WINDOW_MS / 60_000),
      failingTests: verdict.failingTests,
      clusters: verdict.clusters,
      suppressed: rows.map(
        (r): SuppressedFailureItem => ({
          id: r.id,
          testId: r.testId,
          testName: r.testName,
          runId: r.runId,
          clusterKey: r.clusterKey,
          threshold: r.threshold,
          failingTests: r.failingTests,
          createdAt: r.createdAt.toISOString(),
        }),
      ),
    };
  }

  /**
   * The deliberate human override (Slice 19, slice 07): release everything the breaker suppressed
   * into the queue, clustered.
   *
   * This is the whole reason suppressed failures are RECORDED rather than dropped. A genuine mass
   * redesign is something you do want repaired in bulk — once a person has looked at it and said
   * so. Nothing has to be re-run to recover the work: each suppressed row carries the fingerprint
   * that missed, so the jobs are built from the record.
   *
   * Clustered on the way out, exactly as the enqueue path would have done: forty suppressed
   * failures on one renamed control become ONE job. The gap between `released` and `jobsCreated`
   * is that clustering, made visible.
   *
   * It does not raise the threshold. An override is a decision about THESE failures, not a
   * standing instruction to stop guarding — a project that wants a higher bar edits the setting.
   */
  async releaseBreaker(actor: string): Promise<RepairBreakerOverride> {
    const rows = await this.db
      .select({
        id: suppressedFailures.id,
        testId: suppressedFailures.testId,
        runId: suppressedFailures.runId,
        clusterKey: suppressedFailures.clusterKey,
      })
      .from(suppressedFailures)
      .where(isNull(suppressedFailures.releasedAt))
      .orderBy(asc(suppressedFailures.createdAt));
    if (rows.length === 0) {
      return {
        ok: true,
        released: 0,
        jobsCreated: 0,
        jobIds: [],
        note: "The breaker has nothing suppressed — there is nothing to release.",
      };
    }

    const jobIds: string[] = [];
    for (const cluster of clusterFailures(rows.map((r) => ({ ...r })))) {
      const anchor = cluster.failures[0];
      const [open] = await this.db
        .select({ id: repairJobs.id })
        .from(repairJobs)
        .where(
          and(
            eq(repairJobs.clusterKey, cluster.clusterKey),
            inArray(repairJobs.status, [...OPEN_STATUSES]),
          ),
        )
        .limit(1);
      let jobId = open?.id;
      if (!jobId) {
        const [inserted] = await this.db
          .insert(repairJobs)
          .values({
            testId: anchor.testId,
            runId: anchor.runId ?? null,
            kind: "repair",
            status: "queued",
            clusterKey: cluster.clusterKey,
          })
          .onConflictDoNothing()
          .returning({ id: repairJobs.id });
        jobId = inserted?.id;
        if (jobId) jobIds.push(jobId);
      }
      if (!jobId) continue; // lost a race with a concurrent enqueue; its members are joined below
      for (const failure of cluster.failures) {
        await joinCluster(this.db, jobId, { testId: failure.testId, runId: failure.runId ?? null });
      }
    }

    const now = this.clock.now();
    await this.db
      .update(suppressedFailures)
      .set({ releasedAt: now, releasedBy: actor })
      .where(
        inArray(
          suppressedFailures.id,
          rows.map((r) => r.id),
        ),
      );
    this.log.warn(
      `circuit breaker OVERRIDDEN by ${actor}: released ${rows.length} suppressed failure(s) into ${jobIds.length} job(s)`,
    );
    return {
      ok: true,
      released: rows.length,
      jobsCreated: jobIds.length,
      jobIds,
      note: `Released ${rows.length} suppressed failure${rows.length === 1 ? "" : "s"} into ${jobIds.length} repair job${jobIds.length === 1 ? "" : "s"}. The threshold is unchanged — if this keeps happening, raise it deliberately rather than overriding every time.`,
    };
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
    return (await this.claimedJobId(principalId, testId)) !== null;
  }

  /** The id of the job this principal currently holds a live claim on for `testId`, or null.
   *  {@link hasClaimOn} asks the same question; this one is for the writes that must RECORD which
   *  job they were made under, so a version awaiting review can be traced to the failure it
   *  claims to fix.
   *
   *  Matched through `repair_job_tests`, not `repair_jobs.test_id` (Slice 19, slice 07): a claim
   *  reaches the whole Failure Cluster, because a clustered repair has to be applied to every test
   *  in it. The anchor is a member of its own cluster, so a single-test break is unchanged. */
  async claimedJobId(principalId: string, testId: string): Promise<string | null> {
    if (!principalId || !testId) return null;
    const [row] = await this.db
      .select({ id: repairJobs.id })
      .from(repairJobs)
      .innerJoin(repairJobTests, eq(repairJobTests.jobId, repairJobs.id))
      .where(
        and(
          eq(repairJobTests.testId, testId),
          eq(repairJobs.status, "claimed"),
          eq(repairJobs.claimedBy, principalId),
          gt(repairJobs.claimExpiresAt, this.clock.now()),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * Does this principal hold a live claim of a particular KIND over `testId` (Slice 19, slice 08)?
   *
   * The structural half of "a triage claim grants observation only". `hasClaimOn` answers "may this
   * credential touch this test at all"; this answers "may it CHANGE it" — and the two are different
   * questions the moment triage jobs exist, because a triage claim reaches the test's page and its
   * definition to read, and neither to write.
   *
   * Asked per (test, kind) rather than resolved to "the kind of the claim", because one drainer can
   * legitimately hold a repair claim on a test's broken locator AND a triage claim on the same
   * test's pixel regression. "Which kind is it?" has no single answer then; "is there a repair
   * claim?" always does.
   */
  async hasClaimOfKind(
    principalId: string,
    testId: string,
    kind: RepairJobKind,
  ): Promise<boolean> {
    if (!principalId || !testId) return false;
    const [row] = await this.db
      .select({ id: repairJobs.id })
      .from(repairJobs)
      .innerJoin(repairJobTests, eq(repairJobTests.jobId, repairJobs.id))
      .where(
        and(
          eq(repairJobTests.testId, testId),
          eq(repairJobs.kind, kind),
          eq(repairJobs.status, "claimed"),
          eq(repairJobs.claimedBy, principalId),
          gt(repairJobs.claimExpiresAt, this.clock.now()),
        ),
      )
      .limit(1);
    return row !== undefined;
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
   * Report a finished repair (Slice 19, slice 04) — the drainer's half of "I fixed this".
   *
   * It writes nothing to the test itself: the repair was already written, version by version, by
   * `apply_fix` / `edit_test` while the claim held, each one landing `unreviewed` and carrying
   * this job's id. So this is the CLOSE: the job goes terminal (`done`), the claim ends — which
   * revokes the credential's reach over that test the instant it returns — and the drainer's
   * account of what it did is stored beside the version for whoever reviews it.
   *
   * **The run stays failed.** Deliberately, and stated in the response rather than left to be
   * inferred: a repair does not reach back and recolour the run that failed. What it does do
   * (slice 06) is trigger a RE-RUN — a new run against the repaired definition, which reads
   * `healed` if it verifies. Amber, and still in the review queue: green is a human's decision.
   *
   * A report with nothing to show for it is REFUSED rather than recorded as a repair: a job
   * closed `done` with no version behind it is indistinguishable, later, from one that worked.
   * That drainer wanted `release_repair_job`.
   */
  async reportRepair(
    claimant: string,
    jobId: string,
    summary: string,
    justification: string,
  ): Promise<ReportedRepair> {
    const note = summary.trim();
    if (!note) {
      throw new BadRequestException(
        "say what you changed — the summary is what a reviewer reads beside the version",
      );
    }
    const claim = justification.trim();
    if (!claim) {
      // Refused BEFORE anything else, and refused WITHOUT abandoning the repair: an agent that
      // simply forgot to make the argument can make it and report again, which is a different
      // situation from one whose argument was heard and rejected.
      throw new BadRequestException(
        "a repair needs a justification: name the clause of this test's Brief that the element you re-pinned to satisfies, and say why it is the SAME control the step was always exercising. A repair you cannot justify against the Brief is not reported — release the job instead.",
      );
    }
    const [job] = await this.db
      .select({
        id: repairJobs.id,
        testId: repairJobs.testId,
        runId: repairJobs.runId,
        kind: repairJobs.kind,
        attempts: repairJobs.attempts,
      })
      .from(repairJobs)
      .where(
        and(
          eq(repairJobs.id, jobId),
          eq(repairJobs.status, "claimed"),
          eq(repairJobs.claimedBy, claimant),
          gt(repairJobs.claimExpiresAt, this.clock.now()),
        ),
      )
      .limit(1);
    // Same reasoning as `release`: a claim you do not hold is not-found, never a conflict — a
    // claimant learns nothing about jobs that are not its own. A LAPSED claim lands here too,
    // which is correct: the work is somebody else's now, so its report is not accepted.
    if (!job) throw new NotFoundException(`No repair job ${jobId} is claimed by ${claimant}`);
    if (job.kind !== "repair") {
      throw new BadRequestException(`job ${jobId} is a ${job.kind} job, which changes no test`);
    }

    // EVERY version this claim wrote, oldest first. `apply_fix` and `edit_test` each append one,
    // so a job can have more than one behind it — and abandoning the repair has to undo all of
    // them, or "the test is unchanged" would not be true.
    const written = await this.db
      .select({
        id: testVersions.id,
        version: testVersions.version,
        definition: testVersions.definition,
      })
      .from(testVersions)
      .where(and(eq(testVersions.repairJobId, jobId), eq(testVersions.reviewState, "unreviewed")))
      .orderBy(asc(testVersions.version));
    const version = written[written.length - 1];
    if (!version) {
      throw new BadRequestException(
        `Nothing was written for job ${jobId}, so there is no repair to report. Apply the fix first (apply_fix, or edit_test), or release the job if you cannot fix it.`,
      );
    }

    const verdict = await this.judgeJustification(job, written, note, claim);

    // The cluster fan-out (Slice 19, slice 07). The drainer repaired the ANCHOR; the same app
    // change broke every other test in the cluster, and they are fixed here — one proposal, one
    // decision — rather than left for thirty-seven more claims that could each land differently.
    const fanned = await this.applyAcrossCluster(job, written, claimant);

    const now = this.clock.now();
    await this.db
      .update(repairJobs)
      // `claimed_by` is left in place: it is the ATTRIBUTION of the repair now, not a live claim.
      // The status is what ends the claim, and `hasClaimOn` reads the status.
      .set({ status: "done", report: note, updatedAt: now })
      .where(eq(repairJobs.id, jobId));
    // Stored on the VERSION, not the job: the justification is what a reviewer weighs against the
    // Brief, so it has to sit beside the version it justifies for as long as that version exists.
    // Every version the job wrote carries it, the fanned-out ones included: a reviewer opening any
    // test in the cluster must see the argument the repair was allowed to stand on.
    await this.db
      .update(testVersions)
      .set({ justification: claim, justificationReasoning: verdict.reasoning })
      .where(
        inArray(testVersions.id, [version.id, ...fanned.map((f) => f.versionId)]),
      );

    const [run] = job.runId
      ? await this.db
          .select({ status: runs.status, environmentId: runs.environmentId })
          .from(runs)
          .where(eq(runs.id, job.runId))
          .limit(1)
      : [];

    const rerunId = await this.triggerRerun(job, claimant, run?.environmentId ?? null);
    // Every repaired test earns its own evidence: a cluster with one healed member and one that
    // regressed is exactly what a reviewer needs to see before accepting the whole change.
    const fannedReruns: string[] = [];
    for (const member of fanned) {
      const id = await this.triggerRerun(
        { id: job.id, testId: member.testId },
        claimant,
        member.environmentId,
      );
      if (id) fannedReruns.push(id);
    }

    return {
      ok: true,
      jobId,
      status: "done",
      testId: job.testId,
      version: version.version,
      versionId: version.id,
      reviewState: "unreviewed",
      runId: job.runId,
      runStatus: run?.status ?? null,
      rerunId,
      clusterTestIds: [job.testId, ...fanned.map((f) => f.testId)],
      rerunIds: [...(rerunId ? [rerunId] : []), ...fannedReruns],
      justification: claim,
      justificationReasoning: verdict.reasoning,
      note:
        `v${version.version} of this test is saved as an UNREVIEWED version and is waiting for a human to accept or reject it. ` +
        `Run ${job.runId ?? "(purged)"} is still ${run?.status ?? "unchanged"} — a repair does not turn a run green. ` +
        (rerunId
          ? `A re-run against the repaired definition has been queued (run ${rerunId}); if it verifies it will read HEALED, which is a review queue item, not a pass. `
          : "The re-run could not be queued, so nothing is retried automatically. ") +
        (fanned.length
          ? `The same fix was applied across this job's Failure Cluster — ${fanned.length} other test${fanned.length === 1 ? "" : "s"} broken by the same change — as ONE reviewable fix, each with its own re-run. Accepting or rejecting decides all of them together. `
          : "") +
        "Report it as a proposed fix awaiting review, not as fixed.",
    };
  }

  /**
   * Report a TRIAGE finding (Slice 19, slice 08) — the drainer's half of "I looked, and here is
   * why this is red".
   *
   * The mirror image of {@link reportRepair}, and deliberately shaped so the two cannot be
   * confused. It writes exactly one thing: a paragraph onto the run. No version, no definition, no
   * baseline, and — critically — no change to the run's status or its derived outcome. The run was
   * red before this call and is red after it, because a diagnosis must never be mistakable for a
   * resolution.
   *
   * Refused for a `repair` job: those close through `report_repair`, which has a justification gate
   * in front of it. Refused for an empty finding: a triage job closed `done` with nothing written
   * is indistinguishable, later, from one that explained something — that drainer wanted
   * `release_repair_job`.
   */
  async reportTriage(claimant: string, jobId: string, finding: string): Promise<ReportedTriage> {
    const note = finding.trim();
    if (!note) {
      throw new BadRequestException(
        "say what you found — the finding is the ONLY output of a triage job, and a job closed without one is indistinguishable from one that explained nothing. If you could not diagnose it, release the job instead.",
      );
    }
    const [job] = await this.db
      .select({
        id: repairJobs.id,
        testId: repairJobs.testId,
        runId: repairJobs.runId,
        kind: repairJobs.kind,
      })
      .from(repairJobs)
      .where(
        and(
          eq(repairJobs.id, jobId),
          eq(repairJobs.status, "claimed"),
          eq(repairJobs.claimedBy, claimant),
          gt(repairJobs.claimExpiresAt, this.clock.now()),
        ),
      )
      .limit(1);
    // Same reasoning as `release` and `reportRepair`: a claim you do not hold is not-found.
    if (!job) throw new NotFoundException(`No repair job ${jobId} is claimed by ${claimant}`);
    if (job.kind !== "triage") {
      throw new BadRequestException(
        `job ${jobId} is a ${job.kind} job, which is reported with report_repair — it proposes a fix and is gated on a brief-clause justification. report_triage only writes a finding.`,
      );
    }
    if (!job.runId) {
      throw new BadRequestException(
        `job ${jobId} has no run to write a finding onto (it was purged). Release the job.`,
      );
    }

    const now = this.clock.now();
    await this.db
      .update(runs)
      // status, error, failureKind and every checkpoint are untouched: this is an annotation.
      .set({ triageFinding: note, triageBy: claimant, triageAt: now, triageJobId: job.id })
      .where(eq(runs.id, job.runId));
    await this.db
      .update(repairJobs)
      .set({ status: "done", report: note, updatedAt: now })
      .where(eq(repairJobs.id, jobId));

    // Read the outcome back AFTER the write, so the payload states what the run actually is now
    // rather than asserting what it ought to be.
    const view = await this.runs.getById(job.runId).catch(() => null);
    this.log.log(`triage job ${jobId}: finding written onto run ${job.runId} by ${claimant}`);
    return {
      ok: true,
      jobId,
      status: "done",
      testId: job.testId,
      runId: job.runId,
      runStatus: view?.status ?? null,
      runOutcome: view?.outcome ?? null,
      finding: note,
      versionsWritten: 0,
      note: `The finding is recorded on run ${job.runId} and shown beside the failure. The run is still ${view?.outcome ?? "red"} and NOTHING about the test changed — a triage job cannot write a version, and this one did not. Report this as a diagnosis, never as a fix.`,
    };
  }

  /**
   * Apply the anchor's repair to the rest of its Failure Cluster (Slice 19, slice 07).
   *
   * The premise of clustering is that these tests are broken by ONE app change, so they take ONE
   * fix — proposed once, reviewed once, accepted or rejected together. Repairing them
   * independently is the failure mode the slice exists to prevent: thirty-eight claims, thirty-eight
   * judgements, and a corpus that no longer agrees with itself about what the button is called.
   *
   * The fix is read out of what the anchor actually became, not out of what the drainer said: the
   * step whose recorded locator carried this job's cluster key before the repair now carries a new
   * target, and that target is what every other member gets. Members are matched by cluster key
   * too, so a test whose broken step sits at a different index is still repaired, and a test that
   * no longer has that locator at all is left alone rather than guessed at.
   *
   * Runs AFTER the justification gate: the fanned-out change is the same change the judge already
   * accepted, applied to more tests. If any member fails to take it, everything written under this
   * job is reverted and the report is refused — a half-applied cluster is the one outcome worse
   * than no repair, because it looks finished.
   */
  private async applyAcrossCluster(
    job: { id: string; testId: string },
    written: Array<{ id: string; version: number; definition: unknown }>,
    claimant: string,
  ): Promise<Array<{ testId: string; versionId: string; version: number; environmentId: string | null }>> {
    const members = (await this.clusterMembers([job.id])).get(job.id) ?? [];
    const others = members.filter((m) => m.testId !== job.testId);
    if (others.length === 0) return [];

    const [jobRow] = await this.db
      .select({ clusterKey: repairJobs.clusterKey })
      .from(repairJobs)
      .where(eq(repairJobs.id, job.id))
      .limit(1);
    const clusterKey = jobRow?.clusterKey;
    if (!clusterKey) return [];

    // What the anchor's broken locator BECAME. Diffed against the definition immediately below the
    // first version this job wrote, so it is the repair as recorded rather than as described.
    const [before] = await this.db
      .select({ definition: testVersions.definition })
      .from(testVersions)
      .where(and(eq(testVersions.testId, job.testId), lt(testVersions.version, written[0].version)))
      .orderBy(desc(testVersions.version))
      .limit(1);
    const newTarget = repairedTarget(
      before?.definition as TestDefinition | undefined,
      written[written.length - 1].definition as TestDefinition,
      clusterKey,
    );
    if (!newTarget) {
      // The repair was not a locator re-pin this job's cluster key can be traced through (an
      // `edit_test` that restructured the steps, say). Fanning a change we cannot identify across
      // other people's tests would be a guess, so the cluster stays a proposal about the anchor
      // only — said plainly in the report rather than left to be discovered in review.
      this.log.warn(
        `job ${job.id}: could not identify the re-pinned locator for cluster ${clusterKey}; the repair was NOT fanned out to ${others.length} other test(s)`,
      );
      return [];
    }

    const applied: Array<{ testId: string; versionId: string; version: number; environmentId: string | null }> = [];
    try {
      for (const member of others) {
        const [latest] = await this.db
          .select({ version: testVersions.version, definition: testVersions.definition })
          .from(testVersions)
          .where(eq(testVersions.testId, member.testId))
          .orderBy(desc(testVersions.version))
          .limit(1);
        if (!latest) continue;
        const index = stepIndexForCluster(latest.definition as TestDefinition, clusterKey);
        if (index === null) {
          // This member has already been edited past the break (or never really shared it).
          // Skipped, not failed: the cluster is a hypothesis about a root cause, and a member that
          // no longer holds the broken locator has nothing to repair.
          this.log.log(
            `job ${job.id}: test ${member.testId} no longer carries cluster ${clusterKey} — nothing to fan out`,
          );
          continue;
        }
        const { version, versionId } = await this.tests.saveConfig(
          member.testId,
          { baseVersion: latest.version, steps: [{ index, target: newTarget }] },
          `${claimant} (Claude repair, clustered)`,
          { unreviewed: true, repairJobId: job.id },
        );
        applied.push({
          testId: member.testId,
          versionId,
          version,
          environmentId: await this.environmentOfRun(member.runId),
        });
      }
    } catch (err) {
      // Fail closed, loudly: undo the anchor AND every member already written, then refuse. A
      // cluster half-applied is worse than none, because the queue would call it done.
      this.log.error(
        `job ${job.id}: fanning the repair across its cluster failed — reverting everything it wrote: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.revertCluster(job.id, [
        { testId: job.testId, versionIds: written.map((w) => w.id), revertBefore: written[0].version },
        ...applied.map((a) => ({
          testId: a.testId,
          versionIds: [a.versionId],
          revertBefore: a.version,
        })),
      ], "cluster fan-out", `the fix could not be applied across the whole cluster`, {
        id: job.id,
        set: { status: "queued", claimedBy: null, claimedAt: null, claimExpiresAt: null },
      });
      throw new BadRequestException(
        `The repair was NOT applied: it could not be written across every test in this job's Failure Cluster, and a cluster half-repaired is worse than one not repaired at all. Everything this job wrote has been reverted and the job is back in the queue.`,
      );
    }
    return applied;
  }

  /** Undo a repair across several tests — the clustered form of a revert, through the SAME
   *  per-test path a human Reject uses. The job update is applied once, on the first revert. */
  private async revertCluster(
    jobId: string,
    targets: Array<{ testId: string; versionIds: string[]; revertBefore: number }>,
    actor: string,
    because: string,
    jobUpdate: { id: string; set: Record<string, unknown> } | null,
  ): Promise<void> {
    let job = jobUpdate;
    for (const target of targets) {
      try {
        await this.reviews.revertRepair({ ...target, actor, because, jobUpdate: job });
        job = null; // the job moves once, however many tests the cluster covers
      } catch (err) {
        this.log.error(
          `job ${jobId}: could not revert test ${target.testId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (job) {
      await this.db
        .update(repairJobs)
        .set({ ...job.set, updatedAt: this.clock.now() })
        .where(eq(repairJobs.id, job.id));
    }
  }

  /** The environment a member's failing run used, so its re-run re-tests the break where it broke. */
  private async environmentOfRun(runId: string | null): Promise<string | null> {
    if (!runId) return null;
    const [row] = await this.db
      .select({ environmentId: runs.environmentId })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    return row?.environmentId ?? null;
  }

  /**
   * Queue a RE-RUN of the repaired test (Slice 19, slice 06) — the thing that turns "a fix was
   * proposed" into evidence.
   *
   * It is a NEW run, not a resurrection of the one that failed: the original failure is a fact of
   * history and stays `failed` forever. The re-run replays the test's latest definition, which is
   * the repaired (still `unreviewed`) version — so if it verifies, it reads `healed` rather than
   * `passed`, and stays that way until a human accepts the version.
   *
   * Same environment as the failed run, so it re-tests the break where the break happened.
   *
   * Best-effort, and quietly so: the repair has already passed the gate and stands. A queue that
   * is down is a reason not to have evidence yet, not a reason to throw the repair away — the
   * report says plainly that no re-run was queued, and a human can run it themselves.
   */
  private async triggerRerun(
    job: { id: string; testId: string },
    claimant: string,
    environmentId: string | null,
  ): Promise<string | null> {
    try {
      const { runId } = await this.runs.create(job.testId, {
        environmentId: environmentId ?? undefined,
        triggeredBy: claimant,
        triggerSource: "repair",
      });
      this.log.log(`repair job ${job.id}: queued re-run ${runId} of test ${job.testId}`);
      return runId;
    } catch (err) {
      this.log.error(
        `repair job ${job.id}: could not queue a re-run of test ${job.testId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * The brief-justification gate (Slice 19, slice 05).
   *
   * Runs BEFORE the repair is allowed to stand, and fails CLOSED in every direction: a refused
   * justification, a judge that throws, and a deployment with no judge configured all abandon the
   * repair — the test goes back to what it said before, and the run stays `failed`. The only path
   * that leaves the repaired version in place is an explicit `pass`.
   *
   * The abandonment paths differ only in what becomes of the JOB, and deliberately:
   *
   *  - a **refused** justification is a verdict about this repair, so the job ends terminally.
   *    Returning it to the queue would invite the next drainer to re-pin to the same
   *    plausible-but-wrong control and be refused again — a treadmill, not a backlog.
   *  - a judge that is **broken or absent** says nothing about the repair, so the job goes back to
   *    the queue with one attempt spent. Burning jobs permanently because an API key expired would
   *    quietly empty the queue during an outage.
   */
  private async judgeJustification(
    job: { id: string; testId: string; runId: string | null },
    written: Array<{ id: string; version: number; definition: unknown }>,
    summary: string,
    justification: string,
  ): Promise<JudgeResult> {
    const [test] = await this.db
      .select({ name: tests.name, brief: tests.intent })
      .from(tests)
      .where(eq(tests.id, job.testId))
      .limit(1);

    const abandon = async (reason: string, jobSet: Record<string, unknown>): Promise<never> => {
      const { previousVersion, revertedToVersion } = await this.reviews.revertRepair({
        testId: job.testId,
        versionIds: written.map((w) => w.id),
        revertBefore: written[0].version,
        actor: "justification gate",
        because: reason,
        jobUpdate: { id: job.id, set: jobSet },
      });
      this.log.warn(
        `repair for job ${job.id} ABANDONED (${reason}): test ${job.testId} reverted to v${previousVersion}'s definition as v${revertedToVersion}`,
      );
      throw new BadRequestException(
        `The repair was NOT applied: ${reason}. The test has been reverted to what v${previousVersion} said (written as v${revertedToVersion}), and the run is still failed. Do not report this as fixed.`,
      );
    };

    if (!test?.brief?.trim()) {
      // Nothing to justify against, so nothing can be checked — and an unchecked repair is exactly
      // what this gate exists to prevent. Refused rather than waved through, and said plainly
      // enough that the remedy (give the test a Brief) is obvious.
      await abandon(
        "this test has no Brief, so there is no clause to justify a repair against — give the test a Brief before it can be repaired automatically",
        { status: "failed" },
      );
    }

    const judge = await this.judgeSource.resolve();
    if (!judge) {
      await abandon(
        "no judge is configured, so the justification could not be validated — and an unvalidated repair is never applied",
        this.giveBack(this.clock.now()),
      );
    }

    const [previousDefinition] = await this.db
      .select({ definition: testVersions.definition })
      .from(testVersions)
      .where(and(eq(testVersions.testId, job.testId), lt(testVersions.version, written[0].version)))
      .orderBy(desc(testVersions.version))
      .limit(1);
    const failing = await this.failingStepOf(job.runId);

    let verdict: JudgeResult;
    try {
      verdict = await judgeRepairJustification(judge as JudgeProvider, {
        testName: test?.name ?? "(unknown test)",
        brief: test?.brief ?? null,
        failingStep: failing.label,
        runError: failing.error,
        change: describeRepairChange(
          previousDefinition?.definition as TestDefinition | undefined,
          written[written.length - 1].definition as TestDefinition,
        ),
        summary,
        justification,
      });
    } catch (err) {
      // A transport error is NOT a pass. The provider has already retried; what reaches here is a
      // judge that could not answer, and an unanswered gate is a closed one.
      await abandon(
        `the justification could not be validated (${err instanceof Error ? err.message : String(err)})`,
        this.giveBack(this.clock.now()),
      );
      throw err; // unreachable — `abandon` always throws
    }

    if (verdict.verdict !== "pass") {
      await abandon(`the justification was rejected — ${verdict.reasoning}`, { status: "failed" });
    }
    return verdict;
  }

  /** The step the run recorded as broken, for the gate's evidence. Read off the version that
   *  ACTUALLY ran, like {@link claimedPayload} — a later edit must not rewrite that account. */
  private async failingStepOf(
    runId: string | null,
  ): Promise<{ label: string | null; error: string | null }> {
    if (!runId) return { label: null, error: null };
    const [run] = await this.db
      .select({
        error: runs.error,
        failedStepIndex: runs.failedStepIndex,
        definition: testVersions.definition,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) return { label: null, error: null };
    const index = run.failedStepIndex ?? null;
    const step = index === null ? undefined : (run.definition as TestDefinition).steps[index];
    return { label: step ? describeStep(step) : null, error: run.error ?? null };
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

    // The cluster the claim reaches. A drainer must know it is repairing an app change, not a
    // test: the fix it applies is fanned out across all of these as one reviewable change.
    const members = (await this.clusterMembers([job.id])).get(job.id) ?? [];

    return {
      jobId: job.id,
      kind: job.kind as RepairJobKind,
      testId: job.testId,
      testName: job.testName,
      runId: job.runId,
      brief: job.brief,
      clusterKey: job.clusterKey,
      clusterTests: members.length
        ? members
        : [{ testId: job.testId, testName: job.testName, runId: job.runId }],
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

/**
 * The target a repair re-pinned a broken locator to: the step that carried `clusterKey` BEFORE the
 * repair, read back off the definition AFTER it. Null when no such step exists any more, or when
 * its target is unchanged — either way there is no identified re-pin to fan out, and guessing one
 * would edit other people's tests on a hunch.
 */
function repairedTarget(
  before: TestDefinition | undefined,
  after: TestDefinition,
  clusterKey: string,
): Fingerprint | null {
  if (!before) return null;
  const index = stepIndexForCluster(before, clusterKey);
  if (index === null) return null;
  const step = after.steps[index];
  const target = step && "target" in step ? step.target : undefined;
  if (!target) return null;
  return deriveClusterKey(target) === clusterKey ? null : target;
}

/** The index of the step whose recorded locator has this cluster key, or null. */
function stepIndexForCluster(def: TestDefinition, clusterKey: string): number | null {
  for (const [index, step] of def.steps.entries()) {
    if (!("target" in step) || !step.target) continue;
    if (deriveClusterKey(step.target) === clusterKey) return index;
  }
  return null;
}
