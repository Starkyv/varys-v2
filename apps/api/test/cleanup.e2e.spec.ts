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
import { authed, mcpToken, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";
import { mcpCallTool, mcpRpc, mcpTool, mcpToolNames } from "./mcp-harness";

/**
 * The cleanup of ADR-0008, asserted at the only seam that can see it: the real application over a
 * throwaway Postgres, driven over HTTP and over `/mcp`.
 *
 * A removal is worth exactly two assertions, and this spec makes both.
 *
 * ABSENCE — the surface is really gone rather than answering something plausible. A stale client
 * has to fail visibly: the removed routes 404, the four queue tools are in neither `tools/list`
 * nor `tools/call`, `open_session` refuses a `mode` it no longer understands, and a bearer token
 * that is not a user's OAuth token is refused with no second issuer to fall through to.
 *
 * SURVIVAL — what was kept still works after the schema moved under it. The version table is gone
 * and a test now carries one definition, so the whole round trip is re-proved end to end: create,
 * edit in place, lose a race, run, review, approve. Then the repair half: a Repair Session opened
 * on a failed Run edits the test in place while the Run keeps replaying the definition IT ran,
 * which is the one thing `runs.definition` exists to make true.
 *
 * The migration backfill is deliberately not covered here — exercising it would mean freezing a
 * copy of the pre-cleanup DDL in the repo forever, permanent weight for a one-shot migration. It
 * is verified by hand against a copy of the database instead.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = ["passed", "needs_review", "failed"];

/** The four tools the repair queue owned. Nothing claims, leases or reports any more. */
const QUEUE_TOOLS = ["claim_repair_job", "release_repair_job", "report_repair", "report_triage"];

/** The attended path, which is now the whole story — listed so "the queue tools are gone" can't
 *  pass by accident on a server that lost repair altogether. */
const REPAIR_TOOLS = [
  "failed_runs",
  "open_repair_session",
  "try_locator",
  "apply_fix",
  "goto_step",
  "read_test",
  "edit_test",
  "close_repair_session",
];

interface Checkpoint {
  name: string;
  reviewState: string;
  diffScore: number | null;
  baselineUrl: string | null;
}
interface RunView {
  status: string;
  error?: string | null;
  failedStepIndex?: number | null;
  steps?: { index: number; label: string }[];
  checkpoints: Checkpoint[];
}

describe("Cleanup: the surface is gone, the flows survive", () => {
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    // A real worker on the real queue: the survival half has to run tests, not simulate them.
    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) => processRun({ db: consumerDb.db, storage }, runId));
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
    // Generous, because one of these runs is a locator failure: the matcher exhausts every signal
    // it has before it gives up, which is slower than any of the happy paths.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const res = await authed(app).get(`/runs/${runId}`);
      if (res.status !== 200) {
        throw new Error(`GET /runs/${runId} -> ${res.status}: ${JSON.stringify(res.body)}`);
      }
      body = res.body;
      if (TERMINAL.includes(body.status)) break;
      await sleep(250);
    }
    return { runId, ...body };
  }

  /* ---- Absence ------------------------------------------------------------------------ */

  // Gone, not returning something plausible: a client still calling one of these has to see it
  // fail rather than read an empty list as "nothing waiting on me".
  it("the removed routes no longer answer", async () => {
    const unrouted: Array<[string, () => Promise<{ status: number }>]> = [
      // The repair queue, its reviews, and its circuit breaker.
      ["GET /repair-jobs", () => authed(app).get("/repair-jobs")],
      ["POST /repair-jobs", () => authed(app).post("/repair-jobs").send({})],
      ["GET /repair-jobs/reviews", () => authed(app).get("/repair-jobs/reviews")],
      ["GET /repair-jobs/breaker", () => authed(app).get("/repair-jobs/breaker")],
      [
        "POST /repair-jobs/breaker/release",
        () => authed(app).post("/repair-jobs/breaker/release").send({}),
      ],
      ["GET /settings/repair-breaker", () => authed(app).get("/settings/repair-breaker")],
      ["PUT /settings/repair-breaker", () => authed(app).put("/settings/repair-breaker").send({})],
      // The second `/mcp` issuer's provisioning surface.
      ["GET /settings/agent-credentials", () => authed(app).get("/settings/agent-credentials")],
      [
        "POST /settings/agent-credentials",
        () => authed(app).post("/settings/agent-credentials").send({}),
      ],
      // The per-test switch, and the folder-wide control that armed it in bulk.
      ["POST /tests/repair-policy", () => authed(app).post("/tests/repair-policy").send({})],
    ];

    for (const [route, call] of unrouted) {
      const res = await call();
      expect(res.status, `${route} should be gone, got ${res.status}`).toBe(404);
    }

    // `/runs/needs-review` is the one removed path that still lands on a route — `GET /runs/:id`,
    // which now reads "needs-review" as a run id it cannot find. Asserted as "does not answer"
    // rather than on a status code, because what matters is that no client can still read a queue
    // off it: the state survives on the Run, the index over it does not.
    const needsReview = await authed(app).get("/runs/needs-review");
    expect(needsReview.status).toBeGreaterThanOrEqual(400);
    expect(Array.isArray(needsReview.body)).toBe(false);
  });

  it("the queue tools are in neither the tool list nor callable", async () => {
    const names = await mcpToolNames(app, mcpToken());

    // One list, for the one kind of caller `/mcp` now authenticates.
    for (const tool of QUEUE_TOOLS) expect(names).not.toContain(tool);
    // …and repair itself is still reachable, attended.
    for (const tool of REPAIR_TOOLS) expect(names).toContain(tool);

    // `tools/list` and `tools/call` read the same list, so a cached client tool list that still
    // names a queue tool cannot drive one: the call is refused rather than dispatched.
    for (const tool of QUEUE_TOOLS) {
      const res = await mcpCallTool(app, mcpToken(), tool, { jobId: "anything" });
      expect(res.isError, `${tool} should be unknown`).toBe(true);
      expect(res.content[0]?.text).toMatch(new RegExp(`unknown tool: ${tool}`, "i"));
    }
  });

  it("open_session rejects a mode argument", async () => {
    const res = await mcpCallTool(app, mcpToken(), "open_session", {
      startUrl: fixture.url,
      name: "mode is not a choice",
      mode: "batch",
    });
    // Refused rather than ignored: a stale instruction file that still teaches `mode` would
    // otherwise look accepted while steering nothing, and a wrong guess costs a draft to delete.
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/takes no `?mode`?/i);
  });

  it("refuses a bearer that is not a user's OAuth token, with no second issuer behind it", async () => {
    const res = await mcpRpc(app, "varys_agent_not-an-oauth-token", "tools/list", {}).expect(401);
    // The 401 that bootstraps OAuth — the only way in.
    expect(res.headers["www-authenticate"]).toMatch(/resource_metadata=/);
    expect(res.body.error.message).toMatch(/sign in to varys/i);

    // And nothing gets dispatched behind it either.
    await mcpRpc(app, "varys_agent_not-an-oauth-token", "tools/call", {
      name: "failed_runs",
      arguments: {},
    }).expect(401);
  });

  /* ---- Survival ----------------------------------------------------------------------- */

  it("creates a test, edits it in place, refuses a stale save, runs, reviews and approves", async () => {
    fixture.setVariant("default");
    const created = await authed(app)
      .post("/tests")
      .send({
        name: "round trip",
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
    const testId = created.body.id as string;

    const opened = await authed(app).get(`/tests/${testId}/config`).expect(200);
    const cpIndex = (opened.body.steps as { type: string }[]).findIndex(
      (s) => s.type === "screenshot",
    );
    const baseUpdatedAt = opened.body.updatedAt as string;

    // The save that used to mint a version row. It changes the one definition and reports when it
    // moved — the token the next save has to carry, in place of a version number.
    const saved = await authed(app)
      .put(`/tests/${testId}/config`)
      .send({ baseUpdatedAt, steps: [{ index: cpIndex, threshold: 0.05 }] })
      .expect(200);
    expect(saved.body.updatedAt).toEqual(expect.any(String));
    expect(saved.body.updatedAt).not.toBe(baseUpdatedAt);
    expect(saved.body).not.toHaveProperty("version");

    // The second tab, which opened the test before that save landed. Dropping version numbers must
    // not cost the stale-editor guard: it still conflicts loudly.
    await authed(app)
      .put(`/tests/${testId}/config`)
      .send({ baseUpdatedAt, steps: [{ index: cpIndex, threshold: 0.09 }] })
      .expect(409);

    // Edited in place: one definition, carrying the first save and not the one that lost.
    const afterSave = await authed(app).get(`/tests/${testId}/config`).expect(200);
    expect(afterSave.body.updatedAt).toBe(saved.body.updatedAt);
    expect(afterSave.body.steps[cpIndex].threshold).toBe(0.05);

    // Run it. A first run with no baseline is a decision waiting on a person — which is now a
    // STATE on the Run, decided on the Run, with no page listing it.
    const seed = await runToCompletion(testId);
    expect(seed.status).toBe("needs_review");
    expect(seed.checkpoints[0]).toMatchObject({ name: "hero", reviewState: "pending-baseline" });

    await authed(app).post(`/runs/${seed.runId}/checkpoints/hero/approve`).expect(201);

    // The baseline took: an identical re-run is green against it.
    const rerun = await runToCompletion(testId);
    expect(rerun.status).toBe("passed");
    expect(rerun.checkpoints[0]).toMatchObject({ reviewState: "passed", diffScore: 0 });
    expect(rerun.checkpoints[0].baselineUrl).toEqual(expect.any(String));
  });

  it("repairs a failed run in place, and the Run still replays its own definition", async () => {
    // Recorded against a page that has the button, then run against one where it is gone: the
    // shape of every "could not locate click target" in the wild.
    fixture.setVariant("locatorRepair");
    const created = await authed(app)
      .post("/tests")
      .send({
        name: "repairable",
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
              text: "Save",
              attributes: { id: "save-btn" },
              ancestors: [{ tag: "section", id: "form-panel" }],
            },
          },
          { type: "screenshot", name: "after-save", captureMode: "fullpage" },
        ],
      })
      .expect(201);
    const testId = created.body.id as string;

    fixture.setVariant("locatorRepairBroken");
    const failed = await runToCompletion(testId);
    fixture.setVariant("locatorRepairBroken"); // the repair drive faces the same page the run did
    expect(failed.status).toBe("failed");
    expect(failed.failedStepIndex).toBe(1);

    // A failed Run sits there until someone does something about it — and `failed_runs` is how a
    // person turns "repair the save test" into a run id, now that no queue does it for them.
    const failures = await mcpTool<{ runId: string; testId: string }[]>(
      app,
      mcpToken(),
      "failed_runs",
      { testName: "repairable" },
    );
    expect(failures.map((f) => f.runId)).toContain(failed.runId);

    const opened = await mcpTool<{ sessionId: string; mode: string }>(
      app,
      mcpToken(),
      "open_repair_session",
      { runId: failed.runId },
    );
    expect(opened.mode).toBe("repair");
    const sessionId = opened.sessionId;

    try {
      // The session reads the test's CURRENT definition — what an edit lands on — even though the
      // Run it was opened on replayed its own copy.
      const view = await mcpTool<{ testId: string; steps: { index: number; type: string }[] }>(
        app,
        mcpToken(),
        "read_test",
        { sessionId },
      );
      expect(view.testId).toBe(testId);
      const cp = view.steps.find((s) => s.type === "screenshot");
      expect(cp).toBeDefined();

      const edited = await mcpTool<Record<string, unknown> & { changes: string[] }>(
        app,
        mcpToken(),
        "edit_test",
        { sessionId, steps: [{ index: cp?.index, name: "after-commit" }] },
      );
      // What changed, in plain words — and no version number to report, because there isn't one.
      expect(edited.changes.join(" ")).toMatch(/after-commit/);
      expect(edited).not.toHaveProperty("version");
      expect(edited).not.toHaveProperty("baseVersion");
    } finally {
      await mcpCallTool(app, mcpToken(), "close_repair_session", { sessionId });
    }

    // The edit landed on the test itself — no proposal to accept, no second step.
    const config = await authed(app).get(`/tests/${testId}/config`).expect(200);
    const names = (config.body.steps as { checkpointName: string | null }[]).map(
      (s) => s.checkpointName,
    );
    expect(names).toContain("after-commit");
    expect(names).not.toContain("after-save");

    // And the Run is still evidence of what it ran: its own stored definition, untouched by an
    // edit to the test that has moved on since.
    const replayed = await authed(app).get(`/runs/${failed.runId}`).expect(200);
    const labels = (replayed.body.steps as { label: string }[]).map((s) => s.label);
    expect(labels.join(" ")).toContain('checkpoint "after-save"');
    expect(labels.join(" ")).not.toContain("after-commit");
    // A locator failure and a browser-backed repair drive in one test — it needs the room.
  }, 240_000);
});
