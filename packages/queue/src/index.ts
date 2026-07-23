import PgBoss from "pg-boss";

export const RUN_QUEUE = "run";

export interface RunJobData {
  runId: string;
}

export type Boss = PgBoss;

/**
 * Create a pg-boss instance (not yet started). Supervision + scheduling are
 * disabled: the MVP only uses send/work, so we don't need pg-boss's background
 * maintenance or cron timers (and they only add load + flakiness in tests).
 */
export function createBoss(connectionString: string): PgBoss {
  return new PgBoss({ connectionString, supervise: false, schedule: false });
}

/** Start the boss and ensure the run queue exists (both idempotent). */
export async function startBoss(boss: PgBoss): Promise<void> {
  // pg-boss is an EventEmitter that surfaces transient/maintenance errors via
  // 'error'. An unhandled 'error' event makes Node throw and crash the process
  // (which severs any in-flight request as a "socket hang up"), so this handler
  // is mandatory, not optional.
  boss.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[pg-boss] error:", err);
  });
  await boss.start();
  await boss.createQueue(RUN_QUEUE);
}

/** Publish a run job. */
export async function enqueueRun(boss: PgBoss, runId: string): Promise<void> {
  await boss.send(RUN_QUEUE, { runId } satisfies RunJobData);
}

/**
 * Subscribe handler(s) to run jobs. `concurrency` (default 1) registers that many INDEPENDENT
 * single-job workers on the queue, giving up to `concurrency` runs in flight at once — picked up as
 * they arrive (rolling), not batch-at-a-time. pg-boss claims each job atomically (`FOR UPDATE SKIP
 * LOCKED`), so the workers never double-process a run. Each run gets its own browser/context in the
 * runner, so concurrent runs are fully isolated; raise `concurrency` only as far as the host's
 * CPU/RAM allows (each run drives a headless Chromium).
 */
export async function workRuns(
  boss: PgBoss,
  handler: (runId: string) => Promise<void>,
  concurrency = 1,
): Promise<void> {
  const slots = Math.max(1, Math.floor(concurrency));
  for (let i = 0; i < slots; i += 1) {
    await boss.work<RunJobData>(RUN_QUEUE, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data.runId);
      }
    });
  }
}
