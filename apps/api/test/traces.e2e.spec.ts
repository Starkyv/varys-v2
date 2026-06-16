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
import { authed, prepareAuth } from "./auth-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Slice 9 Issue 1 — the trace guarantees worth pinning (everything else is
 * manual-verified, per direction). Chromium is unavoidable here: the subject IS
 * replay behavior. Traces are PER-TRIGGER ON DEMAND — kept only when asked for,
 * but then on every outcome incl. failure; the kept zip downloads through the
 * (CORS-enabled) artifacts route so the hosted Trace Viewer can fetch it.
 */
describe("Trace capture API", () => {
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) => processRun({ db: consumerDb.db, storage }, runId));
  });

  afterAll(async () => {
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  type Step = {
    index: number;
    label: string;
    checkpointName: string | null;
    startedAt: string;
    durationMs: number;
    outcome: "passed" | "failed";
  };
  type RunBody = { status: string; traceUrl: string | null; timeline: Step[] };

  // The per-step timeline (Issue 2) is recorded for EVERY run, traced or not:
  // executed steps in order, with timing present and monotonic start times.
  const assertTimelineSane = (timeline: Step[]): void => {
    expect(timeline.length).toBeGreaterThan(0);
    timeline.forEach((s, i) => {
      expect(s.index).toBe(timeline[i].index);
      expect(typeof s.durationMs).toBe("number");
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(new Date(s.startedAt).getTime()).toBeGreaterThanOrEqual(
          new Date(timeline[i - 1].startedAt).getTime(),
        );
      }
    });
  };

  const pollRun = async (runId: string): Promise<RunBody> => {
    for (let i = 0; i < 100; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      const body = res.body as RunBody;
      if (["passed", "needs_review", "failed"].includes(body.status)) return body;
      await sleep(200);
    }
    throw new Error(`run ${runId} never reached a terminal status`);
  };

  const mkTest = async (steps: unknown[], name: string): Promise<string> => {
    const definition = { name, viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, steps };
    const res = await authed(app).post("/tests").send(definition).expect(201);
    return res.body.id as string;
  };

  const passingSteps = (): unknown[] => [
    { type: "navigate", url: fixture.url },
    { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
  ];

  it("keeps a trace when asked, downloadable as a non-empty zip with CORS allowed", async () => {
    const testId = await mkTest(passingSteps(), "traced-run");
    const created = await authed(app)
      .post("/runs")
      .send({ testId, trace: true })
      .expect(201);
    const body = await pollRun(created.body.runId as string);

    expect(body.status).toBe("needs_review"); // first run seeds a baseline
    expect(typeof body.traceUrl).toBe("string");

    // The step timeline records both executed steps (navigate + screenshot).
    assertTimelineSane(body.timeline);
    expect(body.timeline.map((s) => s.outcome)).toEqual(["passed", "passed"]);
    expect(body.timeline[1].checkpointName).toBe("hero"); // screenshot step joins to its checkpoint

    // The hosted-viewer contract: the artifact downloads with permissive CORS,
    // and it's a real (PK-magic) non-empty zip.
    const dl = await authed(app)
      .get(body.traceUrl as string)
      .buffer(true)
      .expect(200);
    expect(dl.headers["access-control-allow-origin"]).toBe("*");
    const zip = dl.body as Buffer;
    expect(zip.length).toBeGreaterThan(0);
    expect(zip.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("keeps no trace when the trigger didn't ask (null traceUrl, nothing stored)", async () => {
    const testId = await mkTest(passingSteps(), "untraced-run");
    const created = await authed(app)
      .post("/runs")
      .send({ testId })
      .expect(201);
    const body = await pollRun(created.body.runId as string);

    expect(body.status).toBe("needs_review");
    expect(body.traceUrl).toBeNull();
    // The timeline is unconditional — recorded even without a trace.
    assertTimelineSane(body.timeline);
    expect(body.timeline).toHaveLength(2);
  });

  it("keeps the trace even when the run fails (where it's most useful)", async () => {
    // No environment ⇒ "{{baseUrl}}" never resolves ⇒ the first navigate throws.
    const testId = await mkTest(
      [
        { type: "navigate", url: "{{baseUrl}}/" },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" } } },
      ],
      "traced-failure",
    );
    const created = await authed(app)
      .post("/runs")
      .send({ testId, trace: true })
      .expect(201);
    const body = await pollRun(created.body.runId as string);

    expect(body.status).toBe("failed");
    expect(typeof body.traceUrl).toBe("string");
    const dl = await authed(app)
      .get(body.traceUrl as string)
      .buffer(true)
      .expect(200);
    expect((dl.body as Buffer).length).toBeGreaterThan(0);

    // The failing step (the unresolved navigate, index 0) is marked in the timeline.
    assertTimelineSane(body.timeline);
    const failed = body.timeline.find((s) => s.outcome === "failed");
    expect(failed?.index).toBe(0);
  });
});
