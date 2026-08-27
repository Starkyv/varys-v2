import {
  appSettings,
  type Db,
  repairJobs,
  repairJobTests,
  runAssertions,
  runs,
  suppressedFailures,
  tests,
  testVersions,
} from "@varys/db";
import { pinnedSideTarget } from "@varys/assertion-engine";
import { notifyBreakerTripped } from "@varys/notify";
import {
  breakerVerdict,
  type BreakerVerdict,
  deriveClusterKey,
  type FailureRecord,
  normalizeBreakerThreshold,
  triageClusterKey,
  type TriageFailureKind,
} from "@varys/repair-policy";
import type { Fingerprint, TestDefinition } from "@varys/step-schema";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

/**
 * A run failed because the matcher could not resolve a recorded fingerprint — the ONE failure
 * class auto-repair may touch. Thrown instead of a bare `Error` so the decision "is this
 * repairable?" is a type, not a substring match on a message: a pixel regression, a failed
 * judge, a false relation and a crash all stay plain errors and can never reach the queue.
 *
 * Carries the fingerprint that missed, because that is what the cluster key derives from.
 */
export class LocatorUnresolvedError extends Error {
  /** The recorded fingerprint the matcher could not resolve. */
  readonly target: Fingerprint;

  constructor(message: string, target: Fingerprint) {
    super(message);
    this.name = "LocatorUnresolvedError";
    this.target = target;
  }
}

/**
 * A `context` checkpoint could not be judged at all — no judge provider is configured, or the
 * checkpoint has no prompt and there is no global default.
 *
 * A distinct type for the same reason `LocatorUnresolvedError` is one: the class of a failure is
 * recorded from the code that knows what threw, never matched out of a message. Without it this
 * lands as a generic `crash`, and a queue that says "crashed" when the truth is "you have not
 * configured a judge" sends whoever reads it looking in the wrong place.
 */
export class JudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeUnavailableError";
  }
}

/** `app_settings` key for the circuit-breaker threshold (Slice 19, slice 07). Kept in sync with
 *  the API's settings service, which is where a human edits it. */
export const BREAKER_THRESHOLD_KEY = "repair_breaker_threshold";

/**
 * How far back "simultaneous" reaches.
 *
 * The breaker asks "how many tests are broken on a locator RIGHT NOW", and the honest answer needs
 * a window: a nightly suite's failures arrive over however long the suite takes, while unrelated
 * drift two weeks apart is not one event. An hour is long enough to hold a whole nightly fan-out
 * and short enough that a slow trickle never accumulates into a false trip.
 *
 * Deliberately NOT counted from the open queue instead. A project with no drainer accumulates
 * queued jobs by design (ADR-0003), so counting those would trip the breaker permanently on a
 * project whose only problem is that nothing is draining — exactly the diagnosis slice 01 went out
 * of its way to keep distinct.
 */
export const BREAKER_WINDOW_MS = 60 * 60_000;

/** How many recent failures the census reads at most — a backstop, not a policy. Well above any
 *  threshold anyone would set, so the verdict is never wrong for want of rows. */
const CENSUS_LIMIT = 500;

/** What happened to a locator failure that reached the queue. */
export type EnqueueOutcome =
  /** A new job was opened for this cluster. */
  | { status: "enqueued"; jobId: string; clusterKey: string }
  /** An open job already covered this cluster; this test JOINED it (the clustering case). */
  | { status: "joined"; jobId: string; clusterKey: string }
  /** The breaker was tripped: no job, the failure recorded as breaker-suppressed. */
  | { status: "suppressed"; clusterKey: string; verdict: BreakerVerdict }
  /** Nothing to do: the test's policy is `manual`, or the test is gone. */
  | { status: "skipped"; reason: "policy" | "missing-test" };

/** The project's breaker threshold — the stored setting, or the documented default. */
export async function breakerThreshold(db: Db): Promise<number> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, BREAKER_THRESHOLD_KEY))
    .limit(1);
  return normalizeBreakerThreshold(row?.value);
}

/**
 * Every locator failure recorded in the window, as {@link FailureRecord}s — the breaker's input.
 *
 * Read from `runs.failure_kind = 'locator'`, which the runner writes from the code that knows what
 * threw, so the census cannot disagree with the runs about what failed. Each record's cluster key
 * is derived from the failing step of the version that ACTUALLY ran, so a rename after the fact
 * cannot retroactively re-cluster history.
 *
 * `locator` covers an ASSERTION whose extraction target no longer resolves as well (slice 10) — it
 * has no failing step, so its key comes from the assertion side the run recorded as unresolved.
 * Without that the breaker would be blind to a mass break that happened to be caught by assertions.
 */
export async function recentLocatorFailures(
  db: Db,
  now: Date = new Date(),
): Promise<FailureRecord[]> {
  const rows = await db
    .select({
      runId: runs.id,
      failedStepIndex: runs.failedStepIndex,
      testId: testVersions.testId,
      definition: testVersions.definition,
    })
    .from(runs)
    .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
    .where(
      and(
        eq(runs.failureKind, "locator"),
        gte(runs.createdAt, new Date(now.getTime() - BREAKER_WINDOW_MS)),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(CENSUS_LIMIT);

  // An ASSERTION whose extraction target no longer resolves is a locator failure too (slice 10),
  // and it has no failing STEP: the steps all ran. Its target is recovered from the assertion the
  // run recorded as unresolved, so the census keys it exactly as the enqueue path did — one broken
  // element read by forty assertions is one cluster here as well, and the breaker sees the mass
  // failure it exists to catch.
  const withoutStep = rows.filter((r) => r.failedStepIndex === null);
  const assertionSides = withoutStep.length
    ? await db
        .select({
          runId: runAssertions.runId,
          assertionId: runAssertions.assertionId,
          side: runAssertions.side,
        })
        .from(runAssertions)
        .where(
          and(
            inArray(
              runAssertions.runId,
              withoutStep.map((r) => r.runId),
            ),
            eq(runAssertions.outcome, "extraction-failed"),
            eq(runAssertions.cause, "unresolved"),
          ),
        )
    : [];
  const sidesByRun = new Map<string, Array<{ assertionId: string; side: string | null }>>();
  for (const row of assertionSides) {
    const list = sidesByRun.get(row.runId) ?? [];
    list.push({ assertionId: row.assertionId, side: row.side });
    sidesByRun.set(row.runId, list);
  }

  const failures: FailureRecord[] = [];
  for (const row of rows) {
    const definition = row.definition as TestDefinition;
    const step = definition.steps[row.failedStepIndex ?? -1];
    const target =
      (step && "target" in step ? step.target : undefined) ??
      assertionTargetOf(definition, sidesByRun.get(row.runId) ?? []);
    // A locator failure with no recoverable target cannot be clustered — count the TEST (it is
    // genuinely broken, and the threshold counts tests) under a key of its own.
    failures.push({
      testId: row.testId,
      runId: row.runId,
      clusterKey: target ? deriveClusterKey(target) : `unclusterable:${row.runId}`,
    });
  }
  return failures;
}

/** The first recoverable target among a run's unresolved assertion sides, over the definition that
 *  actually ran — through the same `pinnedSideTarget` walk the enqueue path uses, so the census
 *  cannot key a failure differently from the job that was (or was not) opened for it. */
function assertionTargetOf(
  definition: TestDefinition,
  sides: Array<{ assertionId: string; side: string | null }>,
): Fingerprint | undefined {
  for (const row of sides) {
    const target = pinnedSideTarget(definition.assertions, row.assertionId, row.side);
    if (target) return target;
  }
  return undefined;
}

/**
 * Enqueue a Repair Job for a locator failure, if the test's Repair Policy allows it and the
 * circuit breaker is not tripped.
 *
 * Called from the runner's failure path — the point where an unresolvable locator is ALREADY
 * detected — so there is no scanner to fall behind or to disagree with the run. Under `manual`
 * (the default) this is a no-op and the run behaves exactly as it did before the queue existed.
 *
 * Three outcomes, in the order they are decided (Slice 19, slice 07):
 *
 *  1. **Suppressed.** More tests are simultaneously broken on a locator than the project's
 *     threshold allows, so NO job is created and the failure is recorded as breaker-suppressed
 *     with an alert. Mass failure means the app broke or was redesigned — a human decision — and
 *     repairing through it would rewrite the corpus into agreement with a bug. Checked FIRST, so a
 *     bad deploy cannot get its first eleven repairs in before the guard notices.
 *  2. **Joined.** An open job already covers this broken locator, so this test joins its Failure
 *     Cluster. This is what makes thirty-eight tests broken by one renamed button ONE reviewable
 *     fix rather than thirty-eight that can diverge. "Open" covers claimed as well as queued, so a
 *     nightly suite that keeps failing while a drainer is mid-repair doesn't stack a rival job.
 *  3. **Enqueued.** Nothing covers it yet: a new job, anchored on this test and run.
 */
export async function enqueueRepairIfAuto(
  db: Db,
  params: { testId: string; runId: string; target: Fingerprint },
): Promise<EnqueueOutcome> {
  const [test] = await db
    .select({ repairPolicy: tests.repairPolicy, name: tests.name })
    .from(tests)
    .where(eq(tests.id, params.testId))
    .limit(1);
  if (!test) return { status: "skipped", reason: "missing-test" };
  if (test.repairPolicy !== "auto") return { status: "skipped", reason: "policy" };

  const clusterKey = deriveClusterKey(params.target);

  // ---- 1. the breaker ------------------------------------------------------------------
  const threshold = await breakerThreshold(db);
  const verdict = breakerVerdict(await recentLocatorFailures(db), threshold);
  if (verdict.tripped) {
    await suppress(db, { ...params, clusterKey, verdict });
    // Best-effort, and after the record: the suppression must survive a Slack outage, because it
    // is what the override reads from. An alert nobody receives is a worse failure than a late one,
    // but a suppression nobody recorded is unrecoverable.
    try {
      await notifyBreakerTripped(db, {
        failingTests: verdict.failingTests,
        clusters: verdict.clusters,
        threshold: verdict.threshold,
        latestTestName: test.name,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[runner] circuit breaker tripped but the alert could not be sent:", err);
    }
    return { status: "suppressed", clusterKey, verdict };
  }

  // ---- 2. join the open job for this cluster, if there is one ---------------------------
  const openForCluster = () =>
    db
      .select({ id: repairJobs.id })
      .from(repairJobs)
      .where(
        and(eq(repairJobs.clusterKey, clusterKey), inArray(repairJobs.status, ["queued", "claimed"])),
      )
      .limit(1);

  const [open] = await openForCluster();
  if (open) {
    await joinCluster(db, open.id, params);
    return { status: "joined", jobId: open.id, clusterKey };
  }

  // ---- 3. a new job, anchored on this failure -------------------------------------------
  const [inserted] = await db
    .insert(repairJobs)
    .values({
      testId: params.testId,
      runId: params.runId,
      kind: "repair",
      status: "queued",
      clusterKey,
    })
    .onConflictDoNothing()
    .returning({ id: repairJobs.id });

  // Lost the insert race against another worker: the partial unique index refused the duplicate,
  // so read back whichever job won and join it instead.
  const jobId = inserted?.id ?? (await openForCluster())[0]?.id;
  if (!jobId) return { status: "skipped", reason: "missing-test" };
  await joinCluster(db, jobId, params);
  return { status: inserted ? "enqueued" : "joined", jobId, clusterKey };
}

/** Record a test as a member of a job's Failure Cluster. Re-failing while the job is open
 *  refreshes which run last showed it rather than joining twice. */
export async function joinCluster(
  db: Db,
  jobId: string,
  member: { testId: string; runId: string | null },
): Promise<void> {
  await db
    .insert(repairJobTests)
    .values({ jobId, testId: member.testId, runId: member.runId })
    .onConflictDoUpdate({
      target: [repairJobTests.jobId, repairJobTests.testId],
      set: { runId: sql`excluded.run_id` },
    });
}

/** Record a failure the breaker refused to enqueue. Idempotent per (test, cluster) while still
 *  suppressed, so a nightly suite re-failing under a tripped breaker leaves one row per test and
 *  cluster rather than one per run — the override releases work, not a backlog of duplicates. */
async function suppress(
  db: Db,
  params: {
    testId: string;
    runId: string;
    target: Fingerprint;
    clusterKey: string;
    verdict: BreakerVerdict;
  },
): Promise<void> {
  const [existing] = await db
    .select({ id: suppressedFailures.id })
    .from(suppressedFailures)
    .where(
      and(
        eq(suppressedFailures.testId, params.testId),
        eq(suppressedFailures.clusterKey, params.clusterKey),
        sql`${suppressedFailures.releasedAt} is null`,
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(suppressedFailures)
      .set({
        runId: params.runId,
        target: params.target,
        threshold: params.verdict.threshold,
        failingTests: params.verdict.failingTests,
      })
      .where(eq(suppressedFailures.id, existing.id));
    return;
  }
  await db.insert(suppressedFailures).values({
    testId: params.testId,
    runId: params.runId,
    clusterKey: params.clusterKey,
    target: params.target,
    threshold: params.verdict.threshold,
    failingTests: params.verdict.failingTests,
  });
}

// ── triage (slice 08) ──────────────────────────────────────────────────────────────────────────

/**
 * Enqueue a read-only **Triage Job** for a failure Claude may not fix (Slice 19, slice 08).
 *
 * A pixel regression, a failed judge, a false assertion relation, a crash and a timeout are all
 * red for reasons no re-pinned locator can address — and the corresponding right answer is not
 * "leave the run unexplained". A Triage Job's only output is a written finding on the run: Claude
 * drives to the failure, looks, and says why. The run stays red, which is the whole point.
 *
 * Gated on the SAME `auto` Repair Policy repair is, deliberately. `manual` promises the test
 * "behaves exactly as it did before the queue existed" (slice 01), and a project that has not opted
 * a test into unattended agents should not find jobs about it in the queue either.
 *
 * NOT gated on the circuit breaker. The breaker exists to stop a bad deploy rewriting the corpus,
 * and triage writes nothing — during a mass failure an explanation is the single most useful thing
 * Varys can produce, so suppressing it would remove the one safe output at exactly the moment it
 * matters most.
 *
 * Idempotent per (test, failure class) while the job is open: a nightly suite failing the same
 * pixel every night leaves one job to diagnose, not thirty.
 */
export async function enqueueTriageIfAuto(
  db: Db,
  params: { testId: string; runId: string; kind: TriageFailureKind },
): Promise<EnqueueOutcome> {
  const [test] = await db
    .select({ repairPolicy: tests.repairPolicy })
    .from(tests)
    .where(eq(tests.id, params.testId))
    .limit(1);
  if (!test) return { status: "skipped", reason: "missing-test" };
  if (test.repairPolicy !== "auto") return { status: "skipped", reason: "policy" };

  const clusterKey = triageClusterKey(params.testId, params.kind);
  const openForCluster = () =>
    db
      .select({ id: repairJobs.id })
      .from(repairJobs)
      .where(
        and(eq(repairJobs.clusterKey, clusterKey), inArray(repairJobs.status, ["queued", "claimed"])),
      )
      .limit(1);

  const [open] = await openForCluster();
  if (open) {
    await joinCluster(db, open.id, params);
    return { status: "joined", jobId: open.id, clusterKey };
  }

  const [inserted] = await db
    .insert(repairJobs)
    .values({
      testId: params.testId,
      runId: params.runId,
      kind: "triage",
      status: "queued",
      clusterKey,
    })
    .onConflictDoNothing()
    .returning({ id: repairJobs.id });
  const jobId = inserted?.id ?? (await openForCluster())[0]?.id;
  if (!jobId) return { status: "skipped", reason: "missing-test" };
  await joinCluster(db, jobId, params);
  return { status: inserted ? "enqueued" : "joined", jobId, clusterKey };
}

