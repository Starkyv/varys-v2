import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import type { JudgeInput, JudgeProvider, JudgeResult } from "@varys/judge-engine";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import type {
  ClaimedRepairJob,
  CreatedAgentCredential,
  RepairBreakerOverride,
  RepairBreakerView,
  RepairJobSummary,
  RepairReviewItem,
} from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { JUDGE_SOURCE, type JudgeSource } from "../src/repair-jobs/judge";
import { authed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Failure clustering and the circuit breaker (Slice 19, slice 07) — bounding the blast radius.
 *
 * Two guarantees, and they pull in opposite directions on purpose:
 *
 *  - **One app change produces ONE reviewable fix.** Tests broken by the same renamed control
 *    collapse into a single Failure Cluster, repaired once and applied across all of them. The
 *    failure mode this prevents is thirty-eight independent repairs, each separately judged, each
 *    free to land differently — a corpus that no longer agrees with itself about what the button
 *    is called.
 *  - **A bad deploy produces NONE.** Above a project threshold of simultaneous locator failures,
 *    no jobs are created at all: the failures are recorded as breaker-suppressed and an alert
 *    fires. Mass failure means the app broke or was redesigned, which is a human decision — and
 *    without this guard one bad deploy rewrites the whole corpus into agreement with a bug.
 *
 * The pure semantics — clustering of mixed failures, and the breaker at, over and under threshold —
 * are pinned exhaustively in `packages/repair-policy/src/index.spec.ts`. What this suite pins is
 * the CONSEQUENCE, through the real machinery: real locator breaks, a real claim, a real repair
 * fanned out through the real version-writing path, and a real override.
 */
describe("One app change is one repair job; a mass failure is none", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
  let pool: Pool;
  let drainer: string;

  const judgeSource: JudgeSource = {
    resolve: async (): Promise<JudgeProvider | undefined> => ({
      judge: async (_input: JudgeInput): Promise<JudgeResult> => ({
        verdict: "pass",
        reasoning: "the same control, relabelled",
      }),
    }),
  };

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-cluster-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    process.env.VARYS_ACTION_TIMEOUT_MS = "1500"; // every break here is meant to fail fast

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JUDGE_SOURCE)
      .useValue(judgeSource)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    pool = new Pool({ connectionString: db.connectionString });
    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) => processRun({ db: consumerDb.db, storage }, runId));

    const created = await authed(app)
      .post("/settings/agent-credentials")
      .send({ label: "cluster", expiresInDays: 7 })
      .expect(201);
    drainer = (created.body as CreatedAgentCredential).token;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
    delete process.env.VARYS_ACTION_TIMEOUT_MS;
  });

  // ---- helpers ---------------------------------------------------------------------------

  const BRIEF =
    "Saving the form must work: the primary save control on the form panel commits the changes.";

  /** A test that clicks the control the broken variant renames — the SHARED root cause. */
  function clicksSave(name: string) {
    return {
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "click",
          target: {
            tag: "button",
            testId: "save-btn",
            role: "button",
            accessibleName: "Save changes",
            nameFromAttr: true,
            attributes: { id: "save-btn", "data-testid": "save-btn" },
            ancestors: [{ tag: "section", id: "form-panel" }, { tag: "body" }, { tag: "html" }],
            boundingBox: { x: 24, y: 168, width: 140, height: 36 },
            domIndex: 0,
          },
        },
      ],
    };
  }

  /** A test that clicks a control that is not on the page at all — an UNRELATED break. */
  function clicksGhost(name: string) {
    return {
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "click",
          target: {
            tag: "button",
            testId: "ghost-btn",
            role: "button",
            accessibleName: "Ghost",
            nameFromAttr: true,
            attributes: { id: "ghost-btn", "data-testid": "ghost-btn" },
            ancestors: [{ tag: "body" }, { tag: "html" }],
            boundingBox: { x: 0, y: 0, width: 10, height: 10 },
            domIndex: 0,
          },
        },
      ],
    };
  }

  async function autoTest(definition: object, brief: string | null = BRIEF): Promise<string> {
    const res = await authed(app).post("/tests").send(definition).expect(201);
    const testId = res.body.id as string;
    await authed(app)
      .patch(`/tests/${testId}`)
      .send(brief === null ? { repairPolicy: "auto" } : { repairPolicy: "auto", brief })
      .expect(200);
    return testId;
  }

  async function runToFailure(testId: string): Promise<string> {
    const created = await authed(app).post("/runs").send({ testId }).expect(201);
    const runId = created.body.runId as string;
    for (let i = 0; i < 200; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      if (res.body.status === "failed") return runId;
      if (res.body.status === "passed" || res.body.status === "needs_review") {
        throw new Error(`run ${runId} was expected to fail on its locator`);
      }
      await sleep(200);
    }
    throw new Error(`run ${runId} never finished`);
  }

  async function queue(all = false): Promise<RepairJobSummary[]> {
    const res = await authed(app)
      .get(`/repair-jobs${all ? "?all=1" : ""}`)
      .expect(200);
    return res.body as RepairJobSummary[];
  }

  async function breaker(): Promise<RepairBreakerView> {
    const res = await authed(app).get("/repair-jobs/breaker").expect(200);
    return res.body as RepairBreakerView;
  }

  async function reviews(): Promise<RepairReviewItem[]> {
    const res = await authed(app).get("/repair-jobs/reviews").expect(200);
    return res.body as RepairReviewItem[];
  }

  async function setThreshold(threshold: number): Promise<void> {
    await authed(app).put("/settings/repair-breaker").send({ threshold }).expect(200);
  }

  async function versions(testId: string) {
    const rows = await pool.query(
      `SELECT version, definition, review_state FROM test_versions WHERE test_id = $1 ORDER BY version ASC`,
      [testId],
    );
    return rows.rows as Array<{
      version: number;
      definition: { steps: Record<string, unknown>[] };
      review_state: string;
    }>;
  }

  async function ok(name: string, args: unknown = {}): Promise<Record<string, unknown>> {
    const res = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${drainer}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
    expect(res.body.error).toBeUndefined();
    const result = res.body.result as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? "";
    if (result.isError) throw new Error(`tool ${name} failed: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  }

  /** Wipe the queue AND the breaker's memory between cases: the queue is project-wide and the
   *  census reads recent runs, so one case's failures are the next case's false positives. */
  async function reset(): Promise<void> {
    for (const job of await queue()) {
      if (job.status === "queued") {
        await authed(app).post(`/repair-jobs/${job.id}/cancel`).expect(200);
      }
    }
    // The breaker counts locator failures in a time window, and every case here manufactures
    // several. Ageing them out of the window keeps each case's verdict its own.
    await pool.query(
      `UPDATE runs SET created_at = created_at - interval '3 hours' WHERE failure_kind = 'locator'`,
    );
    await pool.query(`DELETE FROM suppressed_failures`);
    await setThreshold(10);
  }

  // ---- clustering ------------------------------------------------------------------------

  it("collapses failures sharing a locator signature into ONE job, and leaves unrelated ones alone", async () => {
    await reset();
    fixture.setVariant("locatorRepairBroken");

    const a = await autoTest(clicksSave("cluster A"));
    const b = await autoTest(clicksSave("cluster B"));
    const c = await autoTest(clicksSave("cluster C"));
    // Same broken control, three tests — one app change.
    for (const t of [a, b, c]) await runToFailure(t);
    // A different broken control entirely.
    const ghost = await autoTest(clicksGhost("unrelated"));
    await runToFailure(ghost);

    const jobs = await queue();
    expect(jobs).toHaveLength(2);

    const shared = jobs.find((j) => j.clusterKey === "testid:save-btn");
    expect(shared).toBeTruthy();
    expect(shared?.clusterSize).toBe(3);
    expect(shared?.clusterTestNames.sort()).toEqual(["cluster A", "cluster B", "cluster C"]);
    // The anchor is the FIRST failure — the run a drainer opens its session on.
    expect(shared?.testId).toBe(a);

    // The unrelated failure did not get swept into it.
    const alone = jobs.find((j) => j.clusterKey === "testid:ghost-btn");
    expect(alone?.clusterSize).toBe(1);
    expect(alone?.clusterTestNames).toEqual(["unrelated"]);
  }, 300_000);

  it("applies a clustered repair across every test in the cluster as ONE reviewable change", async () => {
    await reset();
    fixture.setVariant("locatorRepair");
    // Both tests must resolve against the intact page first, or the "break" below would be a
    // fingerprint that was never right.
    const a = await autoTest(clicksSave("fanout A"));
    const b = await autoTest(clicksSave("fanout B"));

    fixture.setVariant("locatorRepairBroken");
    await runToFailure(a);
    await runToFailure(b);
    const [job] = (await queue()).filter((j) => j.clusterKey === "testid:save-btn");
    expect(job.clusterSize).toBe(2);

    // The drainer claims ONE job and is told the whole cluster it reaches.
    const claimed = (await ok("claim_repair_job")).job as ClaimedRepairJob | null;
    if (!claimed) throw new Error("expected a claimable job");
    expect(claimed.jobId).toBe(job.id);
    expect(claimed.clusterTests.map((t) => t.testId).sort()).toEqual([a, b].sort());

    // It repairs the ANCHOR only...
    const session = await ok("open_repair_session", { runId: claimed.runId });
    await ok("apply_fix", { sessionId: String(session.sessionId), testId: "commit-btn" });
    const reported = await ok("report_repair", {
      jobId: job.id,
      summary: "re-pinned the click to the Commit changes button",
      justification:
        'The Brief requires that "the primary save control on the form panel commits the changes". Same control, relabelled: save-btn is now commit-btn.',
    });

    // ...and Varys applies it across the cluster.
    expect((reported.clusterTestIds as string[]).sort()).toEqual([a, b].sort());
    for (const testId of [a, b]) {
      const latest = (await versions(testId)).at(-1);
      expect(latest?.review_state).toBe("unreviewed");
      expect(JSON.stringify(latest?.definition)).toContain("commit-btn");
    }

    // ONE reviewable change, not two: the queue shows a single item that names the whole cluster.
    const items = (await reviews()).filter((r) => [a, b].includes(r.testId));
    expect(items).toHaveLength(1);
    expect(items[0].clusterSize).toBe(2);
    expect(items[0].clusterTestNames.sort()).toEqual(["fanout A", "fanout B"]);
  }, 300_000);

  it("reverts every test in the cluster when the clustered repair is rejected", async () => {
    await reset();
    fixture.setVariant("locatorRepair");
    const a = await autoTest(clicksSave("reject A"));
    const b = await autoTest(clicksSave("reject B"));

    fixture.setVariant("locatorRepairBroken");
    await runToFailure(a);
    await runToFailure(b);
    const [job] = (await queue()).filter((j) => j.clusterKey === "testid:save-btn");

    const claimed = (await ok("claim_repair_job")).job as ClaimedRepairJob | null;
    if (!claimed) throw new Error("expected a claimable job");
    const session = await ok("open_repair_session", { runId: claimed.runId });
    await ok("apply_fix", { sessionId: String(session.sessionId), testId: "commit-btn" });
    await ok("report_repair", {
      jobId: job.id,
      summary: "re-pinned the click",
      justification: "Same control, relabelled: save-btn is now commit-btn.",
    });

    const item = (await reviews()).find((r) => r.clusterSize === 2);
    expect(item).toBeTruthy();
    const decided = await authed(app)
      .post(`/repair-jobs/reviews/${item?.versionId}/reject`)
      .send({})
      .expect(200);
    expect(decided.body.note).toContain("Failure Cluster");

    // BOTH tests are back on what they said before — the load-bearing assertion: rejecting one
    // row must not leave the other thirty-seven quietly repaired by a fix a human refused.
    for (const testId of [a, b]) {
      const history = await versions(testId);
      expect(JSON.stringify(history.at(-1)?.definition)).toContain("save-btn");
      expect(JSON.stringify(history.at(-1)?.definition)).not.toContain("commit-btn");
      expect(history.filter((v) => v.review_state === "rejected")).toHaveLength(1);
    }
    // And nothing is left waiting on a human.
    expect((await reviews()).some((r) => [a, b].includes(r.testId))).toBe(false);
  }, 300_000);

  // ---- the circuit breaker ---------------------------------------------------------------

  it("creates ZERO jobs above the threshold and records the failures as breaker-suppressed", async () => {
    await reset();
    // One simultaneous failure is allowed; the second is over the line.
    await setThreshold(1);
    fixture.setVariant("locatorRepairBroken");

    const first = await autoTest(clicksSave("breaker first"));
    await runToFailure(first);
    // At one failing test the breaker is AT the threshold, not over it — still repaired.
    expect((await queue()).some((j) => j.testId === first)).toBe(true);
    expect((await breaker()).suppressed).toHaveLength(0);

    const second = await autoTest(clicksGhost("breaker second"));
    await runToFailure(second);

    // No job for it — not a smaller job, not a deferred one. None.
    expect((await queue(true)).some((j) => j.testId === second)).toBe(false);
    const state = await breaker();
    expect(state.tripped).toBe(true);
    expect(state.threshold).toBe(1);
    expect(state.failingTests).toBeGreaterThan(1);
    expect(state.suppressed.map((f) => f.testName)).toContain("breaker second");
    // The record explains itself: the threshold and count in force when it was suppressed.
    const record = state.suppressed.find((f) => f.testName === "breaker second");
    expect(record?.threshold).toBe(1);
    expect(record?.clusterKey).toBe("testid:ghost-btn");
  }, 300_000);

  it("exposes the breaker's state, threshold and window — so a quiet queue explains itself", async () => {
    await reset();
    await setThreshold(4);
    const state = await breaker();
    expect(state).toMatchObject({ tripped: false, threshold: 4, defaultThreshold: 10 });
    expect(state.windowMinutes).toBeGreaterThan(0);
    expect(state.suppressed).toEqual([]);

    // The threshold is a project setting with a documented default, readable on its own surface.
    const settings = await authed(app).get("/settings/repair-breaker").expect(200);
    expect(settings.body).toMatchObject({ threshold: 4, defaultThreshold: 10 });
    // A value that would silently disable the guard is normalized, not stored.
    await setThreshold(0);
    expect((await authed(app).get("/settings/repair-breaker").expect(200)).body.threshold).toBe(10);
  }, 120_000);

  it("releases the suppressed failures for repair when a human overrides — clustered", async () => {
    await reset();
    await setThreshold(1);
    fixture.setVariant("locatorRepairBroken");

    // One allowed through, then three suppressed — two of them the SAME broken control.
    const seed = await autoTest(clicksGhost("override seed"));
    await runToFailure(seed);
    const a = await autoTest(clicksSave("override A"));
    const b = await autoTest(clicksSave("override B"));
    for (const t of [a, b]) await runToFailure(t);

    const before = await breaker();
    expect(before.tripped).toBe(true);
    expect(before.suppressed).toHaveLength(2);
    expect((await queue()).some((j) => [a, b].includes(j.testId))).toBe(false);

    const released = (
      await authed(app).post("/repair-jobs/breaker/release").send({}).expect(200)
    ).body as RepairBreakerOverride;

    // Two suppressed failures, ONE job: the release clusters exactly as the enqueue path would
    // have — a mass redesign is repaired in bulk as one reviewable change, not two.
    expect(released.released).toBe(2);
    expect(released.jobsCreated).toBe(1);
    const job = (await queue()).find((j) => j.clusterKey === "testid:save-btn");
    expect(job?.clusterSize).toBe(2);
    expect(job?.clusterTestNames.sort()).toEqual(["override A", "override B"]);

    // Nothing is left held back, and the threshold is UNCHANGED — an override is a decision about
    // these failures, not a standing instruction to stop guarding.
    const after = await breaker();
    expect(after.suppressed).toEqual([]);
    expect(after.threshold).toBe(1);
  }, 300_000);
});
