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
  RepairReviewItem,
} from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { CLOCK, type Clock } from "../src/repair-jobs/clock";
import { JUDGE_SOURCE, type JudgeSource } from "../src/repair-jobs/judge";
import { authed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The repair review surface's evidence (Slice 19, slice 13): the side-by-side signal diff and the
 * page the repair was made against, both carried on the review item a human decides from.
 *
 * The property under test is that the evidence is INDEPENDENT of the agent's account of itself.
 * The diff is computed from the two stored definitions and the screenshot is captured off the live
 * page as the fix is written, so a drainer that described its change generously cannot make either
 * of them agree with it. The break here is a real one — a `@varys/fixture-app` variant renames and
 * re-parents the control — so the diff under assertion is a genuine repair's, not a constructed
 * one.
 *
 * The purely-functional half of the diff (what counts as changed, how a dropped signal reads) is
 * pinned in `src/repair-jobs/repair-signal-diff.spec.ts`; this suite is about it arriving intact
 * on the endpoint the UI reads, with a screenshot behind it that actually serves.
 */
describe("A repaired version awaiting review carries its signal diff and the page it was fixed against", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
  let drainer: string;

  const clock: Clock = { now: () => new Date() };

  /** Every repair here has to clear the justification gate (slice 05) to reach the review queue;
   *  what the gate refuses is `repair-justification-gate.e2e.spec.ts`'s subject, not this one's. */
  const judgeSource: JudgeSource = {
    resolve: async () => ({
      judge: async () => ({ verdict: "pass" as const, reasoning: "same control, renamed" }),
    }),
  };

  beforeAll(async () => {
    fixture = await startFixtureServer();
    fixture.setVariant("locatorRepairBroken");
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-review-diff-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    process.env.VARYS_ACTION_TIMEOUT_MS = "1500"; // the run below fails on purpose

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
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
      .send({ label: "review-diff", expiresInDays: 7 })
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
  });

  // ---- the simulated drainer -------------------------------------------------------------

  async function ok(name: string, args: unknown = {}): Promise<Record<string, unknown>> {
    const res = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${drainer}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
    const result = res.body.result as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? "";
    if (result.isError) throw new Error(`tool ${name} failed: ${text}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** A test clicking the control the broken variant renames from `save-btn` to `commit-btn`. */
  function definitionClickingSave(name: string) {
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

  async function reviews(): Promise<RepairReviewItem[]> {
    const res = await authed(app).get("/repair-jobs/reviews").expect(200);
    return res.body as RepairReviewItem[];
  }

  let item: RepairReviewItem;

  beforeAll(async () => {
    const created = await authed(app)
      .post("/tests")
      .send(definitionClickingSave("review diff"))
      .expect(201);
    const testId = created.body.id as string;
    await authed(app)
      .patch(`/tests/${testId}`)
      .send({
        repairPolicy: "auto",
        brief:
          "Saving the form must work: the primary save control on the form panel commits the changes.",
      })
      .expect(200);
    await runToFailure(testId);

    const [job] = (await authed(app).get("/repair-jobs?all=1").expect(200))
      .body as RepairJobSummary[];
    expect(job.status).toBe("queued");

    const claimed = (await ok("claim_repair_job")).job as ClaimedRepairJob;
    const session = await ok("open_repair_session", { runId: claimed.runId });
    const sessionId = String(session.sessionId);
    await ok("apply_fix", { sessionId, testId: "commit-btn" });
    await ok("report_repair", {
      jobId: claimed.jobId,
      summary: 'Re-pinned the click to the "Commit changes" button (data-testid=commit-btn).',
      justification:
        'The Brief requires that "the primary save control on the form panel commits the changes" — the same control, relabelled from save-btn / "Save changes" to commit-btn.',
    });

    const found = (await reviews()).find((r) => r.testId === testId);
    if (!found) throw new Error("the repaired version never reached the review queue");
    item = found;
  }, 180_000);

  it("shows the previous and repaired locator side by side, for the step that changed", () => {
    expect(item.previousVersion).toBe(1);
    expect(item.version).toBe(2);
    expect(item.diff).not.toBeNull();
    const diff = item.diff!;
    // A locator repair touches one step and does not change how many there are.
    expect(diff.stepCountBefore).toBe(diff.stepCountAfter);
    expect(diff.steps).toHaveLength(1);
    expect(diff.steps[0].stepIndex).toBe(1);
    // Both sides are present on every signal — the "side by side" the slice is named for.
    for (const signal of diff.steps[0].signals) {
      expect(signal).toHaveProperty("before");
      expect(signal).toHaveProperty("after");
    }
  });

  it("distinguishes the signals that changed from the ones that did not", () => {
    const byLabel = new Map(item.diff!.steps[0].signals.map((s) => [s.label, s]));

    // What the repair MOVED: the durable signal it re-pinned onto.
    expect(byLabel.get("data-testid")).toMatchObject({
      before: "save-btn",
      after: "commit-btn",
      changed: true,
    });
    // What it did NOT move — the evidence that this is still the same control, and the reason
    // unchanged signals are carried rather than dropped from the diff.
    expect(byLabel.get("Role")).toMatchObject({ changed: false, after: "button" });
    expect(byLabel.get("Element")).toMatchObject({ changed: false, after: "<button>" });
    // A locator repair re-finds an element; it does not edit the step around it.
    expect(item.diff!.steps[0].nonSignalChange).toBe(false);
  });

  it("keeps the brief and the agent's justification beside the diff", () => {
    expect(item.brief).toContain("the primary save control on the form panel");
    expect(item.justification).toContain("the primary save control on the form panel");
    // The judge's verdict on the claim — meaningless without the brief above it, which is why
    // both travel on the same item.
    expect(item.justificationReasoning).toBe("same control, renamed");
    expect(item.report).toContain("commit-btn");
  });

  it("offers a screenshot of the page the repair was made against, and serves it", async () => {
    expect(item.pageScreenshotUrl).toMatch(/^\/artifacts\//);
    const res = await authed(app).get(item.pageScreenshotUrl as string).expect(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body.length).toBeGreaterThan(1000);
  });
});
