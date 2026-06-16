import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { authed, prepareAuth } from "./auth-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

type Child = { runId: string; testName: string; environment: string; status: string };
type View = {
  suiteRunId: string;
  suiteName: string;
  environments: string[];
  status: string;
  counts: { total: number; queued: number; passed: number; needsReview: number; failed: number };
  children: Child[];
};

/**
 * Slice 6 Issue 1 — the suite-run guarantees worth pinning (everything else is
 * manual-verified, per direction): the fan-out SHAPE (one ordinary child per
 * member test × environment, excluded from the flat runs history), the
 * derive-on-read AGGREGATION (incl. surviving suite deletion via the name
 * snapshot), and the trigger GUARDS. Chromium-free: children stay queued (no
 * worker); terminal aggregation is exercised by completing children in the DB.
 */
describe("Suite runs API", () => {
  let app: INestApplication;
  let db: TestDb;
  let pool: Pool;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.connectionString;
    pool = new Pool({ connectionString: db.connectionString });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
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

  const mkEnv = async (name: string): Promise<string> => {
    const res = await authed(app)
      .post("/environments")
      .send({ name, values: { baseUrl: `http://${name}.local` } })
      .expect(201);
    return res.body.id as string;
  };

  const mkSuite = async (name: string, testIds: string[]): Promise<string> => {
    const res = await authed(app)
      .post("/suites")
      .send({ name, testIds })
      .expect(201);
    return res.body.id as string;
  };

  const getView = async (suiteRunId: string): Promise<View> => {
    const res = await authed(app).get(`/suite-runs/${suiteRunId}`).expect(200);
    return res.body as View;
  };

  it("fans out one child per member test × environment, excluded from the flat runs list", async () => {
    const a = await mkTest("fanout-a");
    const b = await mkTest("fanout-b");
    const staging = await mkEnv("staging");
    const acme = await mkEnv("acme-prod");
    const suiteId = await mkSuite("release", [a, b]);

    const triggered = await authed(app)
      .post(`/suites/${suiteId}/runs`)
      .send({ environmentIds: [staging, acme] })
      .expect(201);
    const suiteRunId = triggered.body.suiteRunId as string;

    const view = await getView(suiteRunId);
    expect(view.suiteName).toBe("release");
    expect(view.children).toHaveLength(4);
    // Exactly one child per (test × environment) pair, every one an ordinary queued run.
    const pairs = view.children.map((c) => `${c.testName}|${c.environment}`).sort();
    expect(pairs).toEqual([
      "fanout-a|acme-prod",
      "fanout-a|staging",
      "fanout-b|acme-prod",
      "fanout-b|staging",
    ]);
    expect(view.children.every((c) => c.status === "queued")).toBe(true);
    expect(view.status).toBe("queued");
    expect(view.counts).toMatchObject({ total: 4, queued: 4 });
    expect(view.environments).toEqual(["acme-prod", "staging"]);

    // Children surface through the parent only — the flat runs history excludes them.
    const flat = await authed(app).get("/runs").expect(200);
    const flatIds = new Set((flat.body as { runId: string }[]).map((r) => r.runId));
    for (const child of view.children) expect(flatIds.has(child.runId)).toBe(false);

    // The aggregate listing carries the fan-out.
    const listed = await authed(app).get("/suite-runs").expect(200);
    const mine = (listed.body as View[]).find((s) => s.suiteRunId === suiteRunId);
    expect(mine?.counts.total).toBe(4);

    // No environments selected ⇒ one env-less ("default") child per member test.
    const envless = await authed(app)
      .post(`/suites/${suiteId}/runs`)
      .send({})
      .expect(201);
    const envlessView = await getView(envless.body.suiteRunId as string);
    expect(envlessView.children).toHaveLength(2);
    expect(envlessView.children.every((c) => c.environment === "default")).toBe(true);
  });

  it("derives the aggregate on read and survives suite deletion (name snapshot)", async () => {
    const t1 = await mkTest("agg-1");
    const t2 = await mkTest("agg-2");
    const suiteId = await mkSuite("nightly", [t1, t2]);

    const triggered = await authed(app)
      .post(`/suites/${suiteId}/runs`)
      .send({})
      .expect(201);
    const suiteRunId = triggered.body.suiteRunId as string;
    const initial = await getView(suiteRunId);
    const [r1, r2] = initial.children.map((c) => c.runId);

    // Complete children through the DB (no worker/chromium in this E2E) and watch
    // the derived aggregate follow: in-flight → needs_review → failed precedence → passed.
    const setStatus = (runId: string, status: string) =>
      pool.query("UPDATE runs SET status = $1 WHERE id = $2", [status, runId]);

    await setStatus(r1, "passed");
    expect((await getView(suiteRunId)).status).toBe("running"); // one still queued

    await setStatus(r2, "needs_review");
    const reviewable = await getView(suiteRunId);
    expect(reviewable.status).toBe("needs_review");
    expect(reviewable.counts).toMatchObject({ passed: 1, needsReview: 1 });

    await setStatus(r2, "failed");
    expect((await getView(suiteRunId)).status).toBe("failed");

    await setStatus(r2, "passed");
    expect((await getView(suiteRunId)).status).toBe("passed");

    // Deleting the suite never deletes its history: the report keeps working
    // under the trigger-time name snapshot (FK is SET NULL).
    await authed(app).delete(`/suites/${suiteId}`).expect(200);
    const survived = await getView(suiteRunId);
    expect(survived.suiteName).toBe("nightly");
    expect(survived.status).toBe("passed");
  });

  it("guards the trigger: empty suite, unknown suite, unknown environment", async () => {
    const emptySuite = await mkSuite("empty", []);
    await authed(app).post(`/suites/${emptySuite}/runs`).send({}).expect(400);

    await authed(app).post(`/suites/${randomUUID()}/runs`).send({}).expect(404);

    // A bogus environment fails the whole trigger up front — no half-created fan-out.
    const member = await mkTest("guarded");
    const suiteId = await mkSuite("guarded-suite", [member]);
    const before = await authed(app).get("/suite-runs").expect(200);
    await authed(app)
      .post(`/suites/${suiteId}/runs`)
      .send({ environmentIds: [randomUUID()] })
      .expect(404);
    const after = await authed(app).get("/suite-runs").expect(200);
    expect((after.body as View[]).length).toBe((before.body as View[]).length);
  });
});
