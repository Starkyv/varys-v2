import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  createDb,
  type DbHandle,
  runs,
  suiteRuns,
  suiteSchedules,
  testSchedules,
  testVersions,
} from "@varys/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authed, prepareAuth } from "./auth-harness";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Slice 8 (Scheduling) Issue 2 — the firing TICK. A due schedule (`next_run_at <= now`, enabled)
 * must produce a run (`trigger_source = "schedule"`) and advance `next_run_at` to the next cron
 * fire. The tick is sped up via VARYS_SCHEDULER_TICK_MS so the test doesn't wait 30s.
 */
describe("Test schedules — firing tick", () => {
  let app: INestApplication;
  let db: TestDb;
  let dbh: DbHandle;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_SCHEDULER_TICK_MS = "400"; // fast tick for the test
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();
    dbh = createDb(db.connectionString);
  });

  afterAll(async () => {
    await app?.close();
    await dbh?.pool.end();
    await db?.container.stop();
    delete process.env.VARYS_SCHEDULER_TICK_MS;
  });

  const mkTest = async (name: string): Promise<string> => {
    const definition = {
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "http://fixture.local/" },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" } } },
      ],
    };
    const res = await authed(app).post("/tests").send(definition).expect(201);
    return res.body.id as string;
  };

  it("fires a due schedule → creates a scheduled run and advances next_run_at", async () => {
    const testId = await mkTest("cron-fires");

    // Set a schedule (computes a FUTURE next_run_at), then force it due by backdating next_run_at.
    await authed(app)
      .patch(`/tests/${testId}`)
      .send({ schedule: { cron: "*/5 * * * *", timezone: "UTC" } })
      .expect(200);
    const past = new Date(Date.now() - 60_000);
    await dbh.db.update(testSchedules).set({ nextRunAt: past }).where(eq(testSchedules.testId, testId));

    // Wait for the tick to sweep it.
    let scheduledRun: { id: string; triggerSource: string | null } | undefined;
    for (let i = 0; i < 25; i++) {
      const rows = await dbh.db
        .select({ id: runs.id, triggerSource: runs.triggerSource })
        .from(runs)
        .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
        .where(and(eq(testVersions.testId, testId), eq(runs.triggerSource, "schedule")));
      if (rows.length > 0) {
        scheduledRun = rows[0];
        break;
      }
      await sleep(300);
    }

    expect(scheduledRun, "a scheduled run should have been created by the tick").toBeTruthy();
    expect(scheduledRun?.triggerSource).toBe("schedule");

    // next_run_at was advanced to a FUTURE cron fire (not left in the past → no re-fire loop), and
    // last_run_id points at the run we just fired.
    const [sched] = await dbh.db
      .select({ nextRunAt: testSchedules.nextRunAt, lastRunId: testSchedules.lastRunId })
      .from(testSchedules)
      .where(eq(testSchedules.testId, testId));
    expect(sched.nextRunAt && sched.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(sched.lastRunId).toBe(scheduledRun?.id);
  });

  it("fires a due SUITE schedule → creates a suite run and advances next_run_at", async () => {
    const testId = await mkTest("suite-member");
    const suiteRes = await authed(app)
      .post("/suites")
      .send({ name: "scheduled suite", testIds: [testId] })
      .expect(201);
    const suiteId = suiteRes.body.id as string;

    await authed(app)
      .put(`/suites/${suiteId}`)
      .send({ schedule: { cron: "*/5 * * * *", timezone: "UTC" } })
      .expect(200);
    await dbh.db
      .update(suiteSchedules)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(suiteSchedules.suiteId, suiteId));

    let suiteRunId: string | undefined;
    for (let i = 0; i < 25; i++) {
      const rows = await dbh.db.select({ id: suiteRuns.id }).from(suiteRuns).where(eq(suiteRuns.suiteId, suiteId));
      if (rows.length > 0) {
        suiteRunId = rows[0].id;
        break;
      }
      await sleep(300);
    }
    expect(suiteRunId, "a suite run should have fired").toBeTruthy();

    // The fan-out children are schedule-sourced, and the schedule advanced + points at the suite run.
    const children = await dbh.db
      .select({ id: runs.id, triggerSource: runs.triggerSource })
      .from(runs)
      .where(eq(runs.suiteRunId, suiteRunId as string));
    expect(children.length).toBeGreaterThan(0);
    expect(children[0].triggerSource).toBe("suite");

    const [sched] = await dbh.db
      .select({ nextRunAt: suiteSchedules.nextRunAt, lastSuiteRunId: suiteSchedules.lastSuiteRunId })
      .from(suiteSchedules)
      .where(eq(suiteSchedules.suiteId, suiteId));
    expect(sched.nextRunAt && sched.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(sched.lastSuiteRunId).toBe(suiteRunId);
  });

  it("does not fire a DISABLED schedule", async () => {
    const testId = await mkTest("cron-disabled");
    await authed(app)
      .patch(`/tests/${testId}`)
      .send({ schedule: { cron: "*/5 * * * *", timezone: "UTC", enabled: false } })
      .expect(200);
    // Even if we backdate it, a disabled schedule's next_run_at is null and enabled=false → skipped.
    await dbh.db
      .update(testSchedules)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(testSchedules.testId, testId));

    await sleep(1500); // several ticks
    const rows = await dbh.db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .where(and(eq(testVersions.testId, testId), eq(runs.triggerSource, "schedule")));
    expect(rows.length).toBe(0);
  });
});
