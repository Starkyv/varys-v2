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

/** Subscribe a handler to run jobs. */
export async function workRuns(
  boss: PgBoss,
  handler: (runId: string) => Promise<void>,
): Promise<void> {
  await boss.work<RunJobData>(RUN_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await handler(job.data.runId);
    }
  });
}
