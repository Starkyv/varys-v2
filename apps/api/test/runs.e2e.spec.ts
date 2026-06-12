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
        { type: "screenshot", name: "hero", selector: "#hero" },
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
});
