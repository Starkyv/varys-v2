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
import type { RunNetworkEvent, RunView } from "@varys/review-contract";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { authed, prepareAuth } from "./auth-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The API-status record on a run (capture + display).
 *
 * What it is for: a step whose element never rendered because its data call failed is recorded
 * as `failureKind: "locator"` — the exception type is identical to a renamed button's, so the
 * label alone sends a reader to edit selectors for a backend fault. These tests drive that exact
 * confusion against the fixture and assert the run now carries the evidence that resolves it.
 *
 * They also pin the promise that this is capture and display ONLY: the run's status, its
 * `failureKind` and the repair queue are all untouched by what the network record contains.
 */
describe("Run network capture", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-net-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    // The failure under test IS a locator that never resolves, and the default patient resolve
    // is 30s per attempt. Shorten it so each red run costs seconds; the classification path
    // being exercised is identical either way.
    process.env.VARYS_ACTION_TIMEOUT_MS = "3000";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) => processRun({ db: consumerDb.db, storage }, runId));
  }, 120_000);

  afterAll(async () => {
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  /**
   * Click "Load rows", then act on the `#rows` element the click's data call renders. Under
   * `apiHealthy` it passes; under `apiDown` / `apiHang` the element is absent and step 2 fails as
   * an unresolved locator — while the request that actually broke it belongs to step 1.
   */
  function definition(name: string) {
    return {
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "click", target: { tag: "button", attributes: { id: "load" }, testId: "load" } },
        {
          type: "screenshot",
          name: "rows",
          target: { tag: "div", attributes: { id: "rows" }, testId: "rows" },
        },
      ],
    };
  }

  async function runToCompletion(testId: string): Promise<RunView> {
    const run = await authed(app).post("/runs").send({ testId }).expect(201);
    for (let i = 0; i < 400; i++) {
      const res = await authed(app).get(`/runs/${run.body.runId}`).expect(200);
      const body = res.body as RunView;
      if (["passed", "needs_review", "failed"].includes(body.status)) return body;
      await sleep(200);
    }
    throw new Error("run did not finish");
  }

  async function createTest(name: string): Promise<string> {
    const res = await authed(app).post("/tests").send(definition(name)).expect(201);
    return res.body.id as string;
  }

  const problems = (events: RunNetworkEvent[]) =>
    events.filter((e) => e.failureText !== null || (e.status !== null && e.status >= 400));

  it("records the failed request on a run that reads as a locator failure", async () => {
    fixture.setVariant("apiDown");
    const view = await runToCompletion(await createTest("api down"));

    // The misreport this feature exists for: the element is missing, so the run is classified
    // by the only thing the matcher can see.
    expect(view.status).toBe("failed");
    expect(view.failureKind).toBe("locator");

    const failed = problems(view.network);
    expect(failed.length).toBeGreaterThan(0);
    const rows = failed.find((e) => e.url.includes("/api/rows"));
    expect(rows).toBeDefined();
    expect(rows).toMatchObject({ status: 500, method: "GET", failureText: null });
    expect(rows?.durationMs).toBeGreaterThanOrEqual(0);

    // Attributed to the CLICK (step 1) that fired it — not to step 2, which is the step that
    // failed. The two being different steps is the ordinary shape of a data-caused failure, and
    // the reason the run-level alert rather than a per-step one makes the causal suggestion.
    expect(rows?.stepIndex).toBe(1);
    expect(view.failedStepIndex).toBe(2);
  }, 120_000);

  it("records a request the server never answered, which is what an API timeout looks like", async () => {
    fixture.setVariant("apiHang");
    const view = await runToCompletion(await createTest("api hang"));

    expect(view.status).toBe("failed");
    const unanswered = view.network.find((e) => e.url.includes("/api/rows"));
    expect(unanswered).toBeDefined();
    // No status and no transport error — the request was simply still outstanding. Without the
    // end-of-run flush this row would not exist at all, which is precisely the case that matters.
    expect(unanswered?.status).toBeNull();
    expect(unanswered?.failureText).toMatch(/no response/i);
  }, 120_000);

  it("keeps a healthy run's record quiet — no problems, and the run is unaffected", async () => {
    fixture.setVariant("apiHealthy");
    const view = await runToCompletion(await createTest("api healthy"));

    // pending-baseline: the checkpoint captured for the first time. The point is that it got
    // there at all — the element rendered because its data call answered.
    expect(view.status).toBe("needs_review");
    expect(problems(view.network)).toHaveLength(0);
    // The successful call is still recorded (it is under the slow-success cap), so "quiet" means
    // no problems, not no record.
    expect(view.network.some((e) => e.url.includes("/api/rows") && e.status === 200)).toBe(true);
  }, 120_000);

  it("does not change how a failure is classified or queued", async () => {
    fixture.setVariant("apiDown");
    const testId = await createTest("api down — classification");
    const view = await runToCompletion(testId);

    // Capture and display only. A failed data call is evidence for a reader; it does not
    // re-label the run, and it must not quietly divert it out of the repair path either.
    expect(view.failureKind).toBe("locator");
    expect(problems(view.network).length).toBeGreaterThan(0);

    // The repair affordance keys on `failureKind === "locator"`, so it is still offered.
    const queue = await authed(app).get("/repair-jobs").expect(200);
    expect(Array.isArray(queue.body)).toBe(true);
  }, 120_000);

  it("purges the record with the run", async () => {
    fixture.setVariant("apiDown");
    const view = await runToCompletion(await createTest("api down — purge"));
    expect(problems(view.network).length).toBeGreaterThan(0);

    await authed(app).delete(`/runs/${view.runId}`).expect(200);
    // The FK to runs(id) is not cascading, so a run delete that forgot this table would have
    // failed here rather than leaving orphans.
    await authed(app).get(`/runs/${view.runId}`).expect(404);
  }, 120_000);

  it("purges the record when the whole TEST is deleted", async () => {
    // The second, easier-to-miss purge path: deleting a test walks version → run → artifact and
    // must take this table with it. Same non-cascading FK, so an omission is an outright failure
    // to delete the test rather than a silent orphan.
    fixture.setVariant("apiDown");
    const testId = await createTest("api down — test purge");
    const view = await runToCompletion(testId);
    expect(problems(view.network).length).toBeGreaterThan(0);

    await authed(app).delete(`/tests/${testId}`).expect(200);
    await authed(app).get(`/tests/${testId}`).expect(404);
  }, 120_000);
});
