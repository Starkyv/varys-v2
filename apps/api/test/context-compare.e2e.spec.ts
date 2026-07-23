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
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authed, prepareAuth } from "./auth-harness";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = ["passed", "needs_review", "failed"];

interface Checkpoint {
  name: string;
  reviewState: string;
  compareMode: string;
  diffScore: number | null;
  judgeReasoning: string | null;
  actualUrl: string;
  baselineUrl: string | null;
  diffUrl: string | null;
}
interface RunView {
  status: string;
  error?: string | null;
  checkpoints: Checkpoint[];
}

/**
 * A programmable judge for the worker: each test sets `judgeMode` to steer the next verdict,
 * mirroring how these E2Es drive the fixture with `setVariant`. `calls` proves the judge is
 * (or isn't) invoked — e.g. a no-baseline seed must NOT call it.
 */
let judgeMode: "pass" | "fail" | "throw" = "pass";
let judgeCalls = 0;
const fakeJudge: JudgeProvider = {
  judge: async (_input: JudgeInput): Promise<JudgeResult> => {
    judgeCalls += 1;
    if (judgeMode === "throw") throw new Error("model exploded");
    return judgeMode === "pass"
      ? { verdict: "pass", reasoning: "current brief is a healthy instance of the baseline" }
      : { verdict: "fail", reasoning: "current brief's body is empty" };
  },
};

describe("Context compare (LLM judge)", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-ctx-"));
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
    // The worker under test carries a FAKE judge, so verdicts are deterministic (no network).
    await workRuns(consumerBoss, (runId) =>
      processRun({ db: consumerDb.db, storage, judge: fakeJudge }, runId),
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

  async function runToCompletion(testId: string): Promise<RunView & { runId: string }> {
    const run = await authed(app).post("/runs").send({ testId }).expect(201);
    const runId = run.body.runId as string;
    let body: RunView = { status: "queued", checkpoints: [] };
    for (let i = 0; i < 100; i++) {
      const res = await authed(app).get(`/runs/${runId}`);
      if (res.status !== 200) throw new Error(`GET /runs/${runId} -> ${res.status}: ${res.text}`);
      body = res.body;
      if (TERMINAL.includes(body.status)) break;
      await sleep(200);
    }
    return { runId, ...body };
  }

  // A full-page checkpoint that is compared by the LLM judge instead of pixel-diff.
  async function createContextTest(name: string): Promise<string> {
    const definition = {
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "brief",
          captureMode: "fullpage",
          compareMode: "context",
          prompt: "both are AI-generated briefs; ignore that words/numbers differ; is the current one broken vs the baseline?",
        },
      ],
    };
    const res = await authed(app).post("/tests").send(definition).expect(201);
    return res.body.id as string;
  }

  const approveBrief = (runId: string) =>
    authed(app).post(`/runs/${runId}/checkpoints/brief/approve`).expect(201);

  it("seeds a pending baseline without calling the judge (nothing to compare yet)", async () => {
    fixture.setVariant("default");
    judgeCalls = 0;
    const testId = await createContextTest("ctx seed");

    const seed = await runToCompletion(testId);

    expect(seed.status).toBe("needs_review");
    const cp = seed.checkpoints[0];
    expect(cp).toMatchObject({ name: "brief", reviewState: "pending-baseline", compareMode: "context" });
    expect(cp.judgeReasoning).toBeNull();
    expect(judgeCalls).toBe(0); // no baseline ⇒ judge is not consulted
  });

  it("passes when the judge returns pass, surfacing the reasoning", async () => {
    fixture.setVariant("default");
    const testId = await createContextTest("ctx pass");
    await approveBrief((await runToCompletion(testId)).runId); // seed → baseline

    judgeMode = "pass";
    judgeCalls = 0;
    const rerun = await runToCompletion(testId);

    expect(rerun.status).toBe("passed");
    const cp = rerun.checkpoints[0];
    expect(cp.reviewState).toBe("passed");
    expect(cp.compareMode).toBe("context");
    expect(cp.diffScore).toBeNull(); // judged, not pixel-scored
    expect(cp.judgeReasoning).toContain("healthy instance");
    expect(cp.baselineUrl).toEqual(expect.any(String));
    expect(judgeCalls).toBe(1);
  });

  it("sends a fail verdict to needs-review with the reasoning (never auto-fails the run)", async () => {
    fixture.setVariant("default");
    const testId = await createContextTest("ctx fail");
    await approveBrief((await runToCompletion(testId)).runId);

    judgeMode = "fail";
    const rerun = await runToCompletion(testId);

    // A judge 'fail' is a needs-review diff, NOT a hard-failed run.
    expect(rerun.status).toBe("needs_review");
    const cp = rerun.checkpoints[0];
    expect(cp.reviewState).toBe("diff");
    expect(cp.judgeReasoning).toContain("empty");
    expect(cp.diffUrl).toBeNull(); // context diffs have no pixel-diff image
  });

  it("fails safe to needs-review (never a green run) when the judge errors", async () => {
    fixture.setVariant("default");
    const testId = await createContextTest("ctx error");
    await approveBrief((await runToCompletion(testId)).runId);

    judgeMode = "throw";
    const rerun = await runToCompletion(testId);
    judgeMode = "pass"; // restore for any later test

    expect(rerun.status).toBe("needs_review");
    const cp = rerun.checkpoints[0];
    expect(cp.reviewState).toBe("diff");
    expect(cp.judgeReasoning).toContain("judge error");
  });
});
