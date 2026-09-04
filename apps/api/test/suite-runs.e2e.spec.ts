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

type Child = {
  runId: string;
  testId: string;
  testName: string;
  environment: string;
  environmentId: string | null;
  environmentMissing: boolean;
  status: string;
  durationMs: number | null;
  pendingCheckpoints: number;
};
type View = {
  suiteRunId: string;
  suiteName: string;
  suiteId: string | null;
  environments: string[];
  environmentIds: string[];
  environmentsMissing: number;
  testCount: number;
  status: string;
  counts: { total: number; queued: number; passed: number; needsReview: number; failed: number };
  finishedAt: string | null;
  durationMs: number | null;
  triggeredBy: string | null;
  children: Child[];
};

/**
 * Slice 6 Issue 1 — the suite-run guarantees worth pinning (everything else is
 * manual-verified, per direction): the fan-out SHAPE (one ordinary child per
 * member test × environment, excluded from the flat runs history), the
 * derive-on-read AGGREGATION (incl. surviving suite deletion via the name
 * snapshot), and the trigger GUARDS. Chromium-free: children stay queued (no
 * worker); terminal aggregation is exercised by completing children in the DB.
 *
 * Plus what a report page does TO a fan-out: repeat it (same suite, same
 * environments, membership re-resolved) and delete it (parent + every child).
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
      .send({ name, baseUrl: `http://${name}.local` })
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

    // Children surface through the parent only — the flat runs history excludes them. Each one
    // knows its parent, so its run page can send you back to the report rather than to a list it
    // is not in.
    const flat = await authed(app).get("/runs").expect(200);
    const flatIds = new Set((flat.body as { runId: string }[]).map((r) => r.runId));
    for (const child of view.children) {
      expect(flatIds.has(child.runId)).toBe(false);
      const runView = await authed(app).get(`/runs/${child.runId}`).expect(200);
      expect((runView.body as { suiteRunId: string | null }).suiteRunId).toBe(suiteRunId);
    }

    // The report carries what a per-child re-run needs: the test and the environment it ran.
    for (const child of view.children) {
      expect(child.testId).toBeTruthy();
      expect(child.environmentId).toBeTruthy();
      expect(child.environmentMissing).toBe(false);
      // Still queued ⇒ no duration yet, and nothing awaiting review.
      expect(child.durationMs).toBeNull();
      expect(child.pendingCheckpoints).toBe(0);
    }

    // The aggregate listing carries the fan-out — and the same shape data as the report, so the
    // row you scan and the page you open agree.
    const listed = await authed(app).get("/suite-runs").expect(200);
    const mine = (listed.body as View[]).find((s) => s.suiteRunId === suiteRunId);
    expect(mine?.counts.total).toBe(4);
    expect(mine?.suiteId).toBe(suiteId);
    expect(mine?.testCount).toBe(2);
    expect(mine?.environmentIds?.sort()).toEqual([staging, acme].sort());
    expect(mine?.environmentsMissing).toBe(0);
    // Nothing has finished, so there is no wall-clock end yet.
    expect(mine?.finishedAt).toBeNull();
    expect(mine?.durationMs).toBeNull();
    expect(mine?.triggeredBy).toBeTruthy();

    // No environments selected ⇒ one env-less ("default") child per member test.
    const envless = await authed(app)
      .post(`/suites/${suiteId}/runs`)
      .send({})
      .expect(201);
    const envlessView = await getView(envless.body.suiteRunId as string);
    expect(envlessView.children).toHaveLength(2);
    expect(envlessView.children.every((c) => c.environment === "default")).toBe(true);
    // Env-less means no environment was targeted at all — not one that went missing.
    expect(envlessView.environmentIds).toEqual([]);
    expect(envlessView.environmentsMissing).toBe(0);
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

  it("finishes: once no child is in flight, the fan-out reports an end and a duration", async () => {
    const t = await mkTest("timed");
    const suiteId = await mkSuite("timed-suite", [t]);
    const triggered = await authed(app).post(`/suites/${suiteId}/runs`).send({}).expect(201);
    const suiteRunId = triggered.body.suiteRunId as string;

    const queued = await getView(suiteRunId);
    expect(queued.finishedAt).toBeNull();
    expect(queued.durationMs).toBeNull();
    expect(queued.children[0].durationMs).toBeNull();

    await pool.query(
      "UPDATE runs SET status = 'passed', updated_at = now() + interval '4 seconds' WHERE suite_run_id = $1",
      [suiteRunId],
    );
    const done = await getView(suiteRunId);
    expect(done.finishedAt).not.toBeNull();
    // The wall-clock end is the LAST child's finish, measured from the trigger.
    expect(done.durationMs).toBeGreaterThan(0);
    expect(done.children[0].durationMs).toBeGreaterThan(0);
  });

  it("re-runs a fan-out against the same environments, as a NEW suite run", async () => {
    const a = await mkTest("repeat-a");
    const staging = await mkEnv("repeat-staging");
    const suiteId = await mkSuite("repeatable", [a]);
    const first = await authed(app)
      .post(`/suites/${suiteId}/runs`)
      .send({ environmentIds: [staging] })
      .expect(201);
    const firstId = first.body.suiteRunId as string;

    // Membership is re-resolved at trigger time, so a test added since is included — a re-run
    // answers "does the suite pass now", not "did that exact set pass".
    const b = await mkTest("repeat-b");
    await authed(app).put(`/suites/${suiteId}`).send({ testIds: [a, b] }).expect(200);

    const again = await authed(app).post(`/suite-runs/${firstId}/rerun`).expect(201);
    const secondId = again.body.suiteRunId as string;
    expect(secondId).not.toBe(firstId);

    const repeat = await getView(secondId);
    expect(repeat.suiteName).toBe("repeatable");
    expect(repeat.environments).toEqual(["repeat-staging"]);
    expect(repeat.children.map((c) => c.testName).sort()).toEqual(["repeat-a", "repeat-b"]);
    // The original report is untouched — a re-run is a new record, never a back-fill.
    expect((await getView(firstId)).children).toHaveLength(1);

    await authed(app).post(`/suite-runs/${randomUUID()}/rerun`).expect(404);
  });

  it("refuses a re-run it cannot honour: suite deleted, or every environment deleted", async () => {
    // (a) The suite is gone — there is no membership left to re-resolve.
    const orphanTest = await mkTest("orphaned");
    const doomedSuite = await mkSuite("doomed", [orphanTest]);
    const orphan = await authed(app).post(`/suites/${doomedSuite}/runs`).send({}).expect(201);
    const orphanId = orphan.body.suiteRunId as string;
    await authed(app).delete(`/suites/${doomedSuite}`).expect(200);
    expect((await getView(orphanId)).suiteId).toBeNull();
    await authed(app).post(`/suite-runs/${orphanId}/rerun`).expect(409);

    // (b) The suite survives but its only environment does not — falling back to env-less would
    // run a {{baseUrl}} test with no base URL, so it refuses instead.
    const t = await mkTest("env-orphaned");
    const gone = await mkEnv("ephemeral");
    const suiteId = await mkSuite("env-orphan-suite", [t]);
    const run = await authed(app)
      .post(`/suites/${suiteId}/runs`)
      .send({ environmentIds: [gone] })
      .expect(201);
    const runId = run.body.suiteRunId as string;
    await authed(app).delete(`/environments/${gone}`).expect(200);

    const stranded = await getView(runId);
    // The children remain, so the report still says what it targeted — and that it is gone.
    expect(stranded.environmentIds).toEqual([]);
    expect(stranded.environmentsMissing).toBe(1);
    expect(stranded.children[0].environmentMissing).toBe(true);
    await authed(app).post(`/suite-runs/${runId}/rerun`).expect(409);
  });

  it("deletes a fan-out and every child run with it", async () => {
    const a = await mkTest("doomed-a");
    const b = await mkTest("doomed-b");
    const suiteId = await mkSuite("deletable", [a, b]);
    const triggered = await authed(app).post(`/suites/${suiteId}/runs`).send({}).expect(201);
    const suiteRunId = triggered.body.suiteRunId as string;
    const childIds = (await getView(suiteRunId)).children.map((c) => c.runId);
    expect(childIds).toHaveLength(2);

    const deleted = await authed(app).delete(`/suite-runs/${suiteRunId}`).expect(200);
    expect(deleted.body).toMatchObject({ ok: true, deletedRuns: 2 });

    await authed(app).get(`/suite-runs/${suiteRunId}`).expect(404);
    for (const runId of childIds) await authed(app).get(`/runs/${runId}`).expect(404);
    const listed = await authed(app).get("/suite-runs").expect(200);
    expect((listed.body as View[]).some((s) => s.suiteRunId === suiteRunId)).toBe(false);

    await authed(app).delete(`/suite-runs/${randomUUID()}`).expect(404);
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
