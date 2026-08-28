import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import type { CreatedAgentCredential } from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, mcpToken, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * `run_test` / `run_status` (Slice 19, slice 14) — the half of "fix it" that proves the fix.
 *
 * The loop this closes is the attended one: a person asks their own Claude to repair a test, and
 * the answer should be "here is what I changed, and here is the run that shows it works" rather
 * than "here is what I changed, now go and press Run yourself".
 *
 * Two properties are worth more than the happy path here, and both are about what the tool
 * REFUSES to let a model conclude:
 *
 *  - A first run has no baseline, so it verified nothing. The answer says `pending-baseline` and
 *    tells the model in words that a human must approve it and that this is not a pass — the
 *    single easiest outcome to misreport as success.
 *  - A Repair Agent cannot reach the tool at all. A drainer able to trigger runs could sit in an
 *    unattended fix-and-retry loop until something went green, and "green eventually" is exactly
 *    the evidence the review gate exists to refuse.
 */
describe("run_test runs a test and reports a verdict a model cannot overstate", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
  let agentToken: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-run-tool-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    process.env.VARYS_ACTION_TIMEOUT_MS = "1500";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
      .send({ label: "run-tool", expiresInDays: 7 })
      .expect(201);
    agentToken = (created.body as CreatedAgentCredential).token;
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

  async function callAs(
    token: string,
    name: string,
    args: unknown = {},
  ): Promise<{ isError: boolean; text: string; data: Record<string, unknown> }> {
    const res = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
    const result = res.body.result as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? "";
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = {};
    }
    return { isError: Boolean(result.isError), text, data };
  }

  const call = (name: string, args: unknown = {}) => callAs(mcpToken(), name, args);

  /** A test that clicks the fixture's save control and checkpoints the hero. */
  async function createTest(name: string): Promise<string> {
    const res = await authed(app)
      .post("/tests")
      .send({
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
      })
      .expect(201);
    return res.body.id as string;
  }

  it("runs the test, waits for the verdict, and refuses to call a first run a pass", async () => {
    fixture.setVariant("default");
    const testId = await createTest("run tool — first run");

    const first = await call("run_test", { testId, waitSeconds: 120 });
    expect(first.isError).toBe(false);
    expect(first.data.finished).toBe(true);
    expect(first.data.testId).toBe(testId);
    expect(first.data.runId).toBeTruthy();
    // Nothing was compared: there was no baseline. The note has to say so in words, because
    // `status: "needs_review"` alone reads as ambiguous to a model looking for a yes/no.
    expect(first.data.outcome).toBe("pending-baseline");
    expect(first.data.awaitingHumanReview).toBe(1);
    expect(String(first.data.note)).toContain("HUMAN must approve");
    expect(String(first.data.note)).toContain("not describe this run as passing");
    // And a human can go straight to it.
    expect(first.data.path).toBe(`/runs/${first.data.runId}`);
  }, 300_000);

  it("reports a real pass once a baseline exists, and a locator failure as repairable", async () => {
    fixture.setVariant("locatorRepair");
    const created = await authed(app)
      .post("/tests")
      .send({
        name: "run tool — click",
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
              ancestors: [{ tag: "section", id: "form-panel" }],
              boundingBox: { x: 24, y: 168, width: 140, height: 36 },
              domIndex: 0,
            },
          },
        ],
      })
      .expect(201);
    const testId = created.body.id as string;

    // No checkpoints at all, so there is nothing awaiting a human — a clean pass.
    const green = await call("run_test", { testId, waitSeconds: 120 });
    expect(green.data.outcome).toBe("passed");
    expect(green.data.awaitingHumanReview).toBe(0);
    expect(String(green.data.note)).toContain("verified");

    // Now break the control the step clicks. The tool must name the failing step and say that this
    // is the ONE class of failure a re-pinned locator addresses.
    fixture.setVariant("locatorRepairBroken");
    const red = await call("run_test", { testId, waitSeconds: 120 });
    expect(red.data.outcome).toBe("failed");
    expect(red.data.failureKind).toBe("locator");
    expect((red.data.failingStep as { label: string }).label).toContain("save-btn");
    expect(String(red.data.note)).toContain("repair session");
    expect(red.data.error).toBeTruthy();
  }, 300_000);

  it("hands back a runId to keep waiting on when the wait is too short", async () => {
    fixture.setVariant("default");
    const testId = await createTest("run tool — resume");

    const started = await call("run_test", { testId, waitSeconds: 5 });
    const runId = String(started.data.runId);
    expect(runId).toBeTruthy();
    if (!started.data.finished) {
      expect(String(started.data.note)).toContain("run_status");
    }
    // Whether or not the first call caught it, the continuation reaches the same verdict.
    const resumed = await call("run_status", { runId, waitSeconds: 120 });
    expect(resumed.data.finished).toBe(true);
    expect(resumed.data.runId).toBe(runId);
  }, 300_000);

  it("is invisible to a Repair Agent — a drainer may not run tests at all", async () => {
    const list = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(200);
    const names = (list.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain("run_test");
    expect(names).not.toContain("run_status");

    // Not listed AND not callable — a capability boundary, not a hint.
    const refused = await callAs(agentToken, "run_test", { testId: "whatever" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Unknown tool");
  }, 120_000);
});
