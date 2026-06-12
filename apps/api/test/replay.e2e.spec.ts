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
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function binaryParser(
  res: NodeJS.ReadableStream,
  cb: (err: Error | null, body: Buffer) => void,
) {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

describe("Replay → screenshot → artifact", () => {
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

  // TB3 — the full thread: replay the fixture, screenshot the element, serve it.
  it("a completed run exposes a stored screenshot of the element", async () => {
    const definition = {
      name: "hero shot",
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

    let body: { status: string; checkpoints?: Array<{ name: string; status: string; artifactUrl: string }> } = {
      status: "queued",
    };
    for (let i = 0; i < 100; i++) {
      const res = await request(app.getHttpServer())
        .get(`/runs/${run.body.runId}`)
        .expect(200);
      body = res.body;
      if (body.status === "passed" || body.status === "failed") break;
      await sleep(200);
    }

    expect(body.status).toBe("passed");

    const checkpoint = body.checkpoints?.[0];
    expect(checkpoint).toMatchObject({ name: "hero", status: "passed" });
    expect(checkpoint?.artifactUrl).toEqual(expect.any(String));

    const img = await request(app.getHttpServer())
      .get(checkpoint!.artifactUrl)
      .buffer()
      .parse(binaryParser as never)
      .expect(200)
      .expect("content-type", /image\/png/);

    expect((img.body as Buffer).subarray(0, 8)).toEqual(PNG_MAGIC);
  });
});
