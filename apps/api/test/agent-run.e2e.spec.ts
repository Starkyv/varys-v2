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
  suites,
  suiteTests,
  testVersions,
} from "@varys/db";
import type { AgentCheckpoint } from "@varys/review-contract";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, mcpToken, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";
import {
  type McpContent,
  type McpToolResult,
  mcpCallTool,
  mcpRpc,
  mcpTool,
  mcpToolNames,
  pngBase64,
  pngFixture,
} from "./mcp-harness";

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

  // The `/mcp` transport, from the shared harness — bound to this suite's app so each call
  // names only the principal it acts as.
  const rpc = (token: string, method: string, params: unknown) => mcpRpc(app, token, method, params);
  const callTool = (token: string, name: string, args: unknown): Promise<McpToolResult> =>
    mcpCallTool(app, token, name, args);

  interface StartedSession {
    runId: string;
    testName: string;
    environment: string;
    environmentId: string | null;
    baseUrl: string | null;
    instructions: string;
    manifest: { step: number; name: string; instructions: string; comparePrompt: string; hasBaseline: boolean }[];
    baselineImages: string[];
    leaseSeconds: number;
    leaseExpiresAt: string;
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

  const toolNames = (token: string): Promise<string[]> => mcpToolNames(app, token);
  const png = pngFixture;
  const b64 = pngBase64;

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

  const ok = <T>(token: string, name: string, args: unknown): Promise<T> =>
    mcpTool<T>(app, token, name, args);

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
        leaseSeconds: runs.agentLeaseSeconds,
        leaseExpiresAt: runs.agentLeaseExpiresAt,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    return row;
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
    // The guarantee, and it is a property of the STORED run: red from the instant it existed, with
    // the reason that says why, and every Manifest slot seeded `missing`. Nothing about the
    // display can soften any of this, and nothing later infers anything from work never reported.
    expect(view.body.status).toBe("failed");
    expect(view.body.failureKind).toBe("unreached");
    expect(view.body.checkpoints.map((c: { reviewState: string }) => c.reviewState)).toEqual([
      "missing",
      "missing",
      "missing",
    ]);

    // The DISPLAYED outcome is the one thing that waits. While the session is inside its lease
    // Varys genuinely cannot tell a walked-away agent from a working one — `open` is the honestly
    // ambiguous state — so the view declines to call an ending that has not happened yet. It turns
    // red the moment the lease is out, which the lease suite below proves with the clock.
    expect(view.body.session.state).toBe("open");
    expect(view.body.outcome).toBe("running");

    // And it reads identically on the flat runs list — one answer, derived once, on both surfaces.
    const list = await authed(app).get(`/runs?testId=${testId}`).expect(200);
    const row = (list.body as { runId: string; outcome: string; status: string }[]).find(
      (r) => r.runId === session.runId,
    );
    expect(row?.outcome).toBe("running");
    expect(row?.status).toBe("failed");
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

    it("awaits a baseline decision on its own Run, where approving seeds the baseline that the NEXT run is judged against", async () => {
      const first = await start({ testId: submitTestId, environmentId });
      await submit(first.session.runId, "home", {
        reasoning: "First capture of the home page; nothing to compare it to yet.",
      });

      // It awaits a decision on the same footing as a pinned test's first capture: the Run
      // carries it as `pending-baseline`, which is where the decision is made.
      const proposed = (await rowsOf(first.session.runId)).find((r) => r.name === "home");
      expect(proposed?.reviewState).toBe("pending-baseline");

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

  });

  /**
   * **Verification runs** — every run after the first, which is the one that actually catches a
   * regression, and the read-model a human judges it through (ticket #6).
   *
   * The first run only ever proposes. What is under test here is the second: with a golden
   * approved, a verdict finally means something, and the two directions it can go have to land as
   * the right two words. `fail` → the slot is `diff` and the run READS as `regression`; `pass` →
   * the slot is `passed` and a complete run reads `passed`. Nothing in between, and nothing that
   * re-rolls either answer.
   *
   * The other half is the shape of the run a person opens: contextual comparison and no pixel door
   * left ajar, the reasoning and both images on every slot, an unreached slot that reads
   * differently from a failed one, one root cause instead of five failures, the evidence, and a
   * place in the same runs list and dashboard as everything else.
   */
  describe("verification runs and the agent-driven run view", () => {
    let verifyTestId: string;

    interface RunViewBody {
      runId: string;
      kind: string;
      status: string;
      outcome: string;
      failureKind: string | null;
      agentSummary: string | null;
      agentInstructions: string | null;
      evidence: { id: string; url: string; note: string; createdAt: string }[];
      unreached: {
        checkpointName: string;
        step: number;
        lastReached: string | null;
        alsoUnreached: string[];
        resumed: boolean;
      } | null;
      checkpoints: {
        name: string;
        reviewState: string;
        compareMode: string;
        judgeReasoning: string | null;
        actualUrl: string | null;
        baselineUrl: string | null;
        capture: { tool: string | null; viewport: string | null; deviceScale: number | null } | null;
      }[];
    }

    const runView = async (runId: string): Promise<RunViewBody> =>
      (await authed(app).get(`/runs/${runId}`).expect(200)).body as RunViewBody;

    /** Walk a whole journey and approve every capture, so the NEXT run has goldens to judge
     *  against. The first run is always a proposal; this is what turns it into a baseline. */
    const seedBaselines = async (names: string[]): Promise<void> => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      for (const name of names) await submit(session.runId, name);
      await authed(app).post(`/runs/${session.runId}/approve-all`).expect(201);
    };

    beforeAll(async () => {
      const created = await authed(app)
        .post("/tests/agent")
        .send({ name: "verification journey", instructions: "Sign in as qa@acme.io / hunter2." })
        .expect(201);
      verifyTestId = created.body.id as string;
      for (const cp of [
        { name: "login", instructions: "Sign in.", comparePrompt: "The dashboard shell is rendered." },
        { name: "chart", instructions: "Open the analytics tab.", comparePrompt: "The chart has bars. Today's values will differ — that is expected." },
        // Deliberately blank: this is the row that falls back to the configured global default.
        { name: "export", instructions: "Open the export dialog.", comparePrompt: "" },
      ]) {
        await authed(app).post(`/tests/${verifyTestId}/agent-checkpoints`).send(cp).expect(201);
      }
      await seedBaselines(["login", "chart", "export"]);
    });

    it("turns a fail against an approved baseline into a diff, and the run into a regression", async () => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      expect(session.manifest.every((m) => m.hasBaseline)).toBe(true);

      await submit(session.runId, "login");
      const failed = await submit(session.runId, "chart", {
        verdict: "fail",
        reasoning: "The chart area is empty. The golden shows seven bars; this render has axes and no series at all, which is not a data difference.",
      });
      expect(failed.hadBaseline).toBe(true);
      expect(failed.reviewState).toBe("diff");
      await submit(session.runId, "export");

      const finished = await ok<FinishResult>(mcpToken(), "finish_agent_run", {
        runId: session.runId,
        summary: "Walked all three. The analytics chart came up empty on every reload.",
      });
      expect(finished.outcome).toBe("regression");
      expect(finished.unreached).toEqual([]);

      // And the same word through the read-model a human actually opens.
      const view = await runView(session.runId);
      expect(view.outcome).toBe("regression");
      expect(view.checkpoints.find((c) => c.name === "chart")?.reviewState).toBe("diff");
      // `unreached` is not how this run failed — it got everywhere and one thing looked wrong.
      expect(view.failureKind).toBeNull();
      expect(view.unreached).toBeNull();
    });

    it("turns a pass against an approved baseline into a verified pass for the whole run", async () => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      for (const name of ["login", "chart", "export"]) await submit(session.runId, name);

      const finished = await ok<FinishResult>(mcpToken(), "finish_agent_run", {
        runId: session.runId,
        summary: "All three matched their goldens; the chart's values moved, which the prompt allows.",
      });
      expect(finished.outcome).toBe("passed");
      expect(finished.status).toBe("passed");

      const view = await runView(session.runId);
      expect(view.outcome).toBe("passed");
      expect(view.checkpoints.map((c) => c.reviewState)).toEqual(["passed", "passed", "passed"]);
    });

    /**
     * The comparison is contextual for this kind in every configuration, and that has to be true
     * of the READ-MODEL too — not only of what the runner would have done. An agent test's one
     * version row is a zero-step stub, so a `compareMode` inferred from the definition falls
     * through to `pixel` and the run view then offers threshold readouts, mask editors and a diff
     * score for a verdict that was argued, not measured.
     */
    it("reads every checkpoint as contextual, and leaves no pixel door open", async () => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      await submit(session.runId, "login", {
        verdict: "fail",
        reasoning: "The shell is there but the nav is missing entirely.",
      });

      const view = await runView(session.runId);
      expect(view.kind).toBe("agent");
      expect(view.checkpoints.every((c) => c.compareMode === "context")).toBe(true);

      // Preview re-diff: mutates nothing, which is exactly why it was the easy one to leave open.
      // It would hand back a diff score for a checkpoint nobody measured.
      const reEval = await authed(app)
        .post(`/runs/${session.runId}/checkpoints/login/re-evaluate`)
        .send({ threshold: 0.9 })
        .expect(400);
      expect(reEval.body.message).toContain("Agent-Driven Test");

      // And the committing one, which would also write a second version row.
      await authed(app)
        .post(`/runs/${session.runId}/checkpoints/login/persist`)
        .send({ masks: [{ x: 0, y: 0, width: 10, height: 10 }] })
        .expect(400);
    });

    it("falls back to the configured global default judge prompt when a row leaves it blank", async () => {
      const DEFAULT_PROMPT =
        "Compare the two screenshots for meaning, not pixels: same page, same structure, same state. Content that is expected to change may change.";
      await authed(app).put("/settings/judge").send({ defaultPrompt: DEFAULT_PROMPT }).expect(200);

      const { session } = await start({ testId: verifyTestId, environmentId });
      const blank = session.manifest.find((m) => m.name === "export");
      expect(blank?.comparePrompt).toBe(DEFAULT_PROMPT);
      // The composed document the run keeps a copy of carries it too — the agent is told the same
      // thing the Manifest says, and a run from six weeks ago still explains what it was judging by.
      expect(session.instructions).toContain(DEFAULT_PROMPT);

      // A row that wrote its own prompt keeps it: the default fills a gap, it does not override.
      expect(session.manifest.find((m) => m.name === "chart")?.comparePrompt).toContain(
        "Today's values will differ",
      );
    });

    it("shows the reasoning beside both images on every filled slot, with how it was captured", async () => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      const REASONING =
        "Seven bars against the golden's seven, same axis labels, same legend. The bar heights differ because these are today's numbers.";
      await submit(session.runId, "chart", {
        reasoning: REASONING,
        capture: { tool: "chrome-devtools", viewport: "1440x900", deviceScale: 2 },
      });

      const chart = (await runView(session.runId)).checkpoints.find((c) => c.name === "chart");
      // The argument for the verdict, and the two pictures it is an argument about. Varys watched
      // none of this, so all three together are the entire audit trail.
      expect(chart?.judgeReasoning).toBe(REASONING);
      expect(chart?.actualUrl).toBeTruthy();
      expect(chart?.baselineUrl).toBeTruthy();
      expect(chart?.capture).toEqual({ tool: "chrome-devtools", viewport: "1440x900", deviceScale: 2 });
    });

    it("reads an unreached slot as its own fact, distinct from a capture that failed", async () => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      await submit(session.runId, "login", {
        verdict: "fail",
        reasoning: "The shell renders but the sidebar is gone.",
      });

      const view = await runView(session.runId);
      const byName = new Map(view.checkpoints.map((c) => [c.name, c]));
      // "Got there and it looked wrong" — there is a picture, and a human owes it a decision.
      expect(byName.get("login")?.reviewState).toBe("diff");
      expect(byName.get("login")?.actualUrl).toBeTruthy();
      // "Could not get there" — no picture at all, and nothing for a reviewer to approve.
      expect(byName.get("chart")?.reviewState).toBe("missing");
      expect(byName.get("chart")?.actualUrl).toBeNull();
      expect(byName.get("chart")?.baselineUrl).toBeNull();
      // The run's own reason says which of the two ended it.
      expect(view.failureKind).toBe("unreached");
      // Still `running` as a display: this session has not closed and its lease has not run out,
      // so "chart" is a slot nobody has reported YET rather than one nobody ever will. The stored
      // run is red throughout regardless.
      expect(view.outcome).toBe("running");
      expect(view.status).toBe("failed");

      // An unreached slot is not review work: there is nothing to look at and nothing to approve,
      // so it reads `missing` rather than joining the captures that await a human decision.
      expect(byName.get("chart")?.reviewState).not.toBe("pending-baseline");
      expect(byName.get("chart")?.reviewState).not.toBe("diff");
    });

    it("states one root cause for a journey that stopped, not one failure per slot it never reached", async () => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      await submit(session.runId, "login");

      const view = await runView(session.runId);
      expect(view.unreached).toEqual({
        checkpointName: "chart",
        step: 2,
        lastReached: "login",
        alsoUnreached: ["export"],
        resumed: false,
      });
      // Two slots went unfilled and there is exactly one finding about them.
      expect(view.checkpoints.filter((c) => c.reviewState === "missing")).toHaveLength(2);
    });

    it("says so when the session carried on past the break, rather than claiming one cause explains it all", async () => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      // Skipped the chart, reached the export anyway — two things happened, and a summary that
      // says "it stopped at the chart" would be a comfortable lie.
      await submit(session.runId, "login");
      await submit(session.runId, "export");

      const view = await runView(session.runId);
      expect(view.unreached).toMatchObject({
        checkpointName: "chart",
        lastReached: "login",
        alsoUnreached: [],
        resumed: true,
      });
    });

    it("makes the agent's evidence and its written account browsable from the run", async () => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      await submit(session.runId, "login");
      await ok<{ attached: number }>(mcpToken(), "submit_evidence", {
        runId: session.runId,
        image: b64("console-errors"),
        note: "The console, full of 401s from /api/metrics.",
      });
      await ok<{ attached: number }>(mcpToken(), "submit_evidence", {
        runId: session.runId,
        image: b64("empty-chart"),
      });
      const SUMMARY =
        "Signed in fine. The analytics tab never rendered a chart — the metrics call 401s, so I could not reach the export either.";
      await ok<FinishResult>(mcpToken(), "finish_agent_run", { runId: session.runId, summary: SUMMARY });

      const view = await runView(session.runId);
      expect(view.agentSummary).toBe(SUMMARY);
      // The composed instructions ride along, so a run stays explainable after every layer of the
      // text behind it has been rewritten.
      expect(view.agentInstructions).toContain("qa@acme.io / hunter2");

      expect(view.evidence).toHaveLength(2);
      expect(view.evidence[0]).toMatchObject({ note: "The console, full of 401s from /api/metrics." });
      // Attached in session order, and an unnoted attachment is still browsable.
      expect(view.evidence[1].note).toBe("");
      // The bytes are actually fetchable, rather than a URL that 404s when a reviewer clicks it.
      const fetched = await authed(app).get(new URL(view.evidence[0].url, "http://x").pathname).expect(200);
      expect(Buffer.from(fetched.body).equals(png("console-errors"))).toBe(true);
    });

    it("sits in the runs list and on the dashboard on the same footing as a pinned run", async () => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      for (const name of ["login", "chart", "export"]) await submit(session.runId, name);
      await ok<FinishResult>(mcpToken(), "finish_agent_run", {
        runId: session.runId,
        summary: "Clean walk, everything matched.",
      });

      // One corpus: the flat history carries it with the same outcome word every other run uses.
      const list = (await authed(app).get("/runs").expect(200)).body as {
        runId: string;
        testName: string;
        outcome: string;
      }[];
      const listed = list.find((r) => r.runId === session.runId);
      expect(listed).toMatchObject({ testName: "verification journey", outcome: "passed" });

      // And one view: the dashboard's matrix and activity feed both carry it, keyed by test and
      // environment exactly as a pinned test's would be.
      const dash = (await authed(app).get("/dashboard").expect(200)).body as {
        matrix: {
          environments: string[];
          rows: { testId: string; cells: { environment: string; status: string; runId: string | null }[] }[];
        };
        recentRuns: { runId: string }[];
      };
      const cell = dash.matrix.rows
        .find((r) => r.testId === verifyTestId)
        ?.cells.find((c) => c.environment === "staging");
      expect(cell?.status).toBe("passed");
      expect(cell?.runId).toBe(session.runId);
      expect(dash.recentRuns.some((r) => r.runId === session.runId)).toBe(true);
    });

    /**
     * The one thing nothing in Varys may do to a failed verdict: try it again.
     *
     * A contextual judge that catches a regression intermittently is precisely the case where a
     * retry policy makes a real bug vanish, so the guarantee is that there is no retry policy —
     * not on the server, not on a schedule, and not reachable by the agent inside its own session.
     */
    it("leaves a failed verdict alone — no server path, and no scheduled one, re-rolls it", async () => {
      const { session } = await start({ testId: verifyTestId, environmentId });
      await submit(session.runId, "chart", {
        verdict: "fail",
        reasoning: "Empty plot area against a golden with seven bars.",
      });

      // The agent cannot re-roll it inside the session it already reported in.
      const retry = await callTool(mcpToken(), "submit_checkpoint", {
        runId: session.runId,
        name: "chart",
        image: b64("chart-second-go"),
        verdict: "pass",
        reasoning: "Reloaded a few times and it eventually drew.",
      });
      expect(retry.isError).toBe(true);

      // Nor can anything schedule a re-walk. BOTH unattended doors are checked, because the
      // scheduler fires per-test schedules straight into `RunsService.create` as well as fanning
      // suites out — so "a schedule only ever runs a suite" would be a comfortable and wrong
      // reason to check only one of them.
      const refusedSuite = await authed(app)
        .post("/suites")
        .send({ name: "nightly regression", testIds: [verifyTestId] });
      expect(refusedSuite.status).toBe(400);

      const refusedSchedule = await authed(app)
        .patch(`/tests/${verifyTestId}`)
        .send({ schedule: { cron: "0 2 * * *", timezone: "UTC" } });
      expect(refusedSchedule.status).toBe(400);

      // And the test really is unscheduled afterwards, rather than refused by a check that ran
      // after the write.
      const after = (await authed(app).get(`/tests/${verifyTestId}`).expect(200)).body as {
        schedule: unknown | null;
      };
      expect(after.schedule ?? null).toBeNull();

      const rows = await rowsOf(session.runId);
      expect(rows.find((r) => r.name === "chart")?.reviewState).toBe("diff");
    });
  });

  /**
   * The **wall-clock lease** (ticket #7) — the bound on an agent that will not stop.
   *
   * Retrying is deliberately the agent's own business: it knows why it failed and can vary its
   * approach, where a blind replay only re-rolls the dice. But an agent retrying a state that will
   * NEVER appear — the page was removed, the instructions are wrong — has no reason ever to stop,
   * and it is the author's own Claude subscription it is spending.
   *
   * The property worth more than any of the refusals: expiry needs NOTHING to run. The run has
   * been `failed`/`unreached` since its rows were seeded, so a session whose time simply ran out
   * is already correctly red — no sweeper, no reconciliation, and no cooperation from the agent,
   * which by definition is the one thing an abandoned session cannot supply. The refusals below
   * only stop a late arrival from writing over that answer.
   *
   * Leases here are one second and waited out for real, rather than backdating the deadline in the
   * database. Reaching around the API to expire a run would test the column and not the bound.
   */
  describe("the wall-clock lease", () => {
    let leaseTestId: string;

    /**
     * Wall-clock, since that is the thing under test — a shade over the lease, so a slow box
     * crossing the deadline late still crosses it.
     *
     * A test that has to report something BEFORE the deadline passes a longer lease: the submit
     * writes a PNG, looks up a baseline and rolls the run's status up, and on a loaded machine
     * that is not reliably under a second. Cutting it fine there would make this suite fail for
     * the one reason it is not testing.
     */
    const waitOutLease = (seconds = 1) =>
      new Promise((resolve) => setTimeout(resolve, seconds * 1_000 + 400));

    interface RunViewSession {
      session: { leaseSeconds: number; leaseExpiresAt: string; state: string } | null;
      agentSummary: string | null;
      status: string;
      failureKind: string | null;
    }
    const runView = async (runId: string): Promise<RunViewSession> =>
      (await authed(app).get(`/runs/${runId}`).expect(200)).body as RunViewSession;

    const leaseOf = async (id: string): Promise<number> =>
      ((await authed(app).get(`/tests/${id}/config`).expect(200)).body as { agentLeaseSeconds: number })
        .agentLeaseSeconds;

    beforeAll(async () => {
      const created = await authed(app)
        .post("/tests/agent")
        .send({ name: "lease journey", instructions: "Sign in as qa@acme.io / hunter2." })
        .expect(201);
      leaseTestId = created.body.id as string;
      for (const cp of [
        { name: "arrive", instructions: "Open the app.", comparePrompt: "The shell is rendered." },
        { name: "search", instructions: "Search for a term.", comparePrompt: "Results are listed." },
        { name: "detail", instructions: "Open the first result.", comparePrompt: "The detail panel is open." },
      ]) {
        await authed(app).post(`/tests/${leaseTestId}/agent-checkpoints`).send(cp).expect(201);
      }
    }, 60_000);

    // Nothing opts in to being bounded. A test nobody has thought about is the one most likely to
    // be left grinding, so the default has to apply to every existing row and every new one.
    it("bounds a session on a test nobody configured, with a modest default", async () => {
      expect(await leaseOf(testId)).toBe(900);

      const before = Date.now();
      const { session } = await start({ testId, environmentId });
      expect(session.leaseSeconds).toBe(900);

      const deadline = Date.parse(session.leaseExpiresAt);
      expect(deadline).toBeGreaterThanOrEqual(before + 900_000);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 900_000);

      // Said out loud to the agent, rather than left to be discovered by a refusal: one that knows
      // its remaining time can spend it on the checkpoint most likely to be reachable.
      expect(session.note).toContain("wall-clock lease of 15 minutes");

      const row = await runRow(session.runId);
      expect(row.leaseSeconds).toBe(900);
      expect(row.leaseExpiresAt?.toISOString()).toBe(session.leaseExpiresAt);
    });

    it("takes the bound from the test, so a slow journey can be given longer", async () => {
      await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: 3600 }).expect(200);
      expect(await leaseOf(leaseTestId)).toBe(3600);

      const { session } = await start({ testId: leaseTestId, environmentId });
      expect(session.leaseSeconds).toBe(3600);
      expect(session.note).toContain("wall-clock lease of 1 hour");
    });

    /**
     * The lease is COPIED onto the run, for the same reason the composed instructions are: the
     * setting is editable and unversioned, so without the copy "was this run given a minute or an
     * hour?" stops being answerable the moment somebody changes it.
     */
    it("keeps the lease the session was granted when the test's is changed afterwards", async () => {
      await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: 600 }).expect(200);
      const { session } = await start({ testId: leaseTestId, environmentId });
      const granted = session.leaseExpiresAt;

      await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: 7200 }).expect(200);

      const row = await runRow(session.runId);
      expect(row.leaseSeconds).toBe(600);
      expect(row.leaseExpiresAt?.toISOString()).toBe(granted);
      expect((await runView(session.runId)).session).toMatchObject({ leaseSeconds: 600 });
    });

    it("refuses a lease on a pinned test, which has no session to bound", async () => {
      const refused = await authed(app)
        .patch(`/tests/${pinnedTestId}`)
        .send({ agentLeaseSeconds: 300 });
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain("pinned test");
    });

    // A ceiling and no floor: too long is the silent failure the lease exists for, too short says
    // so on the very next run. Only the value that stops being a bound is refused.
    it("refuses a lease that is not a bound, and leaves the old one in place", async () => {
      await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: 60 }).expect(200);
      for (const bad of [0, -30, 1.5, 86_401]) {
        expect((await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: bad })).status).toBe(400);
      }
      expect(await leaseOf(leaseTestId)).toBe(60);
    });

    /**
     * The load-bearing test of this ticket. A session is started, ONE slot is reported, and then
     * the agent simply stops — no finish, no error, nothing. The lease runs out on the wall clock.
     *
     * Everything asserted afterwards holds without the agent having cooperated with anything: the
     * run is red with reason `unreached` because its rows were seeded that way and two of them were
     * never filled, and the one slot that WAS reported keeps its verdict, its image and its
     * reasoning — expiry closes a session, it does not discard what the session achieved.
     */
    /**
     * The runs LIST, not just the run view.
     *
     * A session walking the journey right now and one that ended red an hour ago are the same row
     * of `missing` slots, and before this the list had no way to tell them apart — every fresh
     * Agent Run Session appeared as `Failed` the instant it started, while the agent was still
     * driving. The stored status stays `failed` throughout, absolutely; what changes is only what
     * the list is entitled to SAY about a session that has not ended.
     */
    it("reads running in the runs list while the session is open, and red the moment it is not", async () => {
      await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: 3 }).expect(200);
      const { session } = await start({ testId: leaseTestId, environmentId });

      const listed = async () => {
        const res = await authed(app).get(`/runs?testId=${leaseTestId}`).expect(200);
        return (res.body as { runId: string; status: string; outcome: string; session: { state: string } | null }[])
          .find((r) => r.runId === session.runId);
      };

      const during = await listed();
      expect(during?.outcome).toBe("running");
      expect(during?.session?.state).toBe("open");
      // The claim is about display only. Underneath, the run is exactly as red as it always was.
      expect(during?.status).toBe("failed");
      expect((await runRow(session.runId)).failureKind).toBe("unreached");

      await waitOutLease(3);

      const after = await listed();
      // No sweeper ran and nothing was written — the lease simply passed, and the answer changed.
      expect(after?.outcome).toBe("failed");
      expect(after?.session?.state).toBe("expired");
    });

    it("closes the session when the clock runs out, leaving a red run nobody had to report", async () => {
      await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: 3 }).expect(200);
      const { session } = await start({ testId: leaseTestId, environmentId });

      const first = await submit(session.runId, "arrive", {
        image: b64("arrive-before-expiry"),
        reasoning: "The shell rendered with the nav in place.",
      });
      expect(first.reviewState).toBe("pending-baseline");

      await waitOutLease(3);

      const rows = await rowsOf(session.runId);
      expect(rows.map((r) => [r.name, r.reviewState])).toEqual([
        ["arrive", "pending-baseline"],
        ["search", "missing"],
        ["detail", "missing"],
      ]);
      // Kept whole: the capture, the verdict it was given and the reasoning behind it.
      expect(rows[0].actualArtifactKey).toBeTruthy();
      expect(rows[0].judgeReasoning).toBe("The shell rendered with the nav in place.");
      expect(await storage.get(rows[0].actualArtifactKey as string)).toEqual(png("arrive-before-expiry"));

      const row = await runRow(session.runId);
      expect(row.status).toBe("failed");
      expect(row.failureKind).toBe("unreached");
      // And nothing wrote a summary, because nothing closed the session — which is exactly what
      // makes it distinguishable from an agent that got to the end and reported.
      expect(row.agentSummary).toBeNull();
    });

    /** Every door a late agent could still write through. `finish_agent_run` is refused along with
     *  the two submissions: a summary written after the bound would make the run read as a session
     *  that reached the end and reported, which is the one thing the view has to keep distinct. */
    it("refuses every further submission once the lease has run out", async () => {
      await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: 1 }).expect(200);
      const { session } = await start({ testId: leaseTestId, environmentId });
      await waitOutLease();

      const late = await callTool(mcpToken(), "submit_checkpoint", {
        runId: session.runId,
        name: "arrive",
        image: b64("too-late"),
        verdict: "pass",
        reasoning: "I got there in the end.",
      });
      expect(late.isError).toBe(true);
      expect(late.content[0]?.text).toContain("wall-clock lease");

      const evidence = await callTool(mcpToken(), "submit_evidence", {
        runId: session.runId,
        image: b64("too-late-evidence"),
      });
      expect(evidence.isError).toBe(true);

      const finished = await callTool(mcpToken(), "finish_agent_run", {
        runId: session.runId,
        summary: "Walked it all, honest.",
      });
      expect(finished.isError).toBe(true);

      // None of the three left a trace: the slot is still unfilled, no evidence was attached, and
      // the run still carries no summary.
      const rows = await rowsOf(session.runId);
      expect(rows.every((r) => r.reviewState === "missing")).toBe(true);
      const attached = await handle.db
        .select({ id: runEvidence.id })
        .from(runEvidence)
        .where(eq(runEvidence.runId, session.runId));
      expect(attached).toHaveLength(0);
      expect((await runRow(session.runId)).agentSummary).toBeNull();
    });

    /**
     * AC6, and the reason the lease is worth having beyond stopping the grinding: three states
     * that a run with unfilled slots used to collapse into one. Before this, "still walking" and
     * "gave up hours ago" were the same row.
     */
    it("reads as expired, open or finished — never the wrong one of the three", async () => {
      await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: 3600 }).expect(200);
      const open = await start({ testId: leaseTestId, environmentId });
      expect((await runView(open.session.runId)).session).toMatchObject({
        leaseSeconds: 3600,
        state: "open",
      });

      // Finished INSIDE its lease, and it stays finished — the deadline must never overtake a
      // summary and turn every completed agent run into an expired one an hour later.
      for (const name of ["arrive", "search", "detail"]) await submit(open.session.runId, name);
      await ok<FinishResult>(mcpToken(), "finish_agent_run", {
        runId: open.session.runId,
        summary: "Walked all three and captured each one.",
      });
      expect((await runView(open.session.runId)).session).toMatchObject({ state: "finished" });

      await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: 1 }).expect(200);
      const lapsed = await start({ testId: leaseTestId, environmentId });
      await waitOutLease();
      const view = await runView(lapsed.session.runId);
      expect(view.session).toMatchObject({ leaseSeconds: 1, state: "expired" });
      expect(view.agentSummary).toBeNull();
      expect(view.failureKind).toBe("unreached");
    });

    /**
     * The bound closes a session; it does not invent a failure. A run whose every slot was filled
     * before the clock ran out is exactly as red or as green as its rows say — expiry adds nothing
     * to it, which is the difference between a lease and a timeout that fails the thing it bounds.
     */
    it("does not turn an expired run red when every slot was actually filled", async () => {
      await authed(app).patch(`/tests/${leaseTestId}`).send({ agentLeaseSeconds: 3 }).expect(200);
      const { session } = await start({ testId: leaseTestId, environmentId });
      for (const name of ["arrive", "search", "detail"]) await submit(session.runId, name);
      await waitOutLease(3);

      const rows = await rowsOf(session.runId);
      expect(rows.some((r) => r.reviewState === "missing")).toBe(false);
      const row = await runRow(session.runId);
      expect(row.failureKind).toBeNull();
      expect(row.status).not.toBe("failed");
      expect((await runView(session.runId)).session).toMatchObject({ leaseSeconds: 3, state: "expired" });
    });
  });

  /**
   * The third and outermost layer of **AI Instructions** (ticket #8).
   *
   * Three layers, composed general → specific — suite, then test, then the checkpoint's own — and
   * CONCATENATED, never overridden. The load-bearing assertions are about order and survival: a
   * layer that can be silently dropped is a layer whose author cannot tell whether it took effect,
   * and a composed document nobody kept is a run that stops being explainable the moment any of
   * the three is edited.
   *
   * Membership is written straight into `suite_tests` here, and that is deliberate rather than a
   * shortcut. `assertNoAgentTests` refuses an Agent-Driven Test at the point of JOINING a suite —
   * nothing can run one unattended (PRD, "Not suite-eligible") — so there is no API call that
   * produces this row today. The composition path is real and ships now; what does not exist yet
   * is a supported way to reach it. Everything below this line is the production code path, with
   * the single exception of how the membership row got there.
   */
  describe("suite-level AI Instructions", () => {
    const SUITE_INSTRUCTIONS =
      "Everything here runs against the ACME staging tenant. Ignore the release-notes banner.";
    let suiteTestId: string;

    /** A suite carrying instructions, with `testId` recorded as an explicit member. */
    const suiteWith = async (name: string, instructions: string | null, member: string) => {
      const [row] = await handle.db
        .insert(suites)
        .values({ name, agentInstructions: instructions })
        .returning({ id: suites.id });
      await handle.db.insert(suiteTests).values({ suiteId: row.id, testId: member });
      return row.id;
    };

    beforeAll(async () => {
      const created = await authed(app)
        .post("/tests/agent")
        .send({ name: "suite-layer journey", instructions: "TEST-LAYER-TEXT" })
        .expect(201);
      suiteTestId = created.body.id as string;
      await authed(app)
        .post(`/tests/${suiteTestId}/agent-checkpoints`)
        .send({ name: "landed", instructions: "CHECKPOINT-LAYER-TEXT", comparePrompt: "It looks right." })
        .expect(201);
    });

    afterAll(async () => {
      await handle.db.delete(suiteTests).where(eq(suiteTests.testId, suiteTestId));
    });

    /** Drop every suite membership this test has, so each case composes from a known layer set. */
    const clearSuites = () => handle.db.delete(suiteTests).where(eq(suiteTests.testId, suiteTestId));

    it("composes the three layers general to specific — suite, then test, then the checkpoint", async () => {
      await clearSuites();
      await suiteWith("Checkout", SUITE_INSTRUCTIONS, suiteTestId);

      const { session } = await start({ testId: suiteTestId, environmentId });

      const suiteAt = session.instructions.indexOf(SUITE_INSTRUCTIONS);
      const testAt = session.instructions.indexOf("TEST-LAYER-TEXT");
      const checkpointAt = session.instructions.indexOf("CHECKPOINT-LAYER-TEXT");
      expect(suiteAt).toBeGreaterThan(-1);
      expect(suiteAt).toBeLessThan(testAt);
      expect(testAt).toBeLessThan(checkpointAt);
    });

    /**
     * The compensating control for instructions being unversioned. Not "the run has some text" —
     * the run has THE text, byte for byte, so six weeks later the run still explains itself after
     * all three layers have been rewritten underneath it.
     */
    it("stores the composed text on the run, identical to what the agent was handed", async () => {
      await clearSuites();
      await suiteWith("Checkout", SUITE_INSTRUCTIONS, suiteTestId);

      const { session } = await start({ testId: suiteTestId, environmentId });

      const [row] = await handle.db
        .select({ instructions: runs.agentInstructions })
        .from(runs)
        .where(eq(runs.id, session.runId))
        .limit(1);
      expect(row.instructions).toBe(session.instructions);
      expect(row.instructions).toContain(SUITE_INSTRUCTIONS);
    });

    /**
     * The whole reason they are concatenated rather than merged. Two layers that contradict each
     * other both reach the agent — because there is no per-key structure in prose to override
     * along, and because a suite silently winning is how an author's test-level instruction
     * disappears without anything saying so.
     */
    it("concatenates a suite and a test that contradict each other rather than letting one win", async () => {
      await clearSuites();
      await suiteWith("Contradictory", "Log in as qa@acme.io.", suiteTestId);
      await authed(app)
        .patch(`/tests/${suiteTestId}`)
        .send({ brief: "Log in as admin@acme.io." })
        .expect(200);

      const { session } = await start({ testId: suiteTestId, environmentId });
      expect(session.instructions).toContain("Log in as qa@acme.io.");
      expect(session.instructions).toContain("Log in as admin@acme.io.");

      await authed(app).patch(`/tests/${suiteTestId}`).send({ brief: "TEST-LAYER-TEXT" }).expect(200);
    });

    it("carries every suite the test belongs to, in name order, so neither outranks the other", async () => {
      await clearSuites();
      await suiteWith("Zulu suite", "ZULU-CONTEXT", suiteTestId);
      await suiteWith("Alpha suite", "ALPHA-CONTEXT", suiteTestId);

      const { session } = await start({ testId: suiteTestId, environmentId });
      expect(session.instructions).toContain("ALPHA-CONTEXT");
      expect(session.instructions).toContain("ZULU-CONTEXT");
      expect(session.instructions.indexOf("ALPHA-CONTEXT")).toBeLessThan(
        session.instructions.indexOf("ZULU-CONTEXT"),
      );
    });

    it("leaves no trace of a suite that carries no instructions", async () => {
      await clearSuites();
      const withNone = (await start({ testId: suiteTestId, environmentId })).session.instructions;

      await suiteWith("Silent suite", null, suiteTestId);
      const withBlank = (await start({ testId: suiteTestId, environmentId })).session.instructions;

      expect(withBlank).toBe(withNone);
      expect(withBlank).not.toContain("Silent suite");
    });

    /**
     * The preview is only worth having if it is the SAME document. An approximation assembled by
     * a second code path would be a preview of something else, and an author would be checking
     * the wrong text against the run that baffled them.
     */
    it("previews exactly the text the next session receives, without starting anything", async () => {
      await clearSuites();
      await suiteWith("Checkout", SUITE_INSTRUCTIONS, suiteTestId);

      const before = await handle.db.select({ id: runs.id }).from(runs);
      const preview = await authed(app)
        .get(`/tests/${suiteTestId}/agent-instructions?environmentId=${environmentId}`)
        .expect(200);
      const after = await handle.db.select({ id: runs.id }).from(runs);
      expect(after.length).toBe(before.length); // a preview starts nothing

      expect(preview.body.suites).toEqual(["Checkout"]);
      expect(preview.body.environment).toBe("staging");
      expect(preview.body.checkpointCount).toBe(1);

      const { session } = await start({ testId: suiteTestId, environmentId });
      expect(preview.body.instructions).toBe(session.instructions);
    });

    it("names no suite in the preview when none contributed", async () => {
      await clearSuites();
      await suiteWith("Silent suite", "   ", suiteTestId);

      const preview = await authed(app)
        .get(`/tests/${suiteTestId}/agent-instructions`)
        .expect(200);
      expect(preview.body.suites).toEqual([]);
      expect(preview.body.environment).toBe("default");
    });

    /**
     * A pinned test is replayed from recorded steps with no model call, so there is nothing in it
     * that could read a word of this. Refused rather than answered with an empty document: an
     * empty preview reads as "the suite contributes nothing to this test", when the truth is that
     * this kind of test is never given AI Instructions at all.
     */
    it("applies none of it to a pinned member, which has no AI Instructions to be given", async () => {
      const suiteId = await suiteWith("Mixed", SUITE_INSTRUCTIONS, pinnedTestId);
      const res = await authed(app).get(`/tests/${pinnedTestId}/agent-instructions`).expect(404);
      expect(res.body.message).toMatch(/pinned/i);
      await handle.db.delete(suiteTests).where(eq(suiteTests.suiteId, suiteId));
    });
  });
});
