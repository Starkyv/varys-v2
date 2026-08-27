import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import type {
  ClaimedRepairJob,
  CreatedAgentCredential,
  RepairJobSummary,
  RunView,
} from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Triage jobs (Slice 19, slice 08) — every red run gains an explanation, and none gains a fix.
 *
 * A failure Claude may not repair is not a failure Varys should leave unexplained. A pixel
 * regression, a judge that could not run, a crash and a timeout each enqueue a READ-ONLY job whose
 * single output is a written finding on the run — the "the chart is empty because /api/metrics
 * returns 401" class of answer that turns a red cell into an actionable one.
 *
 * Everything here is about the boundary rather than the diagnosis. The interesting properties are
 * all things that must NOT happen:
 *
 *  - a triage claim is refused `apply_fix` and `edit_test`, structurally, however sure the agent is
 *  - baseline approval is not reachable by an agent at all — not a refusal, an absence
 *  - reporting a finding writes NO test version and leaves the run's outcome exactly as it was
 *
 * The drainer is SIMULATED — this test speaking the claim protocol over HTTP on a Repair Agent
 * credential — for the same reason the other repair suites simulate it: everything the slice
 * promises is a property of the queue and the permission boundary, not of the model that drains it.
 * The failures, though, are real: a real pixel diff, a real unjudgeable checkpoint, a real crash.
 */
describe("A failure Claude may not fix earns an explanation, and nothing else", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
  let pool: Pool;
  let drainer: string;
  let label: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-triage-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    process.env.VARYS_ACTION_TIMEOUT_MS = "1500";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
      .send({ label: "triager", expiresInDays: 7 })
      .expect(201);
    drainer = (created.body as CreatedAgentCredential).token;
    label = `Repair Agent "triager"`;
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

  // ---- the simulated drainer -------------------------------------------------------------

  async function call(
    name: string,
    args: unknown = {},
  ): Promise<{ isError: boolean; text: string; data: Record<string, unknown> }> {
    const res = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${drainer}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
    expect(res.body.error).toBeUndefined();
    const result = res.body.result as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? "";
    let data: Record<string, unknown> = {};
    if (!result.isError) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    return { isError: Boolean(result.isError), text, data };
  }

  async function ok(name: string, args: unknown = {}): Promise<Record<string, unknown>> {
    const res = await call(name, args);
    if (res.isError) throw new Error(`tool ${name} failed: ${res.text}`);
    return res.data;
  }

  // ---- helpers ---------------------------------------------------------------------------

  async function autoTest(definition: object): Promise<string> {
    const res = await authed(app).post("/tests").send(definition).expect(201);
    const testId = res.body.id as string;
    await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "auto" }).expect(200);
    return testId;
  }

  async function runToEnd(testId: string): Promise<RunView> {
    const created = await authed(app).post("/runs").send({ testId }).expect(201);
    const runId = created.body.runId as string;
    for (let i = 0; i < 300; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      const view = res.body as RunView;
      if (["passed", "needs_review", "failed", "cancelled"].includes(view.status)) return view;
      await sleep(200);
    }
    throw new Error(`run ${runId} never finished`);
  }

  async function run(runId: string): Promise<RunView> {
    return (await authed(app).get(`/runs/${runId}`).expect(200)).body as RunView;
  }

  async function queue(all = false): Promise<RepairJobSummary[]> {
    const res = await authed(app)
      .get(`/repair-jobs${all ? "?all=1" : ""}`)
      .expect(200);
    return res.body as RepairJobSummary[];
  }

  /** One job of its own per case: the queue is project-wide and first-claim-wins. */
  async function emptyQueue(): Promise<void> {
    await consumerDb.db.execute(
      `update repair_jobs set status = 'cancelled' where status in ('queued', 'claimed')`,
    );
  }

  async function versionCount(testId: string): Promise<number> {
    const rows = await pool.query(`SELECT count(*)::int AS n FROM test_versions WHERE test_id = $1`, [
      testId,
    ]);
    return rows.rows[0].n as number;
  }

  /** A pixel-compared checkpoint on the hero — the fixture can change it underneath us. */
  const heroTest = (name: string) => ({
    name,
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    steps: [
      { type: "navigate", url: fixture.url },
      {
        type: "screenshot",
        name: "hero",
        target: { tag: "div", attributes: { id: "hero" }, text: "Hero" },
      },
    ],
  });

  /** Seed + approve a baseline, then change the pixels underneath it: a real regression. */
  async function pixelRegression(name: string): Promise<{ testId: string; runView: RunView }> {
    await emptyQueue();
    fixture.setVariant("default");
    const testId = await autoTest(heroTest(name));
    const seeded = await runToEnd(testId);
    await authed(app).post(`/runs/${seeded.runId}/approve-all`).send({}).expect(201);
    fixture.setVariant("changed");
    const runView = await runToEnd(testId);
    expect(runView.outcome).toBe("regression");
    return { testId, runView };
  }

  // ---- what enqueues a triage job --------------------------------------------------------

  it("enqueues a triage job for a pixel regression — read-only, and not a repair job", async () => {
    const { testId, runView } = await pixelRegression("triage pixel");
    expect(runView.failureKind).toBe("pixel");

    const jobs = (await queue()).filter((j) => j.testId === testId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("triage");
    // It shares the queue with repair jobs — same statuses, same attempt counter, same shape.
    expect(jobs[0]).toMatchObject({ status: "queued", attempts: 0, claimedBy: null });
  }, 300_000);

  it("enqueues one for a judge that cannot run, and one for a crash", async () => {
    await emptyQueue();
    // No judge is configured in this suite, so a `context` checkpoint cannot be judged at all.
    fixture.setVariant("default");
    const judged = await autoTest({
      name: "triage judge",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "judged",
          compareMode: "context",
          prompt: "the hero looks reasonable",
          target: { tag: "div", attributes: { id: "hero" }, text: "Hero" },
        },
      ],
    });
    const seeded = await runToEnd(judged);
    await authed(app).post(`/runs/${seeded.runId}/approve-all`).send({}).expect(201);
    const judgeRun = await runToEnd(judged);
    expect(judgeRun.status).toBe("failed");
    // `judge`, not `crash`: the app is fine and the judge is not configured, and a queue that says
    // "crashed" sends whoever reads it looking in the wrong place.
    expect(judgeRun.failureKind).toBe("judge");

    // A port nothing is listening on: the navigation throws before any matcher runs.
    const crashed = await autoTest({
      name: "triage crash",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [{ type: "navigate", url: "http://127.0.0.1:1/" }],
    });
    const crashRun = await runToEnd(crashed);
    expect(crashRun.status).toBe("failed");
    expect(crashRun.failureKind).toBe("crash");

    const jobs = await queue();
    expect(jobs.filter((j) => j.testId === judged).map((j) => j.kind)).toEqual(["triage"]);
    expect(jobs.filter((j) => j.testId === crashed).map((j) => j.kind)).toEqual(["triage"]);
    // Two unrelated tests' failures are two diagnoses, never merged into one job.
    expect(new Set(jobs.map((j) => j.clusterKey)).size).toBe(jobs.length);
  }, 300_000);

  it("leaves ONE job for the same failure night after night", async () => {
    const { testId } = await pixelRegression("triage repeated");
    await runToEnd(testId);
    await runToEnd(testId);
    expect((await queue()).filter((j) => j.testId === testId)).toHaveLength(1);
  }, 300_000);

  // ---- what a triage claim may and may not do --------------------------------------------

  it("grants observation only: apply_fix and edit_test are refused, and no version is written", async () => {
    const { testId, runView } = await pixelRegression("triage readonly");
    const before = await versionCount(testId);

    const claimed = (await ok("claim_repair_job")).job as ClaimedRepairJob | null;
    if (!claimed) throw new Error("expected a claimable job");
    expect(claimed.kind).toBe("triage");
    expect(claimed.testId).toBe(testId);

    // Reading and driving are the whole point of a triage claim, and they work.
    expect((await call("read_test", { testId })).isError).toBe(false);
    const session = await ok("open_repair_session", { runId: runView.runId });
    const sessionId = String(session.sessionId);
    expect((await call("observe", { sessionId })).isError).toBe(false);

    // Writing does not — structurally, not by convention.
    const fix = await call("apply_fix", { sessionId, testId: "hero" });
    expect(fix.isError).toBe(true);
    expect(fix.text).toContain("triage");
    expect(fix.text).toContain("report_triage");

    const edit = await call("edit_test", { testId, name: "renamed by an agent" });
    expect(edit.isError).toBe(true);
    expect(edit.text).toContain("triage");

    // Nor may it close the job through the REPAIR path, which has the justification gate on it.
    const reported = await call("report_repair", {
      jobId: claimed.jobId,
      summary: "fixed it",
      justification: "the Brief says the hero must render",
    });
    expect(reported.isError).toBe(true);
    expect(reported.text).toContain("triage");

    // Baseline approval is not a refusal but an ABSENCE: it is not an MCP tool for anyone, so an
    // agent has no verb for it at all (DESIGN.md §4 — approving deletes the golden with no undo).
    const tools = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${drainer}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(200);
    const names = (tools.body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("report_triage");
    for (const forbidden of ["approve", "approve_all", "approve_baseline", "set_baseline"]) {
      expect(names).not.toContain(forbidden);
    }

    // Nothing was written to the test by any of it.
    expect(await versionCount(testId)).toBe(before);
    await ok("close_repair_session", { sessionId });
  }, 300_000);

  // ---- reporting a finding ---------------------------------------------------------------

  it("writes the finding onto the run, shows it with the failure, and leaves the run red", async () => {
    const { testId, runView } = await pixelRegression("triage finding");
    const before = await versionCount(testId);
    const outcomeBefore = runView.outcome;

    const claimed = (await ok("claim_repair_job")).job as ClaimedRepairJob | null;
    if (!claimed) throw new Error("expected a claimable job");

    const FINDING =
      "The hero panel renders with the wrong background: the deploy swapped the brand colour token, so every screenshot below the fold differs too. Nothing to repair in the test — the app changed.";
    const reported = await ok("report_triage", { jobId: claimed.jobId, finding: FINDING });

    expect(reported).toMatchObject({
      ok: true,
      jobId: claimed.jobId,
      status: "done",
      testId,
      runId: runView.runId,
      finding: FINDING,
      // Stated in the payload rather than left to be assumed — a drainer must not report "fixed".
      versionsWritten: 0,
    });
    expect(reported.runOutcome).toBe(outcomeBefore);
    expect(String(reported.note)).toContain("still");

    // Written onto the run, and shown with the failure.
    const after = await run(runView.runId);
    expect(after.triageFinding).toBe(FINDING);
    expect(after.triageBy).toContain("agent:");
    expect(after.triageAt).toEqual(expect.any(String));

    // The load-bearing assertion of the whole slice: a diagnosis is not a resolution.
    expect(after.outcome).toBe(outcomeBefore);
    expect(after.status).toBe(runView.status);
    expect(after.failureKind).toBe("pixel");
    expect(await versionCount(testId)).toBe(before);

    // The job is terminal and the claim is over, so the credential's reach ended with it.
    const job = (await queue(true)).find((j) => j.id === claimed.jobId);
    expect(job?.status).toBe("done");
    expect((await call("read_test", { testId })).isError).toBe(true);
  }, 300_000);

  it("refuses an empty finding without closing the job — that drainer wanted release", async () => {
    const { testId } = await pixelRegression("triage empty");
    const claimed = (await ok("claim_repair_job")).job as ClaimedRepairJob | null;
    if (!claimed) throw new Error("expected a claimable job");

    const refused = await call("report_triage", { jobId: claimed.jobId, finding: "   " });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("release");
    // Still claimed, so an agent that simply forgot the text can write it and report again.
    expect((await queue(true)).find((j) => j.id === claimed.jobId)?.status).toBe("claimed");
    expect((await call("read_test", { testId })).isError).toBe(false);

    const done = await ok("report_triage", { jobId: claimed.jobId, finding: "The API returns 401." });
    expect(done.status).toBe("done");
  }, 300_000);

  it("refuses a triage report for a REPAIR job, and refuses a claim it does not hold", async () => {
    await emptyQueue();
    fixture.setVariant("locatorRepairBroken");
    const testId = await autoTest({
      name: "triage wrong verb",
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
    });
    const failed = await runToEnd(testId);
    expect(failed.failureKind).toBe("locator");

    const claimed = (await ok("claim_repair_job")).job as ClaimedRepairJob | null;
    expect(claimed?.kind).toBe("repair");

    const refused = await call("report_triage", {
      jobId: claimed?.jobId,
      finding: "the button is gone",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("report_repair");

    // A job nobody handed this drainer is not-found, never a conflict.
    const foreign = await call("report_triage", {
      jobId: "00000000-0000-0000-0000-000000000000",
      finding: "x",
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain("claimed by");
    expect(label).toBeTruthy();
  }, 300_000);
});
