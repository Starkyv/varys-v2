import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { suiteSchedules, testSchedules } from "@varys/db";
import parser from "cron-parser";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { RunsService } from "../runs/runs.service";
import { SuiteRunsService } from "../suite-runs/suite-runs.service";

/** How often to sweep for due schedules. Cron granularity is minutes, so the 30s default fires a
 *  due schedule within 30s of its cron time — fine for the coarsest (`* * * * *`) expression.
 *  Overridable via VARYS_SCHEDULER_TICK_MS (tests set it low for speed). */
function tickMs(): number {
  const n = Number(process.env.VARYS_SCHEDULER_TICK_MS);
  return Number.isFinite(n) && n >= 100 ? n : 30_000;
}

/**
 * The schedule **firing tick** (the runtime half of the scheduling feature; config-time save +
 * `nextRunAt` computation lives in TestsService). Every {@link TICK_MS} it sweeps
 * `test_schedules` for enabled rows whose `next_run_at <= now()`, and for each **atomically claims
 * it** (advances `next_run_at` to the next cron fire in one conditional UPDATE — so overlapping
 * ticks or multiple API replicas can't double-fire), then creates a run through the SAME path as a
 * manual trigger (`RunsService.create`, `triggerSource: "schedule"`).
 *
 * No catch-up: a schedule that came due while the process was down fires **once** and advances to
 * its next future time — never a backfill storm.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Scheduler");
  private timer?: ReturnType<typeof setInterval>;
  private boot?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private ticking = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RunsService) private readonly runs: RunsService,
    @Inject(SuiteRunsService) private readonly suiteRuns: SuiteRunsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), tickMs());
    // A short delay after boot so the first sweep doesn't race module wiring.
    this.boot = setTimeout(() => void this.tick(), 3_000);
  }

  onModuleDestroy(): void {
    // Clear BOTH timers so a fast-closing app (e.g. an E2E) can't tick against a torn-down DB.
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.boot) clearTimeout(this.boot);
  }

  /** The next cron fire in `tz`, or null on an unparseable expression (defensive — config validates
   *  it, but a bad row must not wedge the whole sweep). */
  private nextFire(cron: string, tz: string): Date | null {
    try {
      return parser.parseExpression(cron, { tz }).next().toDate();
    } catch {
      return null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return; // don't run after teardown; never overlap a slow sweep
    this.ticking = true;
    try {
      const now = new Date();
      const due = await this.db
        .select({
          testId: testSchedules.testId,
          cron: testSchedules.cron,
          timezone: testSchedules.timezone,
          environmentId: testSchedules.environmentId,
          keepTrace: testSchedules.keepTrace,
        })
        .from(testSchedules)
        .where(
          and(
            eq(testSchedules.enabled, true),
            isNotNull(testSchedules.nextRunAt),
            lte(testSchedules.nextRunAt, now),
          ),
        );

      for (const s of due) {
        const tz = s.timezone?.trim() || "UTC";
        const next = this.nextFire(s.cron, tz);
        if (!next) {
          this.log.warn(`skipping schedule for test ${s.testId}: unparseable cron "${s.cron}"`);
          continue;
        }
        // Claim: advance next_run_at to the next fire ONLY if it's still due. If another tick /
        // replica already advanced it, this matches 0 rows and we skip — no double-fire.
        const claimed = await this.db
          .update(testSchedules)
          .set({ nextRunAt: next, lastRunAt: now })
          .where(
            and(
              eq(testSchedules.testId, s.testId),
              eq(testSchedules.enabled, true),
              lte(testSchedules.nextRunAt, now),
            ),
          )
          .returning({ testId: testSchedules.testId });
        if (claimed.length === 0) continue;

        try {
          const { runId } = await this.runs.create(s.testId, {
            environmentId: s.environmentId ?? undefined,
            trace: s.keepTrace ?? false,
            triggerSource: "schedule",
            triggeredBy: "schedule",
          });
          await this.db
            .update(testSchedules)
            .set({ lastRunId: runId })
            .where(eq(testSchedules.testId, s.testId));
          this.log.log(`fired scheduled run ${runId} for test ${s.testId} · next ${next.toISOString()}`);
        } catch (err) {
          // The claim already advanced next_run_at, so a failed enqueue just skips this cycle
          // (it'll fire again next cron tick) rather than hot-looping.
          this.log.error(
            `failed to fire scheduled run for test ${s.testId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // --- Suite schedules: same sweep → claim → fire (a whole suite run) → advance. ---
      const dueSuites = await this.db
        .select({
          suiteId: suiteSchedules.suiteId,
          cron: suiteSchedules.cron,
          timezone: suiteSchedules.timezone,
          environmentId: suiteSchedules.environmentId,
          keepTrace: suiteSchedules.keepTrace,
        })
        .from(suiteSchedules)
        .where(
          and(
            eq(suiteSchedules.enabled, true),
            isNotNull(suiteSchedules.nextRunAt),
            lte(suiteSchedules.nextRunAt, now),
          ),
        );

      for (const s of dueSuites) {
        const tz = s.timezone?.trim() || "UTC";
        const next = this.nextFire(s.cron, tz);
        if (!next) {
          this.log.warn(`skipping schedule for suite ${s.suiteId}: unparseable cron "${s.cron}"`);
          continue;
        }
        const claimed = await this.db
          .update(suiteSchedules)
          .set({ nextRunAt: next, lastRunAt: now })
          .where(
            and(
              eq(suiteSchedules.suiteId, s.suiteId),
              eq(suiteSchedules.enabled, true),
              lte(suiteSchedules.nextRunAt, now),
            ),
          )
          .returning({ suiteId: suiteSchedules.suiteId });
        if (claimed.length === 0) continue;

        try {
          const { suiteRunId } = await this.suiteRuns.trigger(
            s.suiteId,
            s.environmentId ? [s.environmentId] : undefined,
            s.keepTrace ?? false,
            "schedule",
          );
          await this.db
            .update(suiteSchedules)
            .set({ lastSuiteRunId: suiteRunId })
            .where(eq(suiteSchedules.suiteId, s.suiteId));
          this.log.log(`fired scheduled suite run ${suiteRunId} for suite ${s.suiteId} · next ${next.toISOString()}`);
        } catch (err) {
          // e.g. the suite has no tests → BadRequest. Already advanced, so it won't hot-loop.
          this.log.error(
            `failed to fire scheduled suite run for suite ${s.suiteId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.log.error(`scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }
}
