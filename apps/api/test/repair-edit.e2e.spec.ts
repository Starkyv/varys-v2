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
 * Repair sessions — editing the test, not just its broken locator.
 *
 * `apply_fix` covers the one repair that must never be a guess (a locator, verified against the
 * live page). This suite covers the rest of what a person actually asks for once they are looking
 * at a failing test: rename the checkpoint, judge it with an LLM instead of pixel-diffing it, mask
 * a volatile region, fix the value that gets typed, add a step, drop one, put two in the right
 * order — and re-park the browser on whichever step the conversation moved to. Driven through the
 * MCP surface with a deterministic JSON-RPC script (no LLM).
 */
describe("Repair session → editing the test", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let pool: Pool;
  let runId: string;
  let testId: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    fixture.setVariant("twins");
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    // A test with more than a locator to get wrong: a checkpoint with a threshold and an approved
    // baseline behind its name, and a failing click in the middle. Written straight to the DB —
    // what's under test is the edit path, not how the rows got there.
    pool = new Pool({ connectionString: db.connectionString });
    testId = randomUUID();
    const versionId = randomUUID();
    runId = randomUUID();
    const definition = {
      name: "editable fixture",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "click",
          target: { tag: "button", role: "button", accessibleName: "Publish now", text: "Publish now" },
        },
        { type: "screenshot", name: "report-view", captureMode: "fullpage", compareMode: "pixel", threshold: 0.02 },
      ],
    };
    await pool.query(`INSERT INTO tests (id, name, status, origin) VALUES ($1, $2, 'active', 'ai')`, [
      testId,
      "editable test",
    ]);
    await pool.query(
      `INSERT INTO test_versions (id, test_id, version, definition) VALUES ($1, $2, 1, $3)`,
      [versionId, testId, JSON.stringify(definition)],
    );
    await pool.query(
      `INSERT INTO runs (id, test_version_id, status, error, failed_step_index)
       VALUES ($1, $2, 'failed', $3, 1)`,
      [runId, versionId, 'Step 2/3 — click "Publish now": could not locate click target'],
    );
    await pool.query(
      `INSERT INTO baselines (test_id, checkpoint_name, environment, viewport_key, artifact_key)
       VALUES ($1, 'report-view', 'default', '1280x800@1', 'baselines/report-view.png')`,
      [testId],
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

  const toolError = async (name: string, args: unknown): Promise<string> => {
    const res = await rpc("tools/call", { name, arguments: args }).expect(200);
    expect(res.body.result.isError).toBe(true);
    return res.body.result.content[0].text as string;
  };

  const latestDefinition = async () => {
    const rows = await pool.query(
      `SELECT version, definition FROM test_versions WHERE test_id = $1 ORDER BY version DESC LIMIT 1`,
      [testId],
    );
    return rows.rows[0] as { version: number; definition: { steps: Record<string, unknown>[] } };
  };

  it("reads the whole test as an editable surface, addressable by step index", async () => {
    // Readable without a session at all — the test id is what a user has to hand.
    const view = await callTool("read_test", { testId });
    expect(view).toMatchObject({ testId, version: 1, name: "editable test" });
    expect(view.steps).toHaveLength(3);
    // Every step reports the fields an edit can address on it — and only those.
    expect(view.steps[0]).toMatchObject({ index: 0, type: "navigate", url: fixture.url });
    expect(view.steps[1]).toMatchObject({ index: 1, type: "click" });
    expect(view.steps[1].locator.accessibleName).toBe("Publish now");
    expect(view.steps[2]).toMatchObject({
      index: 2,
      type: "screenshot",
      checkpointName: "report-view",
      captureMode: "fullpage",
      compareMode: "pixel",
      threshold: 0.02,
      hasBaseline: true,
    });
  }, 90_000);

  it("changes checkpoint settings — and carries the baseline over on a rename", async () => {
    const before = await latestDefinition();
    const edited = await callTool("edit_test", {
      testId,
      steps: [
        {
          index: 2,
          name: "report-summary",
          compareMode: "context",
          prompt: "both are generated reports; fail only if the current one is empty or an error",
        },
      ],
    });
    expect(edited.version).toBe(before.version + 1);
    expect(edited.baseVersion).toBe(before.version);
    // The applied edits are echoed in plain words, so the answer to "what did you change" is not
    // reconstructed from memory.
    expect(edited.changes.join(" ")).toMatch(/renamed the checkpoint/i);

    const after = await latestDefinition();
    expect(after.definition.steps[2]).toMatchObject({
      name: "report-summary",
      compareMode: "context",
    });
    // A checkpoint's name IS its baseline key. The approved golden follows the rename rather than
    // being orphaned — otherwise the next run silently starts over at pending-baseline.
    const baselines = await pool.query(
      `SELECT checkpoint_name, artifact_key FROM baselines WHERE test_id = $1`,
      [testId],
    );
    expect(baselines.rows).toEqual([
      { checkpoint_name: "report-summary", artifact_key: "baselines/report-view.png" },
    ]);
  }, 90_000);

  it("refuses an edit aimed at the wrong step, before writing anything", async () => {
    const before = await latestDefinition();
    // A field that belongs to another step type is almost always a wrong index, not a wrong field.
    const wrongType = await toolError("edit_test", {
      testId,
      steps: [{ index: 1, prompt: "judge this" }],
    });
    expect(wrongType).toMatch(/step 2 is a click step/i);

    const outOfRange = await toolError("edit_test", { testId, steps: [{ index: 9, value: "x" }] });
    expect(outOfRange).toMatch(/no step 9/i);

    // And a reorder has to account for every surviving step, or it is a typo rather than an intent.
    const badOrder = await toolError("edit_test", { testId, order: [0, 2] });
    expect(badOrder).toMatch(/order/i);

    const after = await latestDefinition();
    expect(after.version).toBe(before.version);
  }, 90_000);

  it("adds a step built from the live page, then removes and reorders steps", async () => {
    const opened = await callTool("open_repair_session", { runId });
    const sid: string = opened.sessionId;

    // The button the broken step should have been aiming at, as the session sees it live.
    const snapshot = await callTool("observe", { sessionId: sid });
    const target = snapshot.nodes.find((n: { id?: string }) => n.id === "new-report");
    expect(target).toBeDefined();

    // Insert a click on it, addressed by ref: the server captures the real fingerprint off the
    // page, so the added step carries the full multi-signal bundle a recording would.
    const added = await callTool("edit_test", {
      sessionId: sid,
      inserts: [{ atIndex: 1, position: "below", step: { type: "click", ref: target.ref } }],
    });
    expect(added.changes.join(" ")).toMatch(/inserted a click step/i);
    let def = (await latestDefinition()).definition;
    expect(def.steps).toHaveLength(4);
    const inserted = def.steps[2] as { type: string; target: Record<string, unknown> };
    expect(inserted.type).toBe("click");
    expect(inserted.target).toMatchObject({ tag: "button", role: "button" });
    // A captured target, not a hand-written selector standing on its own.
    expect(inserted.target.selectorOverride).toBeUndefined();
    expect(inserted.target.attributes).toMatchObject({ id: "new-report" });

    // The response's step list is the new truth — indices moved when the step landed.
    expect(added.steps.map((s: Record<string, unknown>) => s.type)).toEqual([
      "navigate",
      "click",
      "click",
      "screenshot",
    ]);

    // Drop the original broken step and put the checkpoint before the surviving click.
    const restructured = await callTool("edit_test", {
      sessionId: sid,
      steps: [{ index: 1, remove: true }],
      order: [0, 3, 2],
    });
    expect(restructured.changes.join(" ")).toMatch(/removed step 2/i);
    def = (await latestDefinition()).definition;
    expect(def.steps.map((s) => s.type)).toEqual(["navigate", "screenshot", "click"]);

    // The entry navigation can never stop being the first thing that happens.
    const moved = await toolError("edit_test", { sessionId: sid, order: [2, 1, 0] });
    expect(moved).toMatch(/entry navigation/i);

    await callTool("close_repair_session", { sessionId: sid });
  }, 120_000);

  it("re-parks on another step, and keeps working on the test as edited", async () => {
    const opened = await callTool("open_repair_session", { runId });
    const sid: string = opened.sessionId;
    // The session opened on the version that RAN (3 steps, failing at index 1)…
    expect(opened.step.index).toBe(1);

    // …but an edit lands on the LATEST, and the session follows it there.
    const edited = await callTool("edit_test", {
      sessionId: sid,
      steps: [{ index: 1, name: "report-summary-v2" }],
    });
    expect(edited.changes.join(" ")).toMatch(/renamed the checkpoint/i);
    // The parked page predates the edit, and the response says so rather than implying otherwise.
    expect(edited.note).toMatch(/parked/i);

    // Re-parking drives the edited test from the top and lands where asked.
    const parked = await callTool("goto_step", { sessionId: sid, stepIndex: 2 });
    expect(parked.step.index).toBe(2);
    expect(parked.step.of).toBe(3);
    expect(parked.nodes.length).toBeGreaterThan(0);

    const outOfRange = await toolError("goto_step", { sessionId: sid, stepIndex: 12 });
    expect(outOfRange).toMatch(/out of range/i);

    await callTool("close_repair_session", { sessionId: sid });
  }, 120_000);
});
