import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Runs API", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) =>
      processRun({ db: consumerDb.db, storage }, runId),
    );
  });

  afterAll(async () => {
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  // TB2 — a triggered run reaches a terminal status (queue → worker → status).
  it("a triggered run eventually reaches a terminal status", async () => {
    const definition = {
      name: "run smoke",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    };

    const test = await request(app.getHttpServer())
      .post("/tests")
      .send(definition)
      .expect(201);

    const run = await request(app.getHttpServer())
      .post("/runs")
      .send({ testId: test.body.id })
      .expect(201);

    expect(run.body.runId).toEqual(expect.any(String));

    let status = "queued";
    for (let i = 0; i < 100; i++) {
      const res = await request(app.getHttpServer())
        .get(`/runs/${run.body.runId}`)
        .expect(200);
      status = res.body.status;
      if (status === "passed" || status === "needs_review" || status === "failed") break;
      await sleep(200);
    }

    // A first run with no baseline seeds a pending baseline → needs_review.
    expect(status).toBe("needs_review");
  });

  // Visual-review-ui Issue 1 TB1 — the read-model carries the reviewer's identifying context.
  it("the run read-model carries test name, environment, and run timestamp", async () => {
    const definition = {
      name: "read-model test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    };
    const test = await request(app.getHttpServer())
      .post("/tests")
      .send(definition)
      .expect(201);

    const created = await request(app.getHttpServer())
      .post("/runs")
      .send({ testId: test.body.id })
      .expect(201);
    const runId = created.body.runId as string;

    let body: { status: string; [k: string]: unknown } = { status: "queued" };
    for (let i = 0; i < 100; i++) {
      const res = await request(app.getHttpServer()).get(`/runs/${runId}`).expect(200);
      body = res.body;
      if (["passed", "needs_review", "failed"].includes(body.status)) break;
      await sleep(200);
    }

    expect(body.runId).toBe(runId);
    expect(body.testName).toBe("read-model test");
    expect(body.environment).toBe("default");
    expect(Number.isNaN(Date.parse(body.runTimestamp as string))).toBe(false);
  });

  // visual-review-ui Issue 3 TB1 — the read-model reports a checkpoint's audited
  // decision, so the review UI can show "already decided" instead of a stale approve.
  it("reports a checkpoint's resolution after a decision", async () => {
    const definition = {
      name: "resolution test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    };
    const test = await request(app.getHttpServer())
      .post("/tests")
      .send(definition)
      .expect(201);

    const created = await request(app.getHttpServer())
      .post("/runs")
      .send({ testId: test.body.id })
      .expect(201);
    const runId = created.body.runId as string;

    let body: { status: string; checkpoints: { resolution: string | null }[] } = {
      status: "queued",
      checkpoints: [],
    };
    for (let i = 0; i < 100; i++) {
      const res = await request(app.getHttpServer()).get(`/runs/${runId}`).expect(200);
      body = res.body;
      if (["passed", "needs_review", "failed"].includes(body.status)) break;
      await sleep(200);
    }

    // Undecided checkpoints report a null resolution...
    expect(body.checkpoints[0].resolution).toBeNull();

    await request(app.getHttpServer())
      .post(`/runs/${runId}/checkpoints/hero/approve`)
      .expect(201);

    // ...and the recorded decision afterwards.
    const after = await request(app.getHttpServer()).get(`/runs/${runId}`).expect(200);
    expect(after.body.checkpoints[0].resolution).toBe("approved");
  });
});
