import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  agentCheckpoints,
  baselines,
  createDb,
  type DbHandle,
  runResults,
  runs,
  testVersions,
} from "@varys/db";
import type { AgentCheckpoint, CreatedAgentCredential } from "@varys/review-contract";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { asc, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, mcpToken, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Starting an **Agent Run Session** — the moment a run begins, and the reason its honesty does
 * not depend on the agent (Agent-Driven Tests, ticket #4).
 *
 * Chromium-free by construction, and that is the design rather than a shortcut: Varys hosts no
 * browser for this kind and supplies no perception or action tools, so there is nothing here a
 * real browser would exercise. Everything under test happens on Varys's side of the wire — what
 * it hands out, what it writes before the agent acts, and what it refuses.
 *
 * The load-bearing assertion is the one that looks like doing nothing: start a session, report
 * nothing, and read a run that is ALREADY failed with reason `unreached`. That is the whole
 * guarantee — an agent that crashes, disconnects or simply checks less cannot produce a green,
 * because the red was written before it was ever asked to cooperate.
 */
describe("Agent Run Session — red before the agent does anything", () => {
  let app: INestApplication;
  let db: TestDb;
  let handle: DbHandle;
  let storageDir: string;
  let storage: LocalFsAdapter;
  let testId: string;
  let pinnedTestId: string;
  let environmentId: string;
  let otherEnvironmentId: string;
  let checkpoints: AgentCheckpoint[];

  /** The AI Instructions layer that lives on the test — credentials and all, as plain text. */
  const TEST_INSTRUCTIONS =
    "App is staging.acme.io. Log in as qa@acme.io / hunter2-staging.\nDismiss the cookie banner. Never click Delete.";

  beforeAll(async () => {
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-agentrun-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    handle = createDb(db.connectionString);
    storage = new LocalFsAdapter(storageDir);

    const env = await authed(app)
      .post("/environments")
      .send({ name: "staging", baseUrl: "https://staging.acme.io" })
      .expect(201);
    environmentId = env.body.id as string;
    const other = await authed(app)
      .post("/environments")
      .send({ name: "production", baseUrl: "https://acme.io" })
      .expect(201);
    otherEnvironmentId = other.body.id as string;

    const created = await authed(app)
      .post("/tests/agent")
      .send({ name: "checkout journey", instructions: TEST_INSTRUCTIONS })
      .expect(201);
    testId = created.body.id as string;

    for (const cp of [
      { name: "dashboard-loaded", instructions: "Sign in and land on the dashboard.", comparePrompt: "KPI tiles are populated; no error toast." },
      { name: "range-applied", instructions: "Set the date range to last 7 days.", comparePrompt: "Header reads a 7-day range. Values will differ — that is fine." },
      { name: "export-open", instructions: "Open the export dialog.", comparePrompt: "The dialog is open with CSV preselected." },
    ]) {
      await authed(app).post(`/tests/${testId}/agent-checkpoints`).send(cp).expect(201);
    }
    checkpoints = (await authed(app).get(`/tests/${testId}/agent-checkpoints`).expect(200))
      .body as AgentCheckpoint[];

    // A pinned test, so "refused for a pinned test" is refused on one that genuinely exists
    // rather than passing by accident on a not-found.
    const pinned = await authed(app)
      .post("/tests")
      .send({
        name: "pinned control",
        viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
        steps: [{ type: "navigate", url: "http://fixture.local/" }],
      })
      .expect(201);
    pinnedTestId = pinned.body.id as string;
  }, 180_000);

  afterAll(async () => {
    await handle?.pool.end();
    await app?.close();
    await db?.container.stop();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  /** JSON-RPC on `/mcp` as whoever holds `token`. */
  const rpc = (token: string, method: string, params: unknown) =>
    request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method, params });

  interface McpContent {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }
  interface McpToolResult {
    isError?: boolean;
    content: McpContent[];
  }

  const callTool = async (token: string, name: string, args: unknown): Promise<McpToolResult> => {
    const res = await rpc(token, "tools/call", { name, arguments: args }).expect(200);
    expect(res.body.error).toBeUndefined();
    return res.body.result as McpToolResult;
  };

  interface StartedSession {
    runId: string;
    testName: string;
    environment: string;
    environmentId: string | null;
    baseUrl: string | null;
    instructions: string;
    manifest: { step: number; name: string; instructions: string; comparePrompt: string; hasBaseline: boolean }[];
    baselineImages: string[];
    path: string;
    note: string;
  }

  /** Start a session and hand back the parsed JSON plus the raw content blocks (the baseline
   *  images ride alongside the JSON as image blocks, so both matter). */
  const start = async (
    args: unknown,
    token = mcpToken(),
  ): Promise<{ session: StartedSession; content: McpContent[]; raw: McpToolResult }> => {
    const raw = await callTool(token, "start_agent_run", args);
    expect(raw.isError).toBeFalsy();
    const text = raw.content.find((c) => c.type === "text")?.text ?? "{}";
    return { session: JSON.parse(text) as StartedSession, content: raw.content, raw };
  };

  const toolNames = async (token: string): Promise<string[]> => {
    const res = await rpc(token, "tools/list", {}).expect(200);
    return (res.body.result.tools as { name: string }[]).map((t) => t.name);
  };

  it("hands the agent the composed instructions and the ordered Checkpoint Manifest in one call", async () => {
    const { session } = await start({ testId, environmentId });

    expect(session.testName).toBe("checkout journey");
    expect(session.environment).toBe("staging");
    expect(session.environmentId).toBe(environmentId);
    expect(session.baseUrl).toBe("https://staging.acme.io");

    // Manifest order is the journey's order — the rows are cumulative, so this is the sequence,
    // not a display hint.
    expect(session.manifest.map((m) => m.name)).toEqual([
      "dashboard-loaded",
      "range-applied",
      "export-open",
    ]);
    expect(session.manifest.map((m) => m.step)).toEqual([1, 2, 3]);
    expect(session.manifest[1]).toMatchObject({
      instructions: "Set the date range to last 7 days.",
      comparePrompt: "Header reads a 7-day range. Values will differ — that is fine.",
    });

    // Every layer is present in the one document: the test-level instructions (credentials and
    // all), and each checkpoint's own two halves.
    expect(session.instructions).toContain("qa@acme.io / hunter2-staging");
    expect(session.instructions).toContain("staging.acme.io");
    for (const cp of checkpoints) {
      expect(session.instructions).toContain(cp.name);
      expect(session.instructions).toContain(cp.instructions);
      expect(session.instructions).toContain(cp.comparePrompt);
    }
    // And the layers are CONCATENATED general → specific, never overridden.
    expect(session.instructions.indexOf("hunter2-staging")).toBeLessThan(
      session.instructions.indexOf("dashboard-loaded"),
    );
  });

  it("pre-seeds one run result per Manifest slot, in `missing`, before returning", async () => {
    const { session } = await start({ testId, environmentId });

    const rows = await handle.db
      .select({ name: runResults.checkpointName, reviewState: runResults.reviewState })
      .from(runResults)
      .where(eq(runResults.runId, session.runId))
      .orderBy(asc(runResults.checkpointName));

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.reviewState === "missing")).toBe(true);
    expect(rows.map((r) => r.name).sort()).toEqual(
      ["dashboard-loaded", "export-open", "range-applied"],
    );
  });

  it("yields a run that is already failed/unreached — and stays that way if nobody reports", async () => {
    const { session } = await start({ testId, environmentId });

    // This is the walk-away case: nothing else is called after `start`, ever.
    const view = await authed(app).get(`/runs/${session.runId}`).expect(200);
    expect(view.body.status).toBe("failed");
    expect(view.body.failureKind).toBe("unreached");
    // The derived outcome is what every surface displays, and `missing` outranks everything a
    // sibling decision could soften.
    expect(view.body.outcome).toBe("failed");

    // It reads identically on the flat runs list — an agent-driven run is an ordinary run.
    const list = await authed(app).get(`/runs?testId=${testId}`).expect(200);
    const row = (list.body as { runId: string; outcome: string }[]).find(
      (r) => r.runId === session.runId,
    );
    expect(row?.outcome).toBe("failed");
  });

  it("stores the fully composed instruction text on the run, verbatim", async () => {
    const { session } = await start({ testId, environmentId });

    const [row] = await handle.db
      .select({ agentInstructions: runs.agentInstructions })
      .from(runs)
      .where(eq(runs.id, session.runId))
      .limit(1);

    expect(row.agentInstructions).toBe(session.instructions);

    // The copy is the compensating control for unversioned instructions: editing the test after
    // the fact must not rewrite what this run was told.
    await authed(app).patch(`/tests/${testId}`).send({ brief: "something else entirely" }).expect(200);
    const [after] = await handle.db
      .select({ agentInstructions: runs.agentInstructions })
      .from(runs)
      .where(eq(runs.id, session.runId))
      .limit(1);
    expect(after.agentInstructions).toBe(session.instructions);
    expect(after.agentInstructions).toContain("hunter2-staging");

    // Put it back, so the layer assertions above hold for the rest of the suite.
    await authed(app).patch(`/tests/${testId}`).send({ brief: TEST_INSTRUCTIONS }).expect(200);
  });

  it("marks which slots have an approved baseline, and attaches those images", async () => {
    // Seed an approved baseline for ONE slot, keyed exactly as `approve` would write it.
    const png = Buffer.from("fake-png-bytes-for-dashboard-loaded");
    const artifactKey = "baselines/agent-run-e2e/dashboard-loaded.png";
    await storage.put(artifactKey, png);
    await handle.db.insert(baselines).values({
      testId,
      checkpointName: "dashboard-loaded",
      environment: "staging",
      viewportKey: "1280x800@1",
      artifactKey,
      approvedBy: "e2e@varys.test",
      approvedAt: new Date(),
    });

    const { session, content } = await start({ testId, environmentId });

    expect(session.manifest.find((m) => m.name === "dashboard-loaded")?.hasBaseline).toBe(true);
    expect(session.manifest.find((m) => m.name === "range-applied")?.hasBaseline).toBe(false);
    expect(session.baselineImages).toEqual(["dashboard-loaded"]);

    // The bytes ride along as an MCP image block, so the agent can actually SEE the golden.
    const images = content.filter((c) => c.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe("image/png");
    expect(images[0].data).toBe(png.toString("base64"));
  });

  it("scopes baselines to the environment — production is not compared against staging's golden", async () => {
    const { session, content } = await start({ testId, environmentId: otherEnvironmentId });

    expect(session.environment).toBe("production");
    expect(session.manifest.every((m) => m.hasBaseline === false)).toBe(true);
    expect(session.baselineImages).toEqual([]);
    expect(content.filter((c) => c.type === "image")).toHaveLength(0);
  });

  it("refuses a pinned test — Varys replays those itself", async () => {
    const refused = await callTool(mcpToken(), "start_agent_run", { testId: pinnedTestId });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("pinned test");
    expect(refused.content[0].text).toContain("run_test");
  });

  it("refuses a test with no checkpoints — an empty Manifest has nothing to redden", async () => {
    const empty = await authed(app)
      .post("/tests/agent")
      .send({ name: "no checkpoints yet" })
      .expect(201);

    const refused = await callTool(mcpToken(), "start_agent_run", { testId: empty.body.id });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("no checkpoints");

    // Nothing was created — a refused start leaves no half-run behind.
    const list = await authed(app).get(`/runs?testId=${empty.body.id}`).expect(200);
    expect(list.body).toHaveLength(0);
  });

  it("refuses an unknown environment rather than degrading to the default", async () => {
    const refused = await callTool(mcpToken(), "start_agent_run", {
      testId,
      environmentId: "00000000-0000-0000-0000-000000000000",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("not found");
  });

  describe("the Repair Agent run capability", () => {
    let plainToken: string;
    let runnerToken: string;

    beforeAll(async () => {
      const plain = await authed(app)
        .post("/settings/agent-credentials")
        .send({ label: "nightly-drainer", expiresInDays: 7 })
        .expect(201);
      plainToken = (plain.body as CreatedAgentCredential).token;
      // Defaults to OFF — the field is not merely absent from the request, it is false on the row.
      expect((plain.body as CreatedAgentCredential).credential.canStartAgentRuns).toBe(false);

      const runner = await authed(app)
        .post("/settings/agent-credentials")
        .send({ label: "agent-run-drainer", expiresInDays: 7, canStartAgentRuns: true })
        .expect(201);
      runnerToken = (runner.body as CreatedAgentCredential).token;
      expect((runner.body as CreatedAgentCredential).credential.canStartAgentRuns).toBe(true);
    });

    it("hides the tool from a credential without the capability, and says why when it is called", async () => {
      expect(await toolNames(plainToken)).not.toContain("start_agent_run");

      const refused = await callTool(plainToken, "start_agent_run", { testId, environmentId });
      expect(refused.isError).toBe(true);
      // Not "Unknown tool": nothing is hidden here, so the operator is told which switch to flip.
      expect(refused.content[0].text).toContain("run capability");
      expect(refused.content[0].text).toContain("off by default");

      // And it really did not start one.
      const rows = await handle.db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.triggeredBy, 'Repair Agent "nightly-drainer"'));
      expect(rows).toHaveLength(0);
    });

    it("lets a credential provisioned WITH the capability start a session", async () => {
      expect(await toolNames(runnerToken)).toContain("start_agent_run");

      const { session } = await start({ testId, environmentId }, runnerToken);
      expect(session.manifest).toHaveLength(3);

      const [run] = await handle.db
        .select({
          triggeredBy: runs.triggeredBy,
          triggerSource: runs.triggerSource,
          failureKind: runs.failureKind,
        })
        .from(runs)
        .where(eq(runs.id, session.runId))
        .limit(1);
      // Attributed to the credential's label, not borrowed from a human — and red like any other.
      expect(run.triggeredBy).toBe('Repair Agent "agent-run-drainer"');
      // Recorded as a machine trigger, not as someone's manual run: the whole point of making the
      // capability a deliberate grant is that its use stays visible afterwards.
      expect(run.triggerSource).toBe("api");
      expect(run.failureKind).toBe("unreached");
    });

    it("keeps the human path untouched: a person always may", async () => {
      expect(await toolNames(mcpToken())).toContain("start_agent_run");
    });
  });

  it("refuses to save masks or a threshold on one of its checkpoints", async () => {
    const { session } = await start({ testId, environmentId });

    // The run-review tuning save writes a NEW test version, and an Agent-Driven Test has exactly
    // one — written at creation and never again. It is also meaningless here: this kind is
    // compared contextually, so there is no pixel threshold to tune and no mask to draw.
    const refused = await authed(app)
      .post(`/runs/${session.runId}/checkpoints/dashboard-loaded/persist`)
      .send({ masks: [{ x: 0, y: 0, width: 10, height: 10 }], threshold: 0.5 })
      .expect(400);
    expect(refused.body.message).toContain("Agent-Driven Test");

    const versions = await handle.db
      .select({ id: testVersions.id })
      .from(testVersions)
      .where(eq(testVersions.testId, testId));
    expect(versions).toHaveLength(1);
  });

  it("re-reads the Manifest on every start, so an edited test changes the next run only", async () => {
    const before = await start({ testId, environmentId });

    const added = await authed(app)
      .post(`/tests/${testId}/agent-checkpoints`)
      .send({ name: "export-downloaded", instructions: "Confirm the CSV downloads." })
      .expect(201);

    const after = await start({ testId, environmentId });
    expect(after.session.manifest.map((m) => m.name)).toContain("export-downloaded");
    expect(before.session.manifest.map((m) => m.name)).not.toContain("export-downloaded");

    // The earlier run keeps the four… three slots it was actually given. A Manifest is a
    // property of the run, not a live view of the test.
    const earlier = await handle.db
      .select({ name: runResults.checkpointName })
      .from(runResults)
      .where(eq(runResults.runId, before.session.runId));
    expect(earlier).toHaveLength(3);

    await authed(app)
      .delete(`/tests/${testId}/agent-checkpoints/${(added.body as AgentCheckpoint).id}`)
      .expect(200);
    const remaining = await handle.db
      .select({ id: agentCheckpoints.id })
      .from(agentCheckpoints)
      .where(eq(agentCheckpoints.testId, testId));
    expect(remaining).toHaveLength(3);
  });
});
