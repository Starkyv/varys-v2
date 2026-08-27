import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle, runs, testSchedules, testVersions } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import type { JudgeInput, JudgeProvider, JudgeResult } from "@varys/judge-engine";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import type {
  ClaimedRepairJob,
  CreatedAgentCredential,
  DashboardView,
  RepairJobSummary,
  RepairReviewItem,
  RunSummary,
  RunView,
  SuiteRunView,
} from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { JUDGE_SOURCE, type JudgeSource } from "../src/repair-jobs/judge";
import { authed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `healed` — the outcome a repair earns, and the re-run that earns it (Slice 19, slice 06).
 *
 * Slices 04 and 05 deliberately stopped short: a repair landed as an unreviewed version and the
 * run that failed stayed failed, with no amber anywhere, so that "a repair turned a run green"
 * could not exist before the justification gate did. This suite is the other half — now that no
 * repair can land without passing that gate, an applied repair triggers a RE-RUN, and a re-run
 * that verifies reads `healed`.
 *
 * The whole arc runs for real: a real baseline, a real locator break, a real claim, a real repair
 * through the real tools, then the re-run Varys queues by itself. Only the judge is scripted,
 * for the same reason as slice 05 — its verdict is an input here, not the thing under test.
 *
 * What `healed` means, and what this pins:
 *  - it is a property of the VERSION the run replayed, not of a checkpoint — a repair nobody has
 *    accepted yet. Accept it and the very same run reads `passed` again; `healed` is a review
 *    queue marker, not a permanent scar on the test's history.
 *  - it is a queue item, not an alarm: a suite containing one still reports passing, and a
 *    schedule still fires.
 *
 * The precedence — that a pixel diff still reads `regression` and a crash still reads `failed`,
 * however heroic the repair — is pinned exhaustively and cheaply in
 * `packages/review-contract/src/derive-run-outcome.test.ts`, one case per pairing. That belongs in
 * a pure unit test: it is a property of one function, and reproducing every pairing through a real
 * browser would buy nothing but minutes.
 */
describe("An applied repair re-runs the test, and a clean re-run reads healed", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
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
    storageDir = await mkdtemp(join(tmpdir(), "varys-healed-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    // Short enough that the deliberately-broken run fails quickly; long enough for the runs that
    // are meant to succeed.
    process.env.VARYS_ACTION_TIMEOUT_MS = "2000";
    process.env.VARYS_SCHEDULER_TICK_MS = "400";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JUDGE_SOURCE)
      .useValue(judgeSource)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) => processRun({ db: consumerDb.db, storage }, runId));

    const created = await authed(app)
      .post("/settings/agent-credentials")
      .send({ label: "healer", expiresInDays: 7 })
      .expect(201);
    drainer = (created.body as CreatedAgentCredential).token;
  }, 180_000);

  afterAll(async () => {
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
    delete process.env.VARYS_ACTION_TIMEOUT_MS;
    delete process.env.VARYS_SCHEDULER_TICK_MS;
  });

  // ---- the simulated drainer -------------------------------------------------------------

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

  // ---- fixtures --------------------------------------------------------------------------

  const BRIEF =
    "Saving the form must work: the primary save control on the form panel commits the changes.";

  /**
   * Click the control the break takes away, then screenshot the HERO — which is byte-identical
   * across both fixture variants. That separation is the point: the locator breaks, the pixels do
   * not, so a clean re-run is a genuine "everything verified" and the only thing left to say about
   * it is that a repair is holding it up.
   */
  function definition(name: string) {
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
        {
          type: "screenshot",
          name: "hero",
          target: { tag: "div", attributes: { id: "hero" }, text: "Hero" },
        },
      ],
    };
  }

  async function runToEnd(testId: string): Promise<RunView> {
    const created = await authed(app).post("/runs").send({ testId }).expect(201);
    return waitForRun(created.body.runId as string);
  }

  async function waitForRun(runId: string): Promise<RunView> {
    for (let i = 0; i < 300; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      const view = res.body as RunView;
      if (["passed", "needs_review", "failed", "cancelled"].includes(view.status)) return view;
      await sleep(200);
    }
    throw new Error(`run ${runId} never finished`);
  }

  async function reviews(): Promise<RepairReviewItem[]> {
    const res = await authed(app).get("/repair-jobs/reviews").expect(200);
    return res.body as RepairReviewItem[];
  }

  // Everything below is one arc, in order — later cases read state the earlier ones created.
  let testId = "";
  let brokenRunId = "";
  let versionId = "";
  let rerunId = "";

  it("sets a baseline, then breaks the locator and enqueues a repair job", async () => {
    fixture.setVariant("locatorRepair");
    const created = await authed(app).post("/tests").send(definition("healed arc")).expect(201);
    testId = created.body.id as string;
    await authed(app)
      .patch(`/tests/${testId}`)
      .send({ repairPolicy: "auto", brief: BRIEF })
      .expect(200);

    // A real baseline first — without one there is nothing for the re-run to verify against, and
    // an unapproved first capture would outrank `healed` anyway (as it should).
    const seed = await runToEnd(testId);
    expect(seed.outcome).toBe("pending-baseline");
    await authed(app).post(`/runs/${seed.runId}/approve-all`).send({}).expect(201);

    // Now the break. The control is renamed, re-parented and resized — nothing of the recorded
    // fingerprint survives — but the hero is untouched, so this is a locator failure and nothing else.
    fixture.setVariant("locatorRepairBroken");
    const broken = await runToEnd(testId);
    brokenRunId = broken.runId;
    expect(broken.outcome).toBe("failed");
    expect(broken.failureKind).toBe("locator");

    const queued = (await authed(app).get("/repair-jobs").expect(200))
      .body as RepairJobSummary[];
    expect(queued.some((j) => j.testId === testId && j.status === "queued")).toBe(true);
  }, 300_000);

  it("triggers a re-run the moment the repair passes the gate", async () => {
    const claimed = (await ok("claim_repair_job")).job as ClaimedRepairJob | null;
    if (!claimed) throw new Error("expected a claimable job");
    const session = await ok("open_repair_session", { runId: claimed.runId });
    await ok("apply_fix", { sessionId: String(session.sessionId), testId: "commit-btn" });

    const reported = await ok("report_repair", {
      jobId: claimed.jobId,
      summary: "re-pinned the click to the Commit changes button",
      justification:
        'The Brief requires that "the primary save control on the form panel commits the changes". Same control, relabelled: save-btn / "Save changes" is now commit-btn / "Commit changes".',
    });
    versionId = String(reported.versionId);
    rerunId = String(reported.rerunId);

    // The re-run is a NEW run, not a resurrection: the failure that started this stays failed
    // forever, and the drainer is told so in the same breath it is told about the re-run.
    expect(rerunId).not.toBe(brokenRunId);
    expect(reported.note).toContain("re-run");
    expect(reported.note).toContain("HEALED");
    const original = await authed(app).get(`/runs/${brokenRunId}`).expect(200);
    expect((original.body as RunView).outcome).toBe("failed");
  }, 300_000);

  it("reads healed once the re-run verifies — green, but on an unaccepted repair", async () => {
    const rerun = await waitForRun(rerunId);

    // Everything verified against the real baseline...
    expect(rerun.status).toBe("passed");
    expect(rerun.checkpoints.map((c) => c.reviewState)).toEqual(["passed"]);
    // ...and yet it is not a pass, because a human has not accepted the repair behind it.
    expect(rerun.outcome).toBe("healed");
    // Neither a person's run nor a cron's — Varys queued it itself.
    expect(rerun.triggerSource).toBe("repair");
  }, 300_000);

  it("shows healed on the runs list, the test history and the dashboard matrix", async () => {
    const all = (await authed(app).get("/runs").expect(200)).body as RunSummary[];
    expect(all.find((r) => r.runId === rerunId)?.outcome).toBe("healed");

    const history = (await authed(app).get(`/runs?testId=${testId}`).expect(200))
      .body as RunSummary[];
    expect(history.find((r) => r.runId === rerunId)?.outcome).toBe("healed");
    // The run that broke is untouched by any of this.
    expect(history.find((r) => r.runId === brokenRunId)?.outcome).toBe("failed");

    // The matrix cell is the LATEST run for the pairing, which is the re-run.
    const dash = (await authed(app).get("/dashboard").expect(200)).body as DashboardView;
    const row = dash.matrix.rows.find((r) => r.testId === testId);
    expect(row?.cells.some((c) => c.status === "healed")).toBe(true);
  }, 120_000);

  it("counts the healed version in the repair review queue, beside its re-run", async () => {
    const item = (await reviews()).find((r) => r.versionId === versionId);
    expect(item).toBeTruthy();
    expect(item?.rerunRunId).toBe(rerunId);
    expect(item?.rerunOutcome).toBe("healed");
  }, 120_000);

  it("does not fail a suite: the suite reports passing, with a healed count", async () => {
    const suite = await authed(app)
      .post("/suites")
      .send({ name: "healed suite", testIds: [testId] })
      .expect(201);
    const trigger = await authed(app)
      .post(`/suites/${suite.body.id}/runs`)
      .send({})
      .expect(201);
    const suiteRunId = trigger.body.suiteRunId as string;

    let report: SuiteRunView | undefined;
    for (let i = 0; i < 300; i++) {
      const res = await authed(app).get(`/suite-runs/${suiteRunId}`).expect(200);
      report = res.body as SuiteRunView;
      if (report.counts.queued === 0 && report.counts.running === 0) break;
      await sleep(200);
    }
    // The child replays the repaired (still unreviewed) definition, so it is healed — and the
    // suite is green regardless: a healed run is a queue item, not a failure.
    expect(report?.children.map((c) => c.outcome)).toEqual(["healed"]);
    expect(report?.status).toBe("passed");
    expect(report?.counts.healed).toBe(1);
    // Healed is a SUBSET of passed, not a sibling of it — the suite really did pass.
    expect(report?.counts.passed).toBe(1);
    expect(report?.counts.failed).toBe(0);
  }, 300_000);

  it("does not block a schedule: a due schedule still fires while the repair is unreviewed", async () => {
    await authed(app)
      .patch(`/tests/${testId}`)
      .send({ schedule: { cron: "*/5 * * * *", timezone: "UTC" } })
      .expect(200);
    await consumerDb.db
      .update(testSchedules)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(testSchedules.testId, testId));

    let fired: { id: string } | undefined;
    for (let i = 0; i < 40; i++) {
      const rows = await consumerDb.db
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
        .where(and(eq(testVersions.testId, testId), eq(runs.triggerSource, "schedule")));
      if (rows.length > 0) {
        fired = rows[0];
        break;
      }
      await sleep(300);
    }
    expect(fired, "the schedule should have fired despite the healed run").toBeTruthy();
    // Turn the schedule off again so its tick stops creating runs under the next case.
    await authed(app).patch(`/tests/${testId}`).send({ schedule: null }).expect(200);
  }, 300_000);

  it("stops being healed once a human accepts the repair", async () => {
    await authed(app).post(`/repair-jobs/reviews/${versionId}/accept`).send({}).expect(200);

    // The SAME run, re-read: `healed` was never a property of the run's results, it was "this
    // rests on an edit nobody signed off". Somebody signed off, so it is an ordinary pass — the
    // history does not carry an amber scar forever.
    const rerun = await authed(app).get(`/runs/${rerunId}`).expect(200);
    expect((rerun.body as RunView).outcome).toBe("passed");
    expect((await reviews()).some((r) => r.versionId === versionId)).toBe(false);
  }, 120_000);
});
