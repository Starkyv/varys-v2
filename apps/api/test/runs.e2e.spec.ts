import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { baselines, createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { eq } from "drizzle-orm";
import request from "supertest";
import { authed, authEmail, prepareAuth } from "./auth-harness";
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

    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    const run = await authed(app)
      .post("/runs")
      .send({ testId: test.body.id })
      .expect(201);

    expect(run.body.runId).toEqual(expect.any(String));

    let status = "queued";
    for (let i = 0; i < 100; i++) {
      const res = await authed(app)
        .get(`/runs/${run.body.runId}`)
        .expect(200);
      status = res.body.status;
      if (status === "passed" || status === "needs_review" || status === "failed") break;
      await sleep(200);
    }

    // A first run with no baseline seeds a pending baseline → needs_review.
    expect(status).toBe("needs_review");
  });

  // A run whose replay errors is marked failed AND records why, so the viewer can
  // show the reason instead of a blank screen (a failed run captures no checkpoints).
  // Here {{baseUrl}} is never resolved (no environment), so the first navigate throws.
  it("a run that errors during replay is failed with a recorded error and no checkpoints", async () => {
    const definition = {
      name: "unresolved-baseurl test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "{{baseUrl}}/" },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" } } },
      ],
    };
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    const created = await authed(app)
      .post("/runs")
      .send({ testId: test.body.id })
      .expect(201);
    const runId = created.body.runId as string;

    let body: { status: string; error?: string | null; checkpoints: unknown[] } = {
      status: "queued",
      checkpoints: [],
    };
    for (let i = 0; i < 100; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      body = res.body;
      if (["passed", "needs_review", "failed"].includes(body.status)) break;
      await sleep(200);
    }

    expect(body.status).toBe("failed");
    expect(typeof body.error).toBe("string");
    expect((body.error ?? "").length).toBeGreaterThan(0);
    expect(body.checkpoints).toHaveLength(0);
  });

  // Multi-checkpoint slice Issue 2 — one bulk approve resolves a whole run's
  // needs-review checkpoints (audited per baseline), and leaves already-decided
  // checkpoints untouched (not re-approved, not re-counted).
  it("resolves a multi-checkpoint run with one bulk approve, leaving decided ones untouched", async () => {
    const target = { tag: "div", attributes: { id: "hero" }, text: "Hero" };
    const definition = {
      name: "bulk approve test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "screenshot", name: "alpha", target },
        { type: "screenshot", name: "beta", target },
      ],
    };
    const test = await authed(app).post("/tests").send(definition).expect(201);
    const testId = test.body.id as string;

    const created = await authed(app)
      .post("/runs")
      .send({ testId })
      .expect(201);
    const runId = created.body.runId as string;

    let body: { status: string; checkpoints: { name: string; resolution: string | null }[] } = {
      status: "queued",
      checkpoints: [],
    };
    for (let i = 0; i < 100; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      body = res.body;
      if (["passed", "needs_review", "failed"].includes(body.status)) break;
      await sleep(200);
    }
    expect(body.status).toBe("needs_review");
    expect(body.checkpoints).toHaveLength(2);

    // Decide one individually first; bulk approve must skip it.
    await authed(app)
      .post(`/runs/${runId}/checkpoints/alpha/approve`)
      .expect(201);

    const bulk = await authed(app).post(`/runs/${runId}/approve-all`).expect(201);
    expect(bulk.body.approved).toBe(1); // only beta still needed review

    // Both checkpoints are now approved.
    const after = await authed(app).get(`/runs/${runId}`).expect(200);
    const byName = Object.fromEntries(
      (after.body.checkpoints as { name: string; resolution: string | null }[]).map((c) => [
        c.name,
        c.resolution,
      ]),
    );
    expect(byName.alpha).toBe("approved");
    expect(byName.beta).toBe("approved");

    // The run leaves the needs-review list.
    const list = await authed(app).get("/runs/needs-review").expect(200);
    expect((list.body as { runId: string }[]).some((i) => i.runId === runId)).toBe(false);

    // Each baseline is audited with approver + timestamp.
    const seeded = await consumerDb.db
      .select()
      .from(baselines)
      .where(eq(baselines.testId, testId));
    expect(seeded).toHaveLength(2);
    for (const b of seeded) {
      expect(b.approvedBy).toBe(authEmail());
      expect(b.approvedAt).not.toBeNull();
    }
  });

  // Multi-checkpoint slice Issue 4 — in-viewer mask persist. A drawn mask is
  // re-evaluated against the STORED baseline+actual (no re-run); persisting writes
  // a new test_version and re-judges only this checkpoint; later runs honor the
  // masks; other historical runs are untouched.
  it("persisted masks re-judge the checkpoint, are honored by later runs, and leave other runs untouched", async () => {
    type Cp = { name: string; reviewState: string; resolution: string | null; masks: unknown[] };
    type Body = { status: string; checkpoints: Cp[] };
    const hero = (b: Body) => b.checkpoints.find((c) => c.name === "hero") as Cp;
    const poll = async (runId: string): Promise<Body> => {
      for (let i = 0; i < 100; i++) {
        const res = await authed(app).get(`/runs/${runId}`).expect(200);
        if (["passed", "needs_review", "failed"].includes(res.body.status)) return res.body as Body;
        await sleep(200);
      }
      throw new Error("run did not reach a terminal status");
    };

    fixture.setVariant("default");
    const definition = {
      name: "mask persist test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "hero",
          target: { tag: "div", attributes: { id: "hero" }, text: "Hero" },
        },
      ],
    };
    const test = await authed(app).post("/tests").send(definition).expect(201);
    const testId = test.body.id as string;

    // Run 1 — seed the baseline (blue) and approve it.
    const r1 = await authed(app).post("/runs").send({ testId }).expect(201);
    const run1 = r1.body.runId as string;
    await poll(run1);
    await authed(app)
      .post(`/runs/${run1}/checkpoints/hero/approve`)
      .expect(201);

    // Run 2 — the element changes colour → a real diff.
    fixture.setVariant("changed");
    const r2 = await authed(app).post("/runs").send({ testId }).expect(201);
    const run2 = r2.body.runId as string;
    const before = await poll(run2);
    expect(hero(before).reviewState).toBe("diff");
    expect(hero(before).masks).toHaveLength(0);

    // The fixture changes the whole element, so a full-cover mask neutralises it.
    // Oversized rect is fine — the diff-engine clamps masks to the image bounds.
    const masks = [{ x: 0, y: 0, width: 300, height: 200 }];

    // Re-evaluate (preview): matches now, but mutates nothing.
    const preview = await authed(app)
      .post(`/runs/${run2}/checkpoints/hero/re-evaluate`)
      .send({ masks })
      .expect(201);
    expect(preview.body.verdict).toBe("match");
    expect(typeof preview.body.diffImage).toBe("string");
    const unchanged = await authed(app).get(`/runs/${run2}`).expect(200);
    expect(hero(unchanged.body as Body).reviewState).toBe("diff"); // preview did not persist

    // Persist: re-judges this checkpoint to passed and writes a new version.
    const persisted = await authed(app)
      .post(`/runs/${run2}/checkpoints/hero/persist`)
      .send({ masks })
      .expect(201);
    expect(persisted.body.reviewState).toBe("passed");
    expect(persisted.body.version).toBe(2);

    // run2 is now passed, exposes the persisted mask, and left the needs-review list.
    const after = await authed(app).get(`/runs/${run2}`).expect(200);
    expect(hero(after.body as Body).reviewState).toBe("passed");
    expect(hero(after.body as Body).masks).toHaveLength(1);
    const list = await authed(app).get("/runs/needs-review").expect(200);
    expect(
      (list.body as { runId: string; checkpointName: string }[]).some(
        (i) => i.runId === run2 && i.checkpointName === "hero",
      ),
    ).toBe(false);

    // Run 3 — still the changed colour, but the persisted mask is honored → passes.
    const r3 = await authed(app).post("/runs").send({ testId }).expect(201);
    const run3 = r3.body.runId as string;
    const third = await poll(run3);
    expect(third.status).toBe("passed");
    expect(hero(third).reviewState).toBe("passed");

    // Run 1's verdict is untouched by the persist.
    const firstAgain = await authed(app).get(`/runs/${run1}`).expect(200);
    expect(hero(firstAgain.body as Body).resolution).toBe("approved");

    fixture.setVariant("default");
  });

  // Multi-checkpoint slice Issue 5 — in-viewer threshold tuning. Persisting a
  // threshold (no masks) re-judges this checkpoint and is honored by later runs:
  // a diff that the default threshold rejects passes under the persisted one.
  it("persists a threshold that re-judges the checkpoint and is honored by a later run", async () => {
    type Cp = { name: string; reviewState: string };
    type Body = { status: string; checkpoints: Cp[] };
    const hero = (b: Body) => b.checkpoints.find((c) => c.name === "hero") as Cp;
    const poll = async (runId: string): Promise<Body> => {
      for (let i = 0; i < 100; i++) {
        const res = await authed(app).get(`/runs/${runId}`).expect(200);
        if (["passed", "needs_review", "failed"].includes(res.body.status)) return res.body as Body;
        await sleep(200);
      }
      throw new Error("run did not reach a terminal status");
    };

    fixture.setVariant("default");
    const definition = {
      name: "threshold tuning test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "hero",
          target: { tag: "div", attributes: { id: "hero" }, text: "Hero" },
        },
      ],
    };
    const test = await authed(app).post("/tests").send(definition).expect(201);
    const testId = test.body.id as string;

    // Seed (blue) + approve.
    const r1 = await authed(app).post("/runs").send({ testId }).expect(201);
    await poll(r1.body.runId as string);
    await authed(app)
      .post(`/runs/${r1.body.runId}/checkpoints/hero/approve`)
      .expect(201);

    // Recolour → diff under the default threshold.
    fixture.setVariant("changed");
    const r2 = await authed(app).post("/runs").send({ testId }).expect(201);
    const run2 = r2.body.runId as string;
    expect(hero(await poll(run2)).reviewState).toBe("diff");

    // Persist a permissive threshold (admits any diff) — re-judges this checkpoint to passed.
    const persisted = await authed(app)
      .post(`/runs/${run2}/checkpoints/hero/persist`)
      .send({ threshold: 1 })
      .expect(201);
    expect(persisted.body.reviewState).toBe("passed");

    // A later run honors the persisted threshold: the same colour change now passes
    // (it would be needs_review under the default threshold).
    const r3 = await authed(app).post("/runs").send({ testId }).expect(201);
    const third = await poll(r3.body.runId as string);
    expect(third.status).toBe("passed");
    expect(hero(third).reviewState).toBe("passed");

    fixture.setVariant("default");
  });

  // Multi-checkpoint slice Issue 3 — recorder masking. A mask recorded onto the
  // screenshot step (in screenshot-pixel space) suppresses a volatile sub-region:
  // the same change that makes an unmasked checkpoint diff leaves a masked one clean.
  it("honors recorded masks: a masked volatile sub-region does not diff (unmasked does)", async () => {
    type Body = { status: string };
    const poll = async (runId: string): Promise<Body> => {
      for (let i = 0; i < 100; i++) {
        const res = await authed(app).get(`/runs/${runId}`).expect(200);
        if (["passed", "needs_review", "failed"].includes(res.body.status)) return res.body as Body;
        await sleep(200);
      }
      throw new Error("run did not reach a terminal status");
    };
    const target = { tag: "div", attributes: { id: "hero" }, text: "Hero" };
    // The volatile sub-region (#stamp) sits at the element's top-left, 80×30 (DPR 1).
    const stampMask = { x: 0, y: 0, width: 80, height: 30 };

    const seedRunApprove = async (testId: string) => {
      const r = await authed(app).post("/runs").send({ testId }).expect(201);
      await poll(r.body.runId as string);
      await authed(app)
        .post(`/runs/${r.body.runId}/checkpoints/hero/approve`)
        .expect(201);
    };

    // Masked checkpoint and an unmasked control, both seeded on stampA (green stamp).
    fixture.setVariant("stampA");
    const masked = await authed(app)
      .post("/tests")
      .send({
        name: "masked stamp",
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        steps: [
          { type: "navigate", url: fixture.url },
          { type: "screenshot", name: "hero", target, masks: [stampMask] },
        ],
      })
      .expect(201);
    const control = await authed(app)
      .post("/tests")
      .send({
        name: "unmasked stamp",
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        steps: [
          { type: "navigate", url: fixture.url },
          { type: "screenshot", name: "hero", target },
        ],
      })
      .expect(201);
    await seedRunApprove(masked.body.id as string);
    await seedRunApprove(control.body.id as string);

    // stampB recolours ONLY the stamp sub-region.
    fixture.setVariant("stampB");
    const maskedRun = await authed(app)
      .post("/runs")
      .send({ testId: masked.body.id })
      .expect(201);
    const controlRun = await authed(app)
      .post("/runs")
      .send({ testId: control.body.id })
      .expect(201);

    // The mask hides the changed region → passes; the control sees it → needs review.
    expect((await poll(maskedRun.body.runId as string)).status).toBe("passed");
    expect((await poll(controlRun.body.runId as string)).status).toBe("needs_review");

    fixture.setVariant("default");
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
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    const created = await authed(app)
      .post("/runs")
      .send({ testId: test.body.id })
      .expect(201);
    const runId = created.body.runId as string;

    let body: { status: string; [k: string]: unknown } = { status: "queued" };
    for (let i = 0; i < 100; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      body = res.body;
      if (["passed", "needs_review", "failed"].includes(body.status)) break;
      await sleep(200);
    }

    expect(body.runId).toBe(runId);
    expect(body.testName).toBe("read-model test");
    expect(body.environment).toBe("default");
    expect(Number.isNaN(Date.parse(body.runTimestamp as string))).toBe(false);
    // captureMode surfaces in the read-model, defaulting to element for back-compat.
    expect((body.checkpoints as { captureMode: string }[])[0].captureMode).toBe("element");
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
    const test = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    const created = await authed(app)
      .post("/runs")
      .send({ testId: test.body.id })
      .expect(201);
    const runId = created.body.runId as string;

    let body: { status: string; checkpoints: { resolution: string | null }[] } = {
      status: "queued",
      checkpoints: [],
    };
    for (let i = 0; i < 100; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      body = res.body;
      if (["passed", "needs_review", "failed"].includes(body.status)) break;
      await sleep(200);
    }

    // Undecided checkpoints report a null resolution...
    expect(body.checkpoints[0].resolution).toBeNull();

    await authed(app)
      .post(`/runs/${runId}/checkpoints/hero/approve`)
      .expect(201);

    // ...and the recorded decision afterwards.
    const after = await authed(app).get(`/runs/${runId}`).expect(200);
    expect(after.body.checkpoints[0].resolution).toBe("approved");
  });

  // visual-review-ui Issue 4 TB1 — the needs-review list returns unresolved
  // checkpoints with the read-model context, and drops them once decided.
  it("lists checkpoints needing review and excludes resolved ones", async () => {
    const definition = {
      name: "needs-review test",
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

    const created = await authed(app)
      .post("/runs")
      .send({ testId: test.body.id })
      .expect(201);
    const runId = created.body.runId as string;
    for (let i = 0; i < 100; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      if (["passed", "needs_review", "failed"].includes(res.body.status)) break;
      await sleep(200);
    }

    type Item = {
      runId: string;
      testName: string;
      environment: string;
      runTimestamp: string;
      checkpointName: string;
      reviewState: string;
    };
    const listed = await authed(app).get("/runs/needs-review").expect(200);
    const mine = (listed.body as Item[]).find((i) => i.runId === runId);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      testName: "needs-review test",
      environment: "default",
      checkpointName: "hero",
      reviewState: "pending-baseline",
    });
    expect(Number.isNaN(Date.parse(mine?.runTimestamp ?? "x"))).toBe(false);

    // Decide it → it leaves the list.
    await authed(app)
      .post(`/runs/${runId}/checkpoints/hero/approve`)
      .expect(201);
    const after = await authed(app).get("/runs/needs-review").expect(200);
    expect((after.body as Item[]).find((i) => i.runId === runId)).toBeUndefined();
  });

  // The Runs history lists every run (all outcomes) with its identifying context —
  // unlike needs-review, it keeps a run after it's resolved / passed / failed.
  it("lists runs in the history regardless of outcome", async () => {
    const definition = {
      name: "history test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    };
    const test = await authed(app).post("/tests").send(definition).expect(201);
    const created = await authed(app)
      .post("/runs")
      .send({ testId: test.body.id })
      .expect(201);
    const runId = created.body.runId as string;

    // Wait for it to reach a terminal status.
    for (let i = 0; i < 100; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      if (["passed", "needs_review", "failed"].includes(res.body.status)) break;
      await sleep(200);
    }

    type Row = {
      runId: string;
      testName: string;
      environment: string;
      status: string;
      runTimestamp: string;
      error: string | null;
    };
    const listed = await authed(app).get("/runs").expect(200);
    const mine = (listed.body as Row[]).find((r) => r.runId === runId);
    expect(mine).toMatchObject({
      testName: "history test",
      environment: "default",
      status: "needs_review",
    });
    expect(Number.isNaN(Date.parse(mine?.runTimestamp ?? "x"))).toBe(false);

    // Resolving it does NOT remove it from the history (unlike needs-review).
    await authed(app)
      .post(`/runs/${runId}/checkpoints/hero/approve`)
      .expect(201);
    const after = await authed(app).get("/runs").expect(200);
    expect((after.body as Row[]).find((r) => r.runId === runId)).toBeDefined();
  });

  // Slice 17.4 — a PASSING checkpoint can be promoted to a new baseline (re-anchor the
  // golden to this run's capture); a passing checkpoint cannot be rejected; and after the
  // re-baseline the run's derived outcome reads "baseline".
  it("re-baselines a passing checkpoint: approve replaces the golden + deletes the old blob, reject is refused, outcome becomes baseline", async () => {
    const definition = {
      name: "re-baseline test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    };
    const test = await authed(app).post("/tests").send(definition).expect(201);
    const testId = test.body.id as string;

    const driveToTerminal = async (runId: string) => {
      for (let i = 0; i < 100; i++) {
        const res = await authed(app).get(`/runs/${runId}`).expect(200);
        if (["passed", "needs_review", "failed"].includes(res.body.status)) return res.body;
        await sleep(200);
      }
      throw new Error(`run ${runId} never reached a terminal status`);
    };

    // Run 1 seeds a pending baseline; approving it makes run 1's actual the golden.
    const run1 = await authed(app).post("/runs").send({ testId }).expect(201);
    const body1 = await driveToTerminal(run1.body.runId);
    expect(body1.status).toBe("needs_review");
    expect(body1.outcome).toBe("pending-baseline"); // first run = awaiting approval, not a failure
    await authed(app).post(`/runs/${run1.body.runId}/checkpoints/hero/approve`).expect(201);

    const [golden0] = await consumerDb.db.select().from(baselines).where(eq(baselines.testId, testId));
    const oldKey = golden0.artifactKey;
    expect(oldKey).toBeTruthy();
    const storage = new LocalFsAdapter(storageDir);
    expect(await storage.get(oldKey)).toBeTruthy(); // the golden blob exists

    // Run 2 compares against that golden and matches → passed.
    const run2 = await authed(app).post("/runs").send({ testId }).expect(201);
    const runId2 = run2.body.runId as string;
    const body2 = await driveToTerminal(runId2);
    expect(body2.status).toBe("passed");
    expect(body2.outcome).toBe("passed");

    // A passing checkpoint cannot be rejected.
    await authed(app).post(`/runs/${runId2}/checkpoints/hero/reject`).expect(400);

    // Re-baseline the passing checkpoint: golden becomes run 2's actual, audited.
    await authed(app).post(`/runs/${runId2}/checkpoints/hero/approve`).expect(201);

    const [golden1] = await consumerDb.db.select().from(baselines).where(eq(baselines.testId, testId));
    expect(golden1.artifactKey).not.toBe(oldKey);
    expect(golden1.artifactKey).toContain(runId2); // now points at run 2's actual
    expect(golden1.approvedBy).toBe(authEmail());
    expect(golden1.approvedAt).not.toBeNull();

    // The previous golden blob is gone (destructive replace, no rollback — DESIGN §4).
    expect(await storage.get(oldKey)).toBeFalsy();

    // The run that did the re-baseline now reads as a Baseline run.
    const afterRebaseline = await authed(app).get(`/runs/${runId2}`).expect(200);
    expect(afterRebaseline.body.outcome).toBe("baseline");
    const hero = (afterRebaseline.body.checkpoints as { name: string; resolution: string | null }[]).find(
      (c) => c.name === "hero",
    );
    expect(hero?.resolution).toBe("approved");
  });
});
