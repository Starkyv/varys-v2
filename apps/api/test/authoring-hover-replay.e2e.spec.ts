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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, mcpAuthed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Step {
  type: string;
  target?: { attributes?: { id?: string }; testId?: string };
}

/**
 * The MCP driver must record a hover when the hover is what makes the next target reachable —
 * the same rule the DOM recorder follows (`dom.ts` → `openerForRevealed`). This is the test that
 * would have caught its absence: it authors a hover-menu flow through the real MCP tools, then
 * REPLAYS the result, and pins the negative control — the identical definition with the hover
 * step removed fails to locate the click target. So the assertion isn't "a hover step exists",
 * it's "the hover step is load-bearing at replay".
 */
describe("Authoring → hover-reveal flows replay", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
  /** Points {{baseUrl}} at the fixture, so an authored definition is replayable. */
  let environmentId: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    // The negative control below deliberately makes replay fail to locate a target. The default
    // 30s patience is right in production but would dominate this suite's runtime, and the
    // fixture renders synchronously, so a short budget proves the same thing far faster.
    process.env.VARYS_ACTION_TIMEOUT_MS = "3000";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) => processRun({ db: consumerDb.db, storage }, runId));

    const env = await authed(app)
      .post("/environments")
      .send({ name: "hover-fixture", baseUrl: fixture.url })
      .expect(201);
    environmentId = env.body.id;
  }, 60_000);

  afterAll(async () => {
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  const callTool = async (name: string, args: unknown) => {
    const res = await mcpAuthed(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
    expect(res.body.error).toBeUndefined();
    if (res.body.result.isError) {
      throw new Error(`tool ${name} failed: ${res.body.result.content?.[0]?.text}`);
    }
    return JSON.parse(res.body.result.content[0].text);
  };

  /** Run a test to completion and return its terminal status. An environment is required:
   *  authored tests parameterize the entry origin as `{{baseUrl}}`, which only resolves
   *  against one. */
  const runToCompletion = async (testId: string): Promise<string> => {
    const run = await authed(app).post("/runs").send({ testId, environmentId }).expect(201);
    for (let i = 0; i < 300; i++) {
      const res = await authed(app).get(`/runs/${run.body.runId}`).expect(200);
      const status = res.body.status as string;
      if (status === "passed" || status === "needs_review" || status === "failed") return status;
      await sleep(200);
    }
    throw new Error("run did not finish in time");
  };

  it("records the hover that reveals a menu item, and the recorded hover is what makes replay work", async () => {
    fixture.setVariant("hovermenu");
    const opened = await callTool("open_session", {
      startUrl: fixture.url,
      name: "hover menu flow",
      intent: "open the flyout and click Explorer",
      mode: "batch",
    });
    const sid: string = opened.sessionId;

    // The flyout does not exist yet, so its item has no ref to target.
    const trigger = (opened.nodes as Array<{ ref: string; name: string }>).find((n) =>
      /more/i.test(n.name),
    );
    expect(trigger).toBeTruthy();
    expect((opened.nodes as Array<{ name: string }>).some((n) => /explorer/i.test(n.name))).toBe(false);

    // Hovering the trigger creates the flyout — the tool reports what it revealed.
    const hovered = await callTool("hover", { sessionId: sid, ref: trigger!.ref });
    expect(hovered.note).toMatch(/revealed/i);
    const item = (hovered.snapshot.nodes as Array<{ ref: string; name: string }>).find((n) =>
      /explorer/i.test(n.name),
    );
    expect(item).toBeTruthy();

    // Clicking the revealed item promotes the pending hover into a recorded step.
    const clicked = await callTool("click", { sessionId: sid, ref: item!.ref });
    expect(clicked.recorded).toMatchObject({ type: "click", hoverFirst: true });

    await callTool("checkpoint", { sessionId: sid, name: "flyout opened", mode: "fullpage" });
    const finished = await callTool("finish_session", { sessionId: sid });

    // The definition carries hover BEFORE click, so replay re-opens the menu first.
    const test = await authed(app).get(`/tests/${finished.testId}`).expect(200);
    const steps = (test.body.definition as { steps: Step[] }).steps;
    const kinds = steps.map((s) => s.type);
    expect(kinds).toEqual(["navigate", "hover", "click", "screenshot"]);
    // …and the hover targets the TRIGGER, not the revealed item.
    expect(steps[1].target?.testId ?? steps[1].target?.attributes?.id).toBe("more-trigger");

    // It replays: reaching the checkpoint means the click target was locatable.
    await authed(app).post(`/drafts/${finished.testId}/promote`).send({}).expect(201);
    expect(await runToCompletion(finished.testId)).toBe("needs_review"); // seeds the baseline

    // NEGATIVE CONTROL: the same definition without the hover cannot locate the item, because
    // the flyout is never created. This is the failure the missing hover step used to cause.
    const withoutHover = {
      ...(test.body.definition as object),
      name: "hover menu flow (no hover)",
      steps: steps.filter((s) => s.type !== "hover"),
    };
    const control = await authed(app).post("/tests").send(withoutHover).expect(201);
    expect(await runToCompletion(control.body.id)).toBe("failed");
  }, 120_000);

  it("does not record an exploratory hover that reveals nothing", async () => {
    fixture.setVariant("hovermenu");
    const opened = await callTool("open_session", {
      startUrl: fixture.url,
      name: "exploratory hover",
      mode: "batch",
    });
    const sid: string = opened.sessionId;
    const trigger = (opened.nodes as Array<{ ref: string; name: string }>).find((n) =>
      /more/i.test(n.name),
    );

    // Hover the trigger, then click the trigger itself — the click target was already there
    // before the hover, so the hover was not load-bearing and must not be recorded.
    await callTool("hover", { sessionId: sid, ref: trigger!.ref });
    const clicked = await callTool("click", { sessionId: sid, ref: trigger!.ref });
    expect(clicked.recorded.hoverFirst).toBeUndefined();

    const finished = await callTool("finish_session", { sessionId: sid });
    const test = await authed(app).get(`/tests/${finished.testId}`).expect(200);
    const kinds = (test.body.definition as { steps: Step[] }).steps.map((s) => s.type);
    expect(kinds).toEqual(["navigate", "click"]);
  }, 60_000);
});
