import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mcpAuthed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Repair sessions — diagnosing a FAILED run by re-driving it.
 *
 * The thing under test is the loop a broken test actually needs: replay the recorded steps to the
 * point the Run died, park the browser there, ask the real matcher why the recorded locator no
 * longer resolves, and try candidate fixes against that live page. Driven through the MCP surface
 * with a deterministic JSON-RPC script (no LLM), against a seeded failed run.
 */
describe("Repair session → diagnose a failed run", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let pool: Pool;
  let runId: string;
  let testId: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    // The page the broken step will be diagnosed against: repeated rows, unlabelled controls,
    // and one button with a stable id — i.e. both a dead end and a real fix.
    fixture.setVariant("twins");
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    // Seed a test whose second step targets a control that does not exist on the page, and a run
    // that failed on it — the shape of every "could not locate click target" in the wild. Written
    // straight to the DB: what's under test is the repair path, not how the rows got there.
    pool = new Pool({ connectionString: db.connectionString });
    testId = randomUUID();
    const versionId = randomUUID();
    runId = randomUUID();
    const definition = {
      name: "repair fixture",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "click",
          target: { tag: "button", role: "button", accessibleName: "Publish now", text: "Publish now" },
        },
      ],
    };
    await pool.query(`INSERT INTO tests (id, name, status, origin) VALUES ($1, $2, 'active', 'ai')`, [
      testId,
      "repairable test",
    ]);
    await pool.query(
      `INSERT INTO test_versions (id, test_id, version, definition) VALUES ($1, $2, 1, $3)`,
      [versionId, testId, JSON.stringify(definition)],
    );
    await pool.query(
      `INSERT INTO runs (id, test_version_id, status, error, failed_step_index)
       VALUES ($1, $2, 'failed', $3, 1)`,
      [runId, versionId, 'Step 2/2 — click "Publish now": could not locate click target'],
    );
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  const rpc = (method: string, params: unknown, id: number | null = 1) =>
    mcpAuthed(app).post("/mcp").send({ jsonrpc: "2.0", id, method, params });

  const callTool = async (name: string, args: unknown) => {
    const res = await rpc("tools/call", { name, arguments: args }).expect(200);
    expect(res.body.error).toBeUndefined();
    if (res.body.result.isError) {
      throw new Error(`tool ${name} failed: ${res.body.result.content?.[0]?.text}`);
    }
    return JSON.parse(res.body.result.content[0].text);
  };

  it("finds the failed run, reproduces it, and refuses to record anything", async () => {
    // The entry point: a failed run is findable by test name, with the step that broke.
    const failures = await callTool("failed_runs", { testName: "repairable" });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      runId,
      testId,
      failedStepIndex: 1,
      failedStep: 'click "Publish now"',
    });

    // Re-drive the test's own steps to the failure and park there.
    const opened = await callTool("open_repair_session", { runId });
    const sid: string = opened.sessionId;
    expect(opened.mode).toBe("repair");
    expect(opened.step).toMatchObject({ index: 1, of: 2, label: 'click "Publish now"' });

    // The prefix ran clean, so we are parked on the page the failing step actually faced —
    // not stopped short somewhere upstream.
    expect(opened.replay.brokeAt).toBeNull();
    expect(opened.replay.reachedStep).toBe(1);

    // The diagnosis: the recorded locator does not resolve here. That — not the run's error
    // string — is the answer to "why is this step failing".
    expect(opened.recordedLocator.accessibleName).toBe("Publish now");
    expect(opened.diagnosis.status).toBe("not-found");
    expect(opened.replay.reproduced).toBe(true);

    // And the page is perceivable, so an alternative can be found rather than guessed at.
    expect(opened.nodes.length).toBeGreaterThan(0);
    expect(opened.nodes.some((n: { name: string }) => n.name === "New report")).toBe(true);

    // A repair session is diagnostic, not authoring: it must not be able to leave anything behind.
    const shot = await rpc("tools/call", {
      name: "checkpoint",
      arguments: { sessionId: sid, name: "nope", mode: "fullpage" },
    }).expect(200);
    expect(shot.body.result.isError).toBe(true);
    expect(shot.body.result.content[0].text).toMatch(/records nothing/i);

    const fin = await rpc("tools/call", {
      name: "finish_session",
      arguments: { sessionId: sid, confirm: true },
    }).expect(200);
    expect(fin.body.result.isError).toBe(true);
    expect(fin.body.result.content[0].text).toMatch(/no draft to save/i);

    await callTool("close_repair_session", { sessionId: sid });
  }, 90_000);

  it("judges candidate fixes against the parked page, and only recommends durable ones", async () => {
    const opened = await callTool("open_repair_session", { runId });
    const sid: string = opened.sessionId;

    // A candidate that is still wrong stays not-found — the probe does not flatter a guess.
    const wrong = await callTool("try_locator", { sessionId: sid, accessibleName: "Still not here" });
    expect(wrong.status).toBe("not-found");
    expect(wrong.recommend).toBe(false);

    // A name that DOES exist resolves — but on visible text, which is the signal that goes stale.
    // It is offered as recordable-with-a-caveat, not as the fix.
    const byName = await callTool("try_locator", {
      sessionId: sid,
      accessibleName: "New report",
      role: "",
    });
    expect(byName.status).toBe("resolved");
    expect(byName.verdict).toBe("text-bound");

    // The durable fix: an explicit selector the matcher uses as-is when it is unique.
    const fixed = await callTool("try_locator", { sessionId: sid, selectorOverride: "#new-report" });
    expect(fixed.status).toBe("resolved");
    expect(fixed.matchedSignal).toBe("override");
    expect(fixed.verdict).toBe("deterministic");
    expect(fixed.recommend).toBe(true);
    // The patch is echoed back so the diagnosis can name the exact edit to apply.
    expect(fixed.patch).toEqual({ selectorOverride: "#new-report" });
    expect(fixed.stepIndex).toBe(1);

    // Nothing was written: the test still has exactly the one version it started with.
    const versions = await pool.query(`SELECT count(*)::int AS n FROM test_versions WHERE test_id = $1`, [
      testId,
    ]);
    expect(versions.rows[0].n).toBe(1);

    await callTool("close_repair_session", { sessionId: sid });
  }, 90_000);
});
