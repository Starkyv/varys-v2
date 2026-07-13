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
const TERMINAL = ["passed", "needs_review", "failed"];

interface Checkpoint {
  name: string;
  reviewState: string;
  diffScore: number | null;
  threshold: number;
  healed: boolean;
  actualUrl: string;
  baselineUrl: string | null;
  diffUrl: string | null;
}
interface RunView {
  status: string;
  error?: string | null;
  failedStepIndex?: number | null;
  steps?: { index: number; label: string }[];
  checkpoints: Checkpoint[];
}

describe("Baseline lifecycle", () => {
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
    await prepareAuth();

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

  async function runToCompletion(
    testId: string,
    environmentId?: string,
  ): Promise<RunView & { runId: string }> {
    const run = await authed(app)
      .post("/runs")
      .send({ testId, environmentId })
      .expect(201);
    const runId = run.body.runId as string;
    let body: RunView = { status: "queued", checkpoints: [] };
    for (let i = 0; i < 100; i++) {
      const res = await authed(app).get(`/runs/${runId}`);
      if (res.status !== 200) {
        throw new Error(
          `GET /runs/${runId} -> ${res.status}: ${res.text ?? JSON.stringify(res.body)}`,
        );
      }
      body = res.body;
      if (TERMINAL.includes(body.status)) break;
      await sleep(200);
    }
    return { runId, ...body };
  }

  async function createTest(): Promise<string> {
    const definition = {
      name: "baseline test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    };
    const res = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);
    return res.body.id;
  }

  // TB1 — a first run with no baseline seeds a pending baseline.
  it("a first run with no baseline yields a pending-baseline checkpoint", async () => {
    const definition = {
      name: "seed test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    };
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    const run = await runToCompletion(test.body.id);

    expect(run.status).toBe("needs_review");
    const cp = run.checkpoints[0];
    expect(cp).toMatchObject({ name: "hero", reviewState: "pending-baseline" });
    expect(cp.actualUrl).toEqual(expect.any(String));
    expect(cp.baselineUrl).toBeNull();
    expect(cp.diffUrl).toBeNull();
  });

  // TB2 — approving a seed makes it the active baseline; an identical re-run passes.
  it("an identical re-run passes once the seeded baseline is approved", async () => {
    const testId = await createTest();

    const seed = await runToCompletion(testId);
    expect(seed.checkpoints[0].reviewState).toBe("pending-baseline");

    await authed(app)
      .post(`/runs/${seed.runId}/checkpoints/hero/approve`)
      .expect(201);

    const rerun = await runToCompletion(testId);
    expect(rerun.status).toBe("passed");
    const cp = rerun.checkpoints[0];
    expect(cp.reviewState).toBe("passed");
    expect(cp.diffScore).toBe(0);
    expect(cp.baselineUrl).toEqual(expect.any(String));
  });

  // TB3 — a changed render diffs against the approved baseline.
  it("a changed render produces a diff against the approved baseline", async () => {
    fixture.setVariant("default");
    const testId = await createTest();

    const seed = await runToCompletion(testId);
    await authed(app)
      .post(`/runs/${seed.runId}/checkpoints/hero/approve`)
      .expect(201);

    fixture.setVariant("changed");
    const diffRun = await runToCompletion(testId);
    fixture.setVariant("default");

    expect(diffRun.status).toBe("needs_review");
    const cp = diffRun.checkpoints[0];
    expect(cp.reviewState).toBe("diff");
    expect(cp.diffScore).toBeGreaterThan(cp.threshold);
    expect(cp.diffUrl).toEqual(expect.any(String));
    expect(cp.baselineUrl).toEqual(expect.any(String));
  });

  async function decide(runId: string, action: "approve" | "reject") {
    await authed(app)
      .post(`/runs/${runId}/checkpoints/hero/${action}`)
      .expect(201);
  }

  // TB4a — approving a diff replaces the baseline (the changed render now passes).
  it("approving a diff replaces the active baseline", async () => {
    fixture.setVariant("default");
    const testId = await createTest();
    await decide((await runToCompletion(testId)).runId, "approve"); // seed → baseline=default

    fixture.setVariant("changed");
    const diffRun = await runToCompletion(testId);
    expect(diffRun.checkpoints[0].reviewState).toBe("diff");
    await decide(diffRun.runId, "approve"); // baseline := changed

    const after = await runToCompletion(testId); // changed vs changed → match
    expect(after.status).toBe("passed");
    expect(after.checkpoints[0].reviewState).toBe("passed");
    fixture.setVariant("default");
  });

  // TB4b — rejecting a diff leaves the baseline unchanged.
  it("rejecting a diff leaves the baseline unchanged", async () => {
    fixture.setVariant("default");
    const testId = await createTest();
    await decide((await runToCompletion(testId)).runId, "approve"); // baseline=default

    fixture.setVariant("changed");
    const diffRun = await runToCompletion(testId);
    expect(diffRun.checkpoints[0].reviewState).toBe("diff");
    await decide(diffRun.runId, "reject"); // baseline stays default

    fixture.setVariant("default");
    const after = await runToCompletion(testId); // default vs default → still matches
    expect(after.status).toBe("passed");
    expect(after.checkpoints[0].reviewState).toBe("passed");
  });

  // TB2b — the locator heals to a lower signal and flags it.
  it("flags a checkpoint as healed when the locator falls back to a lower signal", async () => {
    fixture.setVariant("default");
    // testId 'gone' isn't on the fixture, so resolution heals to the id signal.
    const definition = {
      name: "heal test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "hero",
          target: { tag: "div", testId: "gone", attributes: { id: "hero" }, text: "Hero" },
        },
      ],
    };
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    const run = await runToCompletion(test.body.id);
    expect(run.checkpoints[0].healed).toBe(true);
  });

  // TB2c — no signal matches → the run hard-fails.
  it("hard-fails the run when no fingerprint signal matches", async () => {
    fixture.setVariant("default");
    const definition = {
      name: "not-found test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "ghost",
          target: { tag: "div", attributes: { id: "does-not-exist" }, text: "Nope" },
        },
      ],
    };
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    const run = await runToCompletion(test.body.id);
    expect(run.status).toBe("failed");
    // The failure is attributed to the screenshot step (index 1, navigate is 0), and
    // the message names that step + carries the run's full step sequence for the viewer.
    expect(run.failedStepIndex).toBe(1);
    expect(run.error).toContain("Step 2/2");
    expect(run.error).toContain('checkpoint "ghost"');
    expect(run.steps).toHaveLength(2);
  });

  // Run against an environment: {{baseUrl}} resolves to the env's base URL; login uses literal
  // typed credentials (there are no variables/secrets — everything is a literal on the test).
  it("runs against an environment and logs in with literal credentials", async () => {
    fixture.setVariant("login");

    const env = await authed(app)
      .post("/environments")
      .send({ name: "demo", baseUrl: fixture.url })
      .expect(201);

    const definition = {
      name: "login flow",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "{{baseUrl}}" },
        { type: "type", target: { tag: "input", attributes: { id: "username" } }, value: "alice" },
        { type: "type", target: { tag: "input", attributes: { id: "password" } }, value: "s3cr3t" },
        { type: "click", target: { tag: "button", attributes: { id: "submit" } } },
        { type: "screenshot", name: "app", target: { tag: "div", attributes: { id: "app" } } },
      ],
    };
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    const run = await runToCompletion(test.body.id, env.body.id);
    fixture.setVariant("default");

    expect(run.status).toBe("needs_review");
    expect(run.checkpoints[0]).toMatchObject({ name: "app", reviewState: "pending-baseline" });
    expect(run.checkpoints[0].actualUrl).toEqual(expect.any(String));
  });

  // Slice 2 — per-environment baselines seed + approve INDEPENDENTLY, and approve
  // seeds under the run's OWN environment (the approve-env fix), not a hardcoded
  // "default". Both envs point {{baseUrl}} at the same fixture, so they render
  // identically — the only thing keeping their baselines apart is the env name.
  it("seeds and approves baselines per environment (the approve-env fix)", async () => {
    fixture.setVariant("default");

    const mkEnv = (name: string) =>
      authed(app)
        .post("/environments")
        .send({ name, baseUrl: fixture.url })
        .expect(201)
        .then((r) => r.body.id as string);
    const envA = await mkEnv("dev");
    const envB = await mkEnv("demo");

    const definition = {
      name: "per-env baseline",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "{{baseUrl}}" },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    };
    const test = await authed(app).post("/tests").send(definition).expect(201);
    const testId = test.body.id as string;
    const approveHero = (runId: string) =>
      authed(app).post(`/runs/${runId}/checkpoints/hero/approve`).expect(201);

    // Seed + approve against env A ("dev").
    const seedA = await runToCompletion(testId, envA);
    expect(seedA.checkpoints[0]).toMatchObject({ name: "hero", reviewState: "pending-baseline" });
    await approveHero(seedA.runId);

    // Approve-env fix: re-running against A passes — proving the baseline was seeded
    // under "dev" (before the fix it landed under "default", so A would re-seed).
    const rerunA = await runToCompletion(testId, envA);
    expect(rerunA.status).toBe("passed");
    expect(rerunA.checkpoints[0].reviewState).toBe("passed");

    // Independence: the first run against B ("demo") seeds its OWN pending baseline —
    // it does not match A's, even though the render is identical.
    const seedB = await runToCompletion(testId, envB);
    expect(seedB.checkpoints[0].reviewState).toBe("pending-baseline");
    await approveHero(seedB.runId);

    // Approving B leaves A untouched: A still passes against its own baseline.
    const rerunA2 = await runToCompletion(testId, envA);
    expect(rerunA2.checkpoints[0].reviewState).toBe("passed");
  });

  // Issue 5 TB1 — a fully-masked checkpoint never diffs, even when it changes.
  it("a fully-masked checkpoint does not diff even when it changes", async () => {
    fixture.setVariant("default");
    const definition = {
      name: "masked",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "hero",
          target: { tag: "div", attributes: { id: "hero" }, text: "Hero" },
          masks: [{ x: 0, y: 0, width: 10000, height: 10000 }],
        },
      ],
    };
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    await decide((await runToCompletion(test.body.id)).runId, "approve");

    fixture.setVariant("changed");
    const rerun = await runToCompletion(test.body.id);
    fixture.setVariant("default");

    expect(rerun.status).toBe("passed");
    expect(rerun.checkpoints[0].reviewState).toBe("passed");
  });

  // Slice 3 Issue 1 — full-page capture: seeds + diffs like an element checkpoint.
  it("a full-page checkpoint seeds a baseline and diffs against it", async () => {
    fixture.setVariant("default");
    const definition = {
      name: "full-page test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "screenshot", name: "page", captureMode: "fullpage" },
      ],
    };
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);
    const approvePage = (runId: string) =>
      authed(app)
        .post(`/runs/${runId}/checkpoints/page/approve`)
        .expect(201);

    const seed = await runToCompletion(test.body.id);
    expect(seed.checkpoints[0]).toMatchObject({ name: "page", reviewState: "pending-baseline" });
    expect(seed.checkpoints[0].actualUrl).toEqual(expect.any(String));
    await approvePage(seed.runId);

    const pass = await runToCompletion(test.body.id);
    expect(pass.checkpoints[0].reviewState).toBe("passed");

    fixture.setVariant("changed");
    const diff = await runToCompletion(test.body.id);
    fixture.setVariant("default");
    expect(diff.checkpoints[0].reviewState).toBe("diff");
  });

  // Slice 3 Issue 1 — region capture: a clipped rect seeds + diffs like an element.
  it("a region checkpoint seeds a baseline and diffs against it", async () => {
    fixture.setVariant("default");
    const definition = {
      name: "region test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "area",
          captureMode: "region",
          rect: { x: 24, y: 24, width: 240, height: 120 }, // the #hero box
        },
      ],
    };
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);
    const approveArea = (runId: string) =>
      authed(app)
        .post(`/runs/${runId}/checkpoints/area/approve`)
        .expect(201);

    const seed = await runToCompletion(test.body.id);
    expect(seed.checkpoints[0]).toMatchObject({ name: "area", reviewState: "pending-baseline" });
    await approveArea(seed.runId);

    const pass = await runToCompletion(test.body.id);
    expect(pass.checkpoints[0].reviewState).toBe("passed");

    fixture.setVariant("changed");
    const diff = await runToCompletion(test.body.id);
    fixture.setVariant("default");
    expect(diff.checkpoints[0].reviewState).toBe("diff");
  });

  // Issue 5 TB2 — a wait makes a deferred element available before the screenshot.
  it("waits for a deferred element before screenshotting", async () => {
    fixture.setVariant("deferred");
    const definition = {
      name: "wait test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "hero",
          target: { tag: "div", attributes: { id: "hero" }, text: "Hero" },
          waitBefore: [
            { kind: "selector", target: { tag: "div", attributes: { id: "hero" } }, state: "visible" },
          ],
        },
      ],
    };
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    const run = await runToCompletion(test.body.id);
    fixture.setVariant("default");

    expect(run.status).toBe("needs_review");
    expect(run.checkpoints[0].reviewState).toBe("pending-baseline");
  });
});
