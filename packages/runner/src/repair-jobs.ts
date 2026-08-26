import { type Db, repairJobs, tests } from "@varys/db";
import { deriveClusterKey } from "@varys/repair-policy";
import type { Fingerprint } from "@varys/step-schema";
import { and, eq, inArray } from "drizzle-orm";

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
 * Enqueue a Repair Job for a locator failure, if the test's Repair Policy allows it.
 *
 * Called from the runner's failure path — the point where an unresolvable locator is ALREADY
 * detected — so there is no scanner to fall behind or to disagree with the run. Under `manual`
 * (the default) this is a no-op and the run behaves exactly as it did before the queue existed.
 *
 * Returns the new job's id, or null when nothing was enqueued: policy is `manual`, the test is
 * gone, or an equivalent job is already OPEN. "Open" covers claimed as well as queued, so a
 * nightly suite that keeps failing while a drainer is mid-repair doesn't stack a second job
 * behind the one being worked on. (The partial unique index still backs the queued case, which
 * is the one two workers can race on.)
 */
export async function enqueueRepairIfAuto(
  db: Db,
  params: { testId: string; runId: string; target: Fingerprint },
): Promise<string | null> {
  const [test] = await db
    .select({ repairPolicy: tests.repairPolicy })
    .from(tests)
    .where(eq(tests.id, params.testId))
    .limit(1);
  if (test?.repairPolicy !== "auto") return null;

  const clusterKey = deriveClusterKey(params.target);
  const [open] = await db
    .select({ id: repairJobs.id })
    .from(repairJobs)
    .where(
      and(
        eq(repairJobs.testId, params.testId),
        eq(repairJobs.clusterKey, clusterKey),
        inArray(repairJobs.status, ["queued", "claimed"]),
      ),
    )
    .limit(1);
  if (open) return null;

  const [job] = await db
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
  return job?.id ?? null;
}
