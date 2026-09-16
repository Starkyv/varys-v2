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
  runEvidence,
  runResults,
  runs,
  testVersions,
} from "@varys/db";
import type { AgentCheckpoint, CreatedAgentCredential } from "@varys/review-contract";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { and, asc, eq } from "drizzle-orm";
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
  /**
   * Reporting into a session: the three tools that turn a pre-seeded red run into a record of
   * what was actually seen.
   *
   * The properties worth more than the happy path are all about what Varys refuses to let the
   * agent conclude — a verdict with no argument behind it, a slot name nobody agreed on, a pass on
   * a picture no human has ever blessed, and a run that quietly forgets the slots it never
   * reached. Each of those is one assertion here, because each is one way a green could be
   * manufactured by an agent that meant no harm.
   */
  describe("submitting, finishing, and seeding baselines", () => {
    let submitTestId: string;

    /** A PNG, as far as anything in this path is concerned: the real 8-byte signature plus a
     *  marker, so two captures are distinguishable without pulling in an encoder. */
    const png = (marker: string): Buffer =>
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(marker),
      ]);
    const b64 = (marker: string): string => png(marker).toString("base64");

    interface SubmitResult {
      runId: string;
      checkpoint: string;
      verdict: string;
      hadBaseline: boolean;
      reviewState: string;
      remaining: string[];
      note: string;
    }
    interface FinishResult {
      runId: string;
      outcome: string;
      status: string;
      failureKind: string | null;
      checkpoints: { name: string; reviewState: string }[];
      unreached: string[];
      note: string;
    }

    /** Call a tool and parse its JSON payload, asserting it was not an error. */
    const ok = async <T>(token: string, name: string, args: unknown): Promise<T> => {
      const res = await callTool(token, name, args);
      expect(res.isError, res.content[0]?.text).toBeFalsy();
      return JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}") as T;
    };

    const submit = (runId: string, name: string, extra: Record<string, unknown> = {}) =>
      ok<SubmitResult>(mcpToken(), "submit_checkpoint", {
        runId,
        name,
        image: b64(name),
        verdict: "pass",
        reasoning: `The ${name} state matches what the instructions describe.`,
        ...extra,
      });

    const rowsOf = (runId: string) =>
      handle.db
        .select({
          name: runResults.checkpointName,
          reviewState: runResults.reviewState,
          actualArtifactKey: runResults.actualArtifactKey,
          baselineArtifactKey: runResults.baselineArtifactKey,
          judgeReasoning: runResults.judgeReasoning,
          captureTool: runResults.captureTool,
          captureViewport: runResults.captureViewport,
          captureDeviceScale: runResults.captureDeviceScale,
        })
        .from(runResults)
        .where(eq(runResults.runId, runId))
        .orderBy(asc(runResults.createdAt));

    const runRow = async (runId: string) => {
      const [row] = await handle.db
        .select({
          status: runs.status,
          failureKind: runs.failureKind,
          agentSummary: runs.agentSummary,
        })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      return row;
    };

    beforeAll(async () => {
      const created = await authed(app)
        .post("/tests/agent")
        .send({ name: "reporting journey", instructions: "Sign in as qa@acme.io / hunter2." })
        .expect(201);
      submitTestId = created.body.id as string;
      for (const cp of [
        { name: "home", instructions: "Land on the home page.", comparePrompt: "The hero renders." },
        { name: "detail", instructions: "Open the first item.", comparePrompt: "The detail panel is open." },
      ]) {
        await authed(app).post(`/tests/${submitTestId}/agent-checkpoints`).send(cp).expect(201);
      }
    });

    it("fills the pre-seeded slot with the capture, the verdict and the reasoning behind it", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });

      const result = await submit(session.runId, "home", {
        reasoning: "Hero image, nav and the sign-in chip all present; the counter differs, which the prompt says to ignore.",
        capture: { tool: "chrome-devtools", viewport: "1440x900", deviceScale: 2 },
      });

      expect(result.checkpoint).toBe("home");
      expect(result.remaining).toEqual(["detail"]);

      const rows = await rowsOf(session.runId);
      const home = rows.find((r) => r.name === "home");
      expect(home?.actualArtifactKey).toBeTruthy();
      expect(home?.judgeReasoning).toContain("the counter differs");
      // Capture metadata rides beside the artifact as EVIDENCE: nothing is enforced against it,
      // and its whole job is to let a reviewer ask whether two images were taken the same way.
      expect(home).toMatchObject({
        captureTool: "chrome-devtools",
        captureViewport: "1440x900",
        captureDeviceScale: 2,
      });

      // The bytes really landed, under this run's own key.
      const stored = await storage.get(home?.actualArtifactKey as string);
      expect(stored?.equals(png("home"))).toBe(true);

      // And the slot it did NOT report is untouched — still missing, still red.
      expect(rows.find((r) => r.name === "detail")?.reviewState).toBe("missing");
    });

    it("refuses a verdict with no reasoning — and the slot stays missing", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });

      const refused = await callTool(mcpToken(), "submit_checkpoint", {
        runId: session.runId,
        name: "home",
        image: b64("home"),
        verdict: "pass",
        reasoning: "   ",
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("reasoning");

      // A refused submission is not a partial one: nothing was written, so the run is as red as
      // it was before the call.
      const rows = await rowsOf(session.runId);
      expect(rows.every((r) => r.reviewState === "missing")).toBe(true);
      expect(rows.every((r) => r.actualArtifactKey === null)).toBe(true);
    });

    it("refuses a name outside the Manifest, and says which names it will take", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });

      const refused = await callTool(mcpToken(), "submit_checkpoint", {
        runId: session.runId,
        name: "Home page loaded",
        image: b64("x"),
        verdict: "pass",
        reasoning: "Looked right to me.",
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("CLOSED set");
      // Told the real names, so the refusal is recoverable rather than a dead end.
      expect(refused.content[0].text).toContain('"home"');
      expect(refused.content[0].text).toContain('"detail"');

      // No slot was invented: the Manifest is exactly as long as it was.
      const rows = await rowsOf(session.runId);
      expect(rows.map((r) => r.name)).toEqual(["home", "detail"]);
    });

    it("records a pass on a slot with no baseline as pending-baseline — a verdict about nothing is inert", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });

      const result = await submit(session.runId, "home");
      expect(result.hadBaseline).toBe(false);
      expect(result.verdict).toBe("pass");
      // The verdict said pass. What was STORED is a proposal awaiting a human.
      expect(result.reviewState).toBe("pending-baseline");
      expect(result.note).toContain("do not report this slot as passing");

      const rows = await rowsOf(session.runId);
      expect(rows.find((r) => r.name === "home")?.reviewState).toBe("pending-baseline");
      expect(rows.find((r) => r.name === "home")?.baselineArtifactKey).toBeNull();
    });

    it("derives pending-baseline for a complete first run — never passed", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });
      await submit(session.runId, "home");
      await submit(session.runId, "detail");

      const finished = await ok<FinishResult>(mcpToken(), "finish_agent_run", {
        runId: session.runId,
        summary: "Walked both states. No baselines existed, so both captures are proposals.",
      });

      // The word the agent is handed to report the run in — and it is not a pass.
      expect(finished.outcome).toBe("pending-baseline");
      expect(finished.unreached).toEqual([]);
      expect(finished.note).toContain("VERIFIED NOTHING");

      // The run itself agrees, in the runs list a human reads.
      const list = await authed(app).get(`/runs?testId=${submitTestId}`).expect(200);
      const listed = (list.body as { runId: string; outcome: string }[]).find(
        (r) => r.runId === session.runId,
      );
      expect(listed?.outcome).toBe("pending-baseline");

      // …and the stored status is no longer the start-time red, because the rows no longer say so.
      const row = await runRow(session.runId);
      expect(row.status).toBe("needs_review");
      expect(row.failureKind).toBeNull();
    });

    it("stores the agent's written summary on the run, and closes it to further reporting", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });
      await submit(session.runId, "home");

      await ok<FinishResult>(mcpToken(), "finish_agent_run", {
        runId: session.runId,
        summary: "Could not reach the detail panel — the first item's link 404s on staging.",
      });

      const row = await runRow(session.runId);
      expect(row.agentSummary).toContain("404s on staging");

      // Finished means finished: a session cannot declare itself done and then keep revising
      // what it reported.
      const late = await callTool(mcpToken(), "submit_checkpoint", {
        runId: session.runId,
        name: "detail",
        image: b64("late"),
        verdict: "pass",
        reasoning: "Actually I did reach it.",
      });
      expect(late.isError).toBe(true);
      expect(late.content[0].text).toContain("already finished");
      const again = await callTool(mcpToken(), "finish_agent_run", {
        runId: session.runId,
        summary: "Second thoughts.",
      });
      expect(again.isError).toBe(true);
    });

    it("leaves a half-walked run failed with reason unreached, whatever was reported", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });
      await submit(session.runId, "home");

      const finished = await ok<FinishResult>(mcpToken(), "finish_agent_run", {
        runId: session.runId,
        summary: "Home was fine. The detail panel never opened.",
      });

      expect(finished.outcome).toBe("failed");
      expect(finished.unreached).toEqual(["detail"]);
      expect(finished.note).toContain("never filled");

      const row = await runRow(session.runId);
      expect(row.status).toBe("failed");
      expect(row.failureKind).toBe("unreached");

      // One reported slot does not soften the other: this is red BECAUSE something is missing,
      // not merely amber because something is pending.
      const rows = await rowsOf(session.runId);
      expect(rows.find((r) => r.name === "home")?.reviewState).toBe("pending-baseline");
      expect(rows.find((r) => r.name === "detail")?.reviewState).toBe("missing");
    });

    it("attaches unlimited unnamed evidence that fills no slot and keys no baseline", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });

      for (const [i, note] of ["the empty state", "the console errors", "the network tab"].entries()) {
        const res = await ok<{ attached: number; note: string }>(mcpToken(), "submit_evidence", {
          runId: session.runId,
          image: b64(`evidence-${i}`),
          note,
        });
        expect(res.attached).toBe(i + 1);
      }

      const evidence = await handle.db
        .select({ artifactKey: runEvidence.artifactKey, note: runEvidence.note })
        .from(runEvidence)
        .where(eq(runEvidence.runId, session.runId))
        .orderBy(asc(runEvidence.createdAt));
      expect(evidence).toHaveLength(3);
      expect(evidence.map((e) => e.note)).toEqual([
        "the empty state",
        "the console errors",
        "the network tab",
      ]);
      expect(await storage.get(evidence[0].artifactKey)).toBeTruthy();

      // Nameless by design: evidence can never be mistaken for a Manifest slot, and the run is
      // exactly as red as it was before any of it was attached.
      const rows = await rowsOf(session.runId);
      expect(rows.map((r) => r.name)).toEqual(["home", "detail"]);
      expect(rows.every((r) => r.reviewState === "missing")).toBe(true);
      expect((await runRow(session.runId)).failureKind).toBe("unreached");
    });

    it("sends the proposals to the review queue, where approving seeds the baseline that the NEXT run is judged against", async () => {
      const first = await start({ testId: submitTestId, environmentId });
      await submit(first.session.runId, "home", {
        reasoning: "First capture of the home page; nothing to compare it to yet.",
      });

      // It is in the same queue, and on the same footing, as a pinned test's first capture.
      const queue = await authed(app).get("/runs/needs-review").expect(200);
      const item = (queue.body as { runId: string; checkpointName: string; environment: string }[]).find(
        (q) => q.runId === first.session.runId,
      );
      expect(item).toMatchObject({ checkpointName: "home", environment: "staging" });

      // A human approves it — the one gate, and the same gate a pinned test passes through.
      await authed(app)
        .post(`/runs/${first.session.runId}/checkpoints/home/approve`)
        .expect(201);

      // Per environment: staging now has a golden, production still has none.
      const staging = await start({ testId: submitTestId, environmentId });
      expect(staging.session.manifest.find((m) => m.name === "home")?.hasBaseline).toBe(true);
      const production = await start({ testId: submitTestId, environmentId: otherEnvironmentId });
      expect(production.session.manifest.find((m) => m.name === "home")?.hasBaseline).toBe(false);

      // And with a baseline behind it, a pass is finally allowed to mean something.
      const verified = await submit(staging.session.runId, "home", {
        reasoning: "Same layout as the golden; the counter moved, which the prompt permits.",
      });
      expect(verified.hadBaseline).toBe(true);
      expect(verified.reviewState).toBe("passed");
    });

    it("fills each slot exactly once — a verdict is evidence, not a draft to revise", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });
      await submit(session.runId, "home");

      const again = await callTool(mcpToken(), "submit_checkpoint", {
        runId: session.runId,
        name: "home",
        image: b64("home-take-two"),
        verdict: "pass",
        reasoning: "Second look, I like this capture better.",
      });
      expect(again.isError).toBe(true);
      expect(again.content[0].text).toContain("filled exactly once");

      // The first capture is what stands — the second did not overwrite it.
      const rows = await rowsOf(session.runId);
      const home = rows.find((r) => r.name === "home");
      const stored = await storage.get(home?.actualArtifactKey as string);
      expect(stored?.equals(png("home"))).toBe(true);
    });

    it("cannot talk a failed comparison round to a pass inside the same session", async () => {
      // A baseline, so a `fail` is a real regression rather than a first capture.
      const seed = await start({ testId: submitTestId, environmentId });
      await submit(seed.session.runId, "detail");
      await authed(app).post(`/runs/${seed.session.runId}/checkpoints/detail/approve`).expect(201);

      const { session } = await start({ testId: submitTestId, environmentId });
      const failed = await submit(session.runId, "detail", {
        verdict: "fail",
        reasoning: "The panel is empty where the golden shows three rows.",
      });
      expect(failed.reviewState).toBe("diff");

      // Re-rolling a failed verdict until it agrees is how a real regression disappears. The rule
      // lives in the server, not in the tool description that also asks for it.
      const retry = await callTool(mcpToken(), "submit_checkpoint", {
        runId: session.runId,
        name: "detail",
        image: b64("detail-retry"),
        verdict: "pass",
        reasoning: "Reloaded and now it looks fine.",
      });
      expect(retry.isError).toBe(true);

      const rows = await rowsOf(session.runId);
      expect(rows.find((r) => r.name === "detail")?.reviewState).toBe("diff");
    });

    it("cannot rewrite an approved baseline's bytes by re-submitting the slot it came from", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });
      await submit(session.runId, "home");

      // A human approves mid-session. `approve` promotes this run's actual artifact BY REFERENCE,
      // so the live golden now points at exactly the key a re-submission would write to.
      await authed(app).post(`/runs/${session.runId}/checkpoints/home/approve`).expect(201);
      const [golden] = await handle.db
        .select({ artifactKey: baselines.artifactKey })
        .from(baselines)
        .where(
          and(
            eq(baselines.testId, submitTestId),
            eq(baselines.checkpointName, "home"),
            eq(baselines.environment, "staging"),
          ),
        )
        .limit(1);

      const overwrite = await callTool(mcpToken(), "submit_checkpoint", {
        runId: session.runId,
        name: "home",
        image: b64("not-the-approved-picture"),
        verdict: "pass",
        reasoning: "Here is a nicer one.",
      });
      expect(overwrite.isError).toBe(true);

      // The golden is still the bytes the human actually looked at. Approving is the one human
      // gate in the whole feature, and an agent must not be able to walk through it sideways.
      expect((await storage.get(golden.artifactKey))?.equals(png("home"))).toBe(true);
    });

    it("never retries anything — a failed verdict is evidence, not a dice roll", async () => {
      // Give "home" a baseline so a `fail` is a real comparison failure rather than a first capture.
      const seed = await start({ testId: submitTestId, environmentId });
      await submit(seed.session.runId, "home");
      await authed(app).post(`/runs/${seed.session.runId}/checkpoints/home/approve`).expect(201);

      const before = (await authed(app).get(`/runs?testId=${submitTestId}`).expect(200)).body as unknown[];
      const { session } = await start({ testId: submitTestId, environmentId });
      await submit(session.runId, "home", {
        verdict: "fail",
        reasoning: "The hero is blank where the golden shows a rendered chart.",
      });

      const rows = await rowsOf(session.runId);
      expect(rows.find((r) => r.name === "home")?.reviewState).toBe("diff");

      // Nothing re-ran it: the failure did not queue a second attempt, and the only new run is
      // the one this test started itself.
      const after = (await authed(app).get(`/runs?testId=${submitTestId}`).expect(200)).body as unknown[];
      expect(after.length).toBe(before.length + 1);

      // Nor is there any other way to make Varys re-walk this kind: the worker path refuses it
      // outright, so there is no server-side replay to schedule, retry or redeliver.
      const refused = await authed(app).post("/runs").send({ testId: submitTestId, environmentId }).expect(400);
      expect(refused.body.message).toContain("your own local Claude");
    });

    it("deletes cleanly, taking its evidence and its blobs with it", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });
      await submit(session.runId, "home");
      await ok<{ attached: number }>(mcpToken(), "submit_evidence", {
        runId: session.runId,
        image: b64("evidence-to-delete"),
        note: "the console, before it all went wrong",
      });
      const [attached] = await handle.db
        .select({ artifactKey: runEvidence.artifactKey })
        .from(runEvidence)
        .where(eq(runEvidence.runId, session.runId));

      // Evidence rows carry a non-cascading FK to `runs`, so a run that has any is exactly the
      // run whose deletion would fail if the chain forgot about them.
      await authed(app).delete(`/runs/${session.runId}`).expect(200);

      expect(
        await handle.db
          .select({ id: runEvidence.id })
          .from(runEvidence)
          .where(eq(runEvidence.runId, session.runId)),
      ).toHaveLength(0);
      // The blob goes too: evidence keys no baseline, so nothing else can still want it.
      expect(await storage.get(attached.artifactKey)).toBeNull();
    });

    it("refuses a pinned test's run — a submitted picture may never overwrite a captured one", async () => {
      const pinnedRun = await handle.db
        .insert(runs)
        .values({
          testVersionId: (
            await handle.db
              .select({ id: testVersions.id })
              .from(testVersions)
              .where(eq(testVersions.testId, pinnedTestId))
              .limit(1)
          )[0].id,
          status: "passed",
        })
        .returning({ id: runs.id });

      const refused = await callTool(mcpToken(), "submit_checkpoint", {
        runId: pinnedRun[0].id,
        name: "anything",
        image: b64("forged"),
        verdict: "pass",
        reasoning: "Trust me.",
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("pinned test");

      const evidenceRefused = await callTool(mcpToken(), "submit_evidence", {
        runId: pinnedRun[0].id,
        image: b64("forged"),
      });
      expect(evidenceRefused.isError).toBe(true);
    });

    it("refuses an image that is not a PNG, rather than storing something a reviewer cannot see", async () => {
      const { session } = await start({ testId: submitTestId, environmentId });
      const refused = await callTool(mcpToken(), "submit_checkpoint", {
        runId: session.runId,
        name: "home",
        image: Buffer.from("/tmp/screenshots/home.png").toString("base64"),
        verdict: "pass",
        reasoning: "Here is the path to the file.",
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("not a PNG");
    });

    it("gates the whole session surface on the run capability, not just the verb that opens one", async () => {
      const plain = await authed(app)
        .post("/settings/agent-credentials")
        .send({ label: "reporting-drainer", expiresInDays: 7 })
        .expect(201);
      const plainToken = (plain.body as CreatedAgentCredential).token;

      const names = await toolNames(plainToken);
      for (const tool of ["start_agent_run", "submit_checkpoint", "submit_evidence", "finish_agent_run"]) {
        expect(names).not.toContain(tool);
      }

      // A credential that could report into a session a human opened would hold a capability
      // nobody granted it, and would put the wrong actor on the record.
      const { session } = await start({ testId: submitTestId, environmentId });
      const refused = await callTool(plainToken, "submit_checkpoint", {
        runId: session.runId,
        name: "home",
        image: b64("home"),
        verdict: "pass",
        reasoning: "Borrowed someone else's session.",
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("run capability");

      const rows = await rowsOf(session.runId);
      expect(rows.every((r) => r.reviewState === "missing")).toBe(true);
    });
  });
});
