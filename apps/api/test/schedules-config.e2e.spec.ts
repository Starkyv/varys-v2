import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authed, prepareAuth } from "./auth-harness";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 8 (Scheduling) Issue 1 — the per-test cron config front door, pinned through the
 * HTTP API. The guarantees worth nailing (everything else is manual-verified): a schedule
 * round-trips via the STRUCTURAL update WITHOUT writing a new test_version; an invalid
 * cron is a 400 and an unknown environment a 404 (validated up front); the read-model
 * carries the schedule + a computed nextRunAt; and the schedule clears with `null`.
 * Firing is NOT exercised here — that's Issue 2.
 */
describe("Test schedules — config", () => {
  let app: INestApplication;
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.connectionString;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();
  });

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
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

  it("sets a cron schedule via the structural update — no new test_version, read-model carries it + a future nextRunAt", async () => {
    const id = await mkTest("nightly");

    await authed(app)
      .patch(`/tests/${id}`)
      .send({ schedule: { cron: "0 2 * * *", timezone: "UTC" } })
      .expect(200);

    // The config read-model carries the schedule + a computed, future nextRunAt.
    const cfg = await authed(app).get(`/tests/${id}/config`).expect(200);
    expect(cfg.body.schedule).toMatchObject({
      cron: "0 2 * * *",
      timezone: "UTC",
      enabled: true,
      environmentId: null,
      environmentName: null,
      keepTrace: false,
      lastRunAt: null,
      lastRunId: null,
    });
    expect(typeof cfg.body.schedule.nextRunAt).toBe("string");
    expect(Date.parse(cfg.body.schedule.nextRunAt)).toBeGreaterThan(Date.now());

    // Scheduling is operational metadata — it must NOT reversion the definition.
    const got = await authed(app).get(`/tests/${id}`).expect(200);
    expect(got.body.version).toBe(1);

    // The Tests list carries the compact "scheduled · next run" indicator.
    type Row = { id: string; schedule: { enabled: boolean; cron: string; nextRunAt: string | null } | null };
    const list = await authed(app).get("/tests").expect(200);
    const row = (list.body as Row[]).find((t) => t.id === id);
    expect(row?.schedule).toMatchObject({ enabled: true, cron: "0 2 * * *" });
    expect(typeof row?.schedule?.nextRunAt).toBe("string");
  });

  it("rejects an invalid cron (400) and an unknown environment (404) — neither persists", async () => {
    const id = await mkTest("guards");

    await authed(app).patch(`/tests/${id}`).send({ schedule: { cron: "not a cron" } }).expect(400);
    await authed(app)
      .patch(`/tests/${id}`)
      .send({ schedule: { cron: "0 2 * * *", environmentId: "00000000-0000-0000-0000-000000000000" } })
      .expect(404);

    // Fail-fast validation leaves no half-applied schedule.
    const cfg = await authed(app).get(`/tests/${id}/config`).expect(200);
    expect(cfg.body.schedule).toBeNull();
  });

  it("pins one environment (name resolved), keeps a disabled schedule's nextRunAt null, and clears with null", async () => {
    const id = await mkTest("staged");
    const env = await authed(app)
      .post("/environments")
      .send({ name: "staging", values: { baseUrl: "http://staging.local" } })
      .expect(201);
    const envId = env.body.id as string;

    // Disabled + env-pinned + keep-trace: persists, env name resolves, no next run while paused.
    await authed(app)
      .patch(`/tests/${id}`)
      .send({ schedule: { cron: "0 9 * * 1", environmentId: envId, enabled: false, keepTrace: true } })
      .expect(200);
    const cfg = await authed(app).get(`/tests/${id}/config`).expect(200);
    expect(cfg.body.schedule).toMatchObject({
      cron: "0 9 * * 1",
      enabled: false,
      environmentId: envId,
      environmentName: "staging",
      keepTrace: true,
    });
    expect(cfg.body.schedule.nextRunAt).toBeNull(); // disabled ⇒ nothing to fire

    // Clearing with null removes the schedule entirely.
    await authed(app).patch(`/tests/${id}`).send({ schedule: null }).expect(200);
    const after = await authed(app).get(`/tests/${id}/config`).expect(200);
    expect(after.body.schedule).toBeNull();
  });
});
