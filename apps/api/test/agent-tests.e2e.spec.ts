import "reflect-metadata";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle, baselines } from "@varys/db";
import type { AgentCheckpoint, CreatedAgentCredential } from "@varys/review-contract";
import { LocalFsAdapter } from "@varys/storage-adapter";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, mcpToken, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";
import {
  mcpCallTool,
  mcpRpc,
  mcpTool,
  mcpToolNames,
  pngBase64,
  pngFixture,
  pngSha256,
  pngTruncated,
} from "./mcp-harness";

/**
 * Agent-Driven Tests — the authoring surface (no agent involved).
 *
 * Chromium-free by construction: Varys hosts no browser for this kind, so nothing here needs
 * `processRun`, the fixture app or Playwright. Everything under test is a write and a refusal.
 *
 * The properties worth more than the happy path are the ones that protect something already
 * approved or already promised:
 *
 *  - a rename must CARRY its baselines, or renaming for clarity quietly destroys approvals
 *  - two checkpoints must not share a name, enforced by the DATABASE — the Checkpoint Manifest's
 *    closed-set property rests on it, and a check in one write path is not a constraint
 *  - a suite or schedule must REFUSE one, because nothing can run it unattended and a nightly
 *    suite that silently skips a member is worse than one that won't accept it
 *  - editing must never write a test_version — the whole point of making this kind unversioned
 */
describe("Agent-Driven Tests — authoring", () => {
  let app: INestApplication;
  let db: TestDb;
  let handle: DbHandle;
  let storageDir: string;
  let storage: LocalFsAdapter;

  const PINNED = {
    name: "pinned smoke",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    steps: [
      { type: "navigate", url: "http://fixture.local/" },
      { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
    ],
  };

  /** Create an Agent-Driven Test and return its id. */
  async function createAgentTest(name: string, instructions?: string): Promise<string> {
    const res = await authed(app).post("/tests/agent").send({ name, instructions }).expect(201);
    return res.body.id as string;
  }

  async function addCheckpoint(
    testId: string,
    body: { name: string; instructions?: string; comparePrompt?: string },
  ) {
    const res = await authed(app).post(`/tests/${testId}/agent-checkpoints`).send(body).expect(201);
    return res.body;
  }

  /** How many version rows a test has — the unversioned claim, measured. */
  async function versionCount(testId: string): Promise<number> {
    const { rows } = await handle.pool.query<{ n: string }>(
      "select count(*)::text as n from test_versions where test_id = $1",
      [testId],
    );
    return Number(rows[0].n);
  }

  beforeAll(async () => {
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-agenttests-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    handle = createDb(db.connectionString);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();
    storage = new LocalFsAdapter(storageDir);
  }, 180_000);

  afterAll(async () => {
    await handle?.pool.end();
    await app?.close();
    await db?.container.stop();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it("creates an agent-driven test that is active immediately, human-authored, and needs no promotion", async () => {
    const id = await createAgentTest("analytics dashboard", "Log in as qa@acme.io / hunter2.");

    const list = await authed(app).get("/tests").expect(200);
    const row = list.body.find((t: { id: string }) => t.id === id);
    // Present in the ACTIVE list at all — a Draft would be absent, which is the whole distinction.
    expect(row).toBeDefined();
    expect(row).toMatchObject({ kind: "agent", status: "active", origin: "human" });
  });

  it("leaves every pre-existing test pinned", async () => {
    const created = await authed(app).post("/tests").send(PINNED).expect(201);
    const list = await authed(app).get("/tests").expect(200);
    const row = list.body.find((t: { id: string }) => t.id === created.body.id);
    expect(row.kind).toBe("pinned");
  });

  it("stores the AI Instructions on the test and lets them be edited without a new version", async () => {
    const id = await createAgentTest("instructions test", "First draft.");
    expect(await versionCount(id)).toBe(1);

    await authed(app).patch(`/tests/${id}`).send({ brief: "Second draft, much longer." }).expect(200);

    const config = await authed(app).get(`/tests/${id}/config`).expect(200);
    expect(config.body.brief).toBe("Second draft, much longer.");
    // The point of the whole unversioned decision: iterating on wording is not an audit event.
    expect(await versionCount(id)).toBe(1);
  });

  it("adds, edits, reorders and deletes checkpoints without ever writing a version", async () => {
    const id = await createAgentTest("journey");

    const login = await addCheckpoint(id, { name: "login-page", instructions: "Open the app." });
    const dash = await addCheckpoint(id, { name: "dashboard", instructions: "Log in." });
    const filtered = await addCheckpoint(id, { name: "filtered", comparePrompt: "7-day range in the header." });

    let list = (await authed(app).get(`/tests/${id}/agent-checkpoints`).expect(200)).body;
    expect(list.map((c: { name: string }) => c.name)).toEqual(["login-page", "dashboard", "filtered"]);
    expect(list.map((c: { position: number }) => c.position)).toEqual([0, 1, 2]);

    await authed(app)
      .patch(`/tests/${id}/agent-checkpoints/${dash.id}`)
      .send({ instructions: "Log in and wait for the chart.", comparePrompt: "A populated chart." })
      .expect(200);

    // Reorder is a whole-list permutation: the journey is cumulative, so a partial one would
    // silently change what each later instruction may assume.
    await authed(app)
      .post(`/tests/${id}/agent-checkpoints/reorder`)
      .send({ ids: [filtered.id, login.id, dash.id] })
      .expect(200);

    list = (await authed(app).get(`/tests/${id}/agent-checkpoints`).expect(200)).body;
    expect(list.map((c: { name: string }) => c.name)).toEqual(["filtered", "login-page", "dashboard"]);
    expect(list.map((c: { position: number }) => c.position)).toEqual([0, 1, 2]);
    expect(list[2].instructions).toBe("Log in and wait for the chart.");

    await authed(app).delete(`/tests/${id}/agent-checkpoints/${login.id}`).expect(200);
    list = (await authed(app).get(`/tests/${id}/agent-checkpoints`).expect(200)).body;
    expect(list.map((c: { name: string }) => c.name)).toEqual(["filtered", "dashboard"]);
    // Deleting closes the gap rather than leaving a hole in the sequence.
    expect(list.map((c: { position: number }) => c.position)).toEqual([0, 1]);

    expect(await versionCount(id)).toBe(1);
  });

  it("refuses a reorder that does not name every checkpoint exactly once", async () => {
    const id = await createAgentTest("partial reorder");
    const a = await addCheckpoint(id, { name: "a" });
    await addCheckpoint(id, { name: "b" });

    await authed(app).post(`/tests/${id}/agent-checkpoints/reorder`).send({ ids: [a.id] }).expect(400);
    await authed(app)
      .post(`/tests/${id}/agent-checkpoints/reorder`)
      .send({ ids: [a.id, a.id] })
      .expect(400);
  });

  it("refuses two checkpoints with the same name on one test, in the database", async () => {
    const id = await createAgentTest("dupes");
    await addCheckpoint(id, { name: "dashboard" });
    await authed(app).post(`/tests/${id}/agent-checkpoints`).send({ name: "dashboard" }).expect(409);

    // Reaching the same collision by RENAME is the path a check on the insert would miss.
    const other = await addCheckpoint(id, { name: "settings" });
    await authed(app)
      .patch(`/tests/${id}/agent-checkpoints/${other.id}`)
      .send({ name: "dashboard" })
      .expect(409);

    // The constraint is per test, not global — two tests may both have a "dashboard".
    const second = await createAgentTest("dupes elsewhere");
    await authed(app).post(`/tests/${second}/agent-checkpoints`).send({ name: "dashboard" }).expect(201);
  });

  it("carries a checkpoint's approved baselines across every environment when it is renamed", async () => {
    const id = await createAgentTest("renamer");
    const cp = await addCheckpoint(id, { name: "dashboard-empty" });

    // Two environments' worth of approved baselines, as a real test would accumulate.
    await handle.db.insert(baselines).values([
      { testId: id, checkpointName: "dashboard-empty", environment: "staging", viewportKey: "1280x800@1", artifactKey: "a" },
      { testId: id, checkpointName: "dashboard-empty", environment: "prod", viewportKey: "1280x800@1", artifactKey: "b" },
      // A sibling checkpoint's baseline, which must NOT be dragged along by the rename.
      { testId: id, checkpointName: "other", environment: "staging", viewportKey: "1280x800@1", artifactKey: "c" },
    ]);

    await authed(app)
      .patch(`/tests/${id}/agent-checkpoints/${cp.id}`)
      .send({ name: "dashboard-loaded" })
      .expect(200);

    const { rows } = await handle.pool.query<{ checkpoint_name: string; environment: string }>(
      "select checkpoint_name, environment from baselines where test_id = $1 order by checkpoint_name, environment",
      [id],
    );
    expect(rows).toEqual([
      { checkpoint_name: "dashboard-loaded", environment: "prod" },
      { checkpoint_name: "dashboard-loaded", environment: "staging" },
      { checkpoint_name: "other", environment: "staging" },
    ]);
  });

  it("reports what deleting a checkpoint would cost before it happens", async () => {
    const id = await createAgentTest("impact");
    const cp = await addCheckpoint(id, { name: "chart" });
    await handle.db.insert(baselines).values([
      { testId: id, checkpointName: "chart", environment: "staging", viewportKey: "1280x800@1", artifactKey: "a" },
      { testId: id, checkpointName: "chart", environment: "prod", viewportKey: "1280x800@1", artifactKey: "b" },
    ]);

    const impact = await authed(app)
      .get(`/tests/${id}/agent-checkpoints/${cp.id}/delete-impact`)
      .expect(200);
    expect(impact.body).toEqual({
      checkpointName: "chart",
      environments: ["prod", "staging"],
      baselineCount: 2,
    });

    // Asking must not be the same as doing.
    const still = await authed(app).get(`/tests/${id}/agent-checkpoints`).expect(200);
    expect(still.body).toHaveLength(1);
  });

  it("refuses to put an agent-driven test in a suite, and keeps folder-selected ones out", async () => {
    const agentId = await createAgentTest("unrunnable");
    const pinned = await authed(app).post("/tests").send(PINNED).expect(201);

    await authed(app)
      .post("/suites")
      .send({ name: "nightly", testIds: [pinned.body.id, agentId] })
      .expect(400);

    const suite = await authed(app).post("/suites").send({ name: "nightly", testIds: [pinned.body.id] }).expect(201);
    await authed(app).put(`/suites/${suite.body.id}`).send({ testIds: [agentId] }).expect(400);

    // A folder is a STANDING selection, so filing an agent test into a suited folder must not
    // smuggle in a member the suite can never run.
    const folder = await authed(app).post("/folders").send({ name: "dash" }).expect(201);
    await authed(app).patch(`/tests/${agentId}`).send({ folderId: folder.body.id }).expect(200);
    await authed(app).patch(`/tests/${pinned.body.id}`).send({ folderId: folder.body.id }).expect(200);
    await authed(app).put(`/suites/${suite.body.id}`).send({ testIds: [], folderIds: [folder.body.id] }).expect(200);

    const view = await authed(app).get(`/suites/${suite.body.id}`).expect(200);
    const memberIds = (view.body.tests ?? []).map((t: { id: string }) => t.id);
    expect(memberIds).toContain(pinned.body.id);
    expect(memberIds).not.toContain(agentId);
  });

  it("refuses to run an agent-driven test through Varys's worker", async () => {
    const id = await createAgentTest("not the worker's job");
    // The stub version has zero steps, so a replay would capture nothing, compare nothing, and —
    // having no checkpoints to redden — derive a PASS. This is the false green the whole feature
    // is built to refuse, reachable from the plain Run button.
    await authed(app).post("/runs").send({ testId: id }).expect(400);
  });

  it("never fans a suite run out to an agent-driven test reached through a folder", async () => {
    const agentId = await createAgentTest("folder stowaway");
    const pinned = await authed(app).post("/tests").send(PINNED).expect(201);
    const folder = await authed(app).post("/folders").send({ name: "nightly flows" }).expect(201);
    await authed(app).patch(`/tests/${agentId}`).send({ folderId: folder.body.id }).expect(200);
    await authed(app).patch(`/tests/${pinned.body.id}`).send({ folderId: folder.body.id }).expect(200);

    const suite = await authed(app)
      .post("/suites")
      .send({ name: "by folder", folderIds: [folder.body.id] })
      .expect(201);

    const triggered = await authed(app).post(`/suites/${suite.body.id}/runs`).send({}).expect(201);

    // Read the fan-out's OWN children rather than the runs list: this asserts what the suite
    // actually queued, without depending on when a queued run becomes visible elsewhere.
    const suiteRun = await authed(app).get(`/suite-runs/${triggered.body.suiteRunId}`).expect(200);
    const childTestIds = (suiteRun.body.children ?? []).map((c: { testId: string }) => c.testId);
    // The fan-out resolves folders itself at trigger time, so filtering only the read-model would
    // hide the member in the UI while still queueing a run for it.
    expect(childTestIds).not.toContain(agentId);
    expect(childTestIds).toContain(pinned.body.id);
  });

  it("drops a checkpoint's approved baselines when it is deleted, as the confirm promised", async () => {
    const id = await createAgentTest("deleter");
    const cp = await addCheckpoint(id, { name: "chart" });
    const keep = await addCheckpoint(id, { name: "header" });
    await handle.db.insert(baselines).values([
      { testId: id, checkpointName: "chart", environment: "staging", viewportKey: "1280x800@1", artifactKey: "a" },
      { testId: id, checkpointName: "chart", environment: "prod", viewportKey: "1280x800@1", artifactKey: "b" },
      { testId: id, checkpointName: "header", environment: "staging", viewportKey: "1280x800@1", artifactKey: "c" },
    ]);

    await authed(app).delete(`/tests/${id}/agent-checkpoints/${cp.id}`).expect(200);

    const { rows } = await handle.pool.query<{ checkpoint_name: string }>(
      "select checkpoint_name from baselines where test_id = $1",
      [id],
    );
    expect(rows).toEqual([{ checkpoint_name: "header" }]);

    // And the freed name can be taken by a rename, which orphaned baselines would have blocked
    // on `baselines`' own unique key for a reason with no visible cause.
    await authed(app)
      .patch(`/tests/${id}/agent-checkpoints/${keep.id}`)
      .send({ name: "chart" })
      .expect(200);
  });

  it("refuses to schedule an agent-driven test, but still lets a schedule be cleared", async () => {
    const id = await createAgentTest("unschedulable");
    await authed(app)
      .patch(`/tests/${id}`)
      .send({ schedule: { cron: "0 3 * * *", timezone: "UTC", enabled: true } })
      .expect(400);
    // Clearing can only ever make things more true, so it stays allowed.
    await authed(app).patch(`/tests/${id}`).send({ schedule: null }).expect(200);
  });

  it("refuses the step-config surface, the other door that would write a version", async () => {
    const id = await createAgentTest("no config");
    await authed(app).put(`/tests/${id}/config`).send({ baseVersion: 1, steps: [] }).expect(400);
    expect(await versionCount(id)).toBe(1);
  });

  it("refuses checkpoint routes on a pinned test", async () => {
    const pinned = await authed(app).post("/tests").send(PINNED).expect(201);
    await authed(app).get(`/tests/${pinned.body.id}/agent-checkpoints`).expect(400);
    await authed(app).post(`/tests/${pinned.body.id}/agent-checkpoints`).send({ name: "x" }).expect(400);
  });

  it("files into folders and takes tags like any other test", async () => {
    const id = await createAgentTest("filed");
    const folder = await authed(app).post("/folders").send({ name: "agent flows" }).expect(201);
    await authed(app)
      .patch(`/tests/${id}`)
      .send({ folderId: folder.body.id, tags: ["smoke", "dashboard"] })
      .expect(200);

    const list = await authed(app).get("/tests").expect(200);
    const row = list.body.find((t: { id: string }) => t.id === id);
    expect(row.folderId).toBe(folder.body.id);
    expect(row.tags).toEqual(["dashboard", "smoke"]);
  });
  /**
   * Claude writes the test — the authoring half of the same kind, over `/mcp` (ticket #10).
   *
   * Everything above this block is a person typing into the editor. Everything below is the
   * author's own Claude writing the same rows through the same services, and the interesting
   * assertions are all refusals: the three things Varys will not let it do are the entire reason
   * handing it a write surface is safe.
   *
   * The load-bearing one is the required image. Prose describing a state Claude reached and prose
   * describing one it imagined are indistinguishable on the page, so the picture is the only thing
   * separating them — and a refusal that left a row behind would be no refusal at all.
   */
  describe("authored by Claude over /mcp", () => {
    interface ToolDescriptor {
      name: string;
      inputSchema: { properties?: Record<string, unknown>; required?: string[] };
    }

    /** The AI Instructions Claude authored — the artifact, not the sentence that asked for it. */
    const AUTHORED = [
      "App is on http://localhost:3000. Sign in as qa@acme.io / hunter2.",
      "Dismiss the cookie banner if it appears. Never touch anything under Settings > Danger zone.",
    ].join("\n");

    const create = (name: string, instructions = AUTHORED) =>
      mcpTool<{ testId: string; name: string; kind: string; status: string; origin: string }>(
        app,
        mcpToken(),
        "create_agent_test",
        { name, instructions },
      );

    const addCp = (
      testId: string,
      name: string,
      extra: Record<string, unknown> = {},
    ) =>
      mcpCallTool(app, mcpToken(), "add_agent_checkpoint", {
        testId,
        name,
        instructions: `Drive to ${name}.`,
        comparePrompt: `The ${name} state is on screen.`,
        image: pngBase64(name),
        ...extra,
      });

    /** The checkpoints as the web editor reads them — the Draft is queryable between calls. */
    const checkpointsOf = async (testId: string): Promise<AgentCheckpoint[]> =>
      (await authed(app).get(`/tests/${testId}/agent-checkpoints`).expect(200)).body;

    const testRow = async (testId: string) => {
      const { rows } = await handle.pool.query<{
        kind: string;
        status: string;
        origin: string;
        intent: string | null;
        name: string;
      }>("select kind, status, origin, intent, name from tests where id = $1", [testId]);
      return rows[0];
    };

    const previewRows = async (testId: string) => {
      const { rows } = await handle.pool.query<{ checkpoint_name: string; artifact_key: string }>(
        "select checkpoint_name, artifact_key from draft_previews where test_id = $1 order by checkpoint_name",
        [testId],
      );
      return rows;
    };

    it("writes a Draft carrying the AI Instructions it authored, and not the prompt that asked for it", async () => {
      const created = await create("dashboard journey");

      expect(created.kind).toBe("agent");
      expect(created.status).toBe("draft");
      expect(created.origin).toBe("ai");

      const row = await testRow(created.testId);
      expect(row.name).toBe("dashboard journey");
      expect(row.kind).toBe("agent");
      expect(row.status).toBe("draft");
      expect(row.origin).toBe("ai");
      // The Brief slot carries the authored artifact byte-for-byte — this is what every future
      // run is composed from, so anything else here is an instruction nobody wrote.
      expect(row.intent).toBe(AUTHORED);

      // It is in the review queue from the moment it exists — an abandoned pass leaves a visibly
      // incomplete Draft rather than nothing.
      const queue = await authed(app).get("/drafts").expect(200);
      expect(queue.body.map((d: { id: string }) => d.id)).toContain(created.testId);

      // The steering prompt has nowhere to land: the tool's whole declared input is a name and
      // the authored instructions. Without that, "make me a test for the dashboard" would reach
      // `intent` and become every future run's standing orders.
      const listed = await mcpRpc(app, mcpToken(), "tools/list", {}).expect(200);
      const tool = (listed.body.result.tools as ToolDescriptor[]).find(
        (t) => t.name === "create_agent_test",
      );
      expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
        "instructions",
        "name",
      ]);
    });

    it("accumulates Checkpoints in journey order across separate calls, queryable between them", async () => {
      const { testId } = await create("checkout journey");

      expect(await checkpointsOf(testId)).toEqual([]);

      for (const name of ["signed-in", "cart-filled", "order-placed"]) {
        const res = await addCp(testId, name);
        expect(res.isError, res.content[0]?.text).toBeFalsy();
        // Readable BETWEEN calls, not only at the end — there is no finish step to wait for.
        const so_far = await checkpointsOf(testId);
        expect(so_far[so_far.length - 1].name).toBe(name);
      }

      const cps = await checkpointsOf(testId);
      expect(cps.map((c) => c.name)).toEqual(["signed-in", "cart-filled", "order-placed"]);
      expect(cps.map((c) => c.position)).toEqual([0, 1, 2]);
      expect(cps[0].instructions).toBe("Drive to signed-in.");
      expect(cps[0].comparePrompt).toBe("The signed-in state is on screen.");

      // The single version row, written at creation and never again.
      expect(await versionCount(testId)).toBe(1);
    });

    it("refuses a Checkpoint with no image, leaving no row and no artifact", async () => {
      const { testId } = await create("no picture no checkpoint");

      const res = await addCp(testId, "imagined-state", { image: "" });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/image/i);

      expect(await checkpointsOf(testId)).toEqual([]);
      expect(await previewRows(testId)).toEqual([]);
      expect(await storage.get(`drafts/${testId}/imagined-state/preview.png`)).toBeNull();
    });

    it("refuses something that is not a PNG, for the same reason", async () => {
      const { testId } = await create("not a png");
      const res = await addCp(testId, "jpeg-state", {
        image: Buffer.from("/tmp/screenshot.png").toString("base64"),
      });
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/PNG/i);
      expect(await checkpointsOf(testId)).toEqual([]);
    });

    /**
     * The capture arrives whole, or not at all.
     *
     * This is a regression suite for a real, silent data loss: a 10,871-byte screenshot was stored
     * as 2,345 bytes with no error anywhere. `Buffer.from(s, "base64")` does not throw on a
     * mangled string — Node decodes up to the first character outside the alphabet and returns
     * the prefix — and the PNG SIGNATURE, the only thing then checked, lives in the first eight
     * bytes and survives every truncation there is. So the artifact stored perfectly, passed
     * every check, and rendered as half a picture.
     *
     * Two things made it unrecoverable rather than annoying. Nothing verified the bytes end to
     * end; and a Checkpoint name is taken exactly once, so there was no second attempt at the
     * slot. Hence both halves below: `imagePath`, which keeps the bytes out of the model's output
     * altogether, and the end-to-end checks that make a corrupt upload a refusal instead of a row.
     */
    describe("the capture arrives whole, or not at all", () => {
      /** The bytes as they exist on the agent's own disk, before any encoding. */
      const capture = pngFixture("dashboard");

      const writeCapture = async (name: string, bytes = capture): Promise<string> => {
        const path = join(storageDir, `${name}.png`);
        await writeFile(path, bytes);
        return path;
      };

      it("refuses base64 that was cut short, which the signature alone cannot detect", async () => {
        const { testId } = await create("truncated in transit");

        // A valid header, real content, and no end — byte for byte what a clipped base64 string
        // decodes to. Before the IEND check this was stored, and looked entirely fine.
        const half = pngTruncated("dashboard");
        expect(half.subarray(0, 8)).toEqual(capture.subarray(0, 8)); // the signature survived

        const res = await addCp(testId, "dashboard", { image: half.toString("base64") });
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toMatch(/TRUNCATED/);

        expect(await checkpointsOf(testId)).toEqual([]);
        expect(await storage.get(`drafts/${testId}/dashboard/preview.png`)).toBeNull();
      });

      it("refuses base64 carrying a stray character rather than decoding the part before it", async () => {
        const { testId } = await create("corrupt in transit");
        const b64 = capture.toString("base64");

        const res = await addCp(testId, "dashboard", {
          image: `${b64.slice(0, 4)}!${b64.slice(5)}`,
        });
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toMatch(/not valid base64/);
        expect(await checkpointsOf(testId)).toEqual([]);
      });

      it("refuses base64 whose length cannot encode any whole number of bytes", async () => {
        const { testId } = await create("length is wrong");
        const res = await addCp(testId, "dashboard", {
          image: `${capture.toString("base64").replace(/=+$/, "")}A`,
        });
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toMatch(/cut short/);
        expect(await checkpointsOf(testId)).toEqual([]);
      });

      it("takes the file itself from imagePath, so the bytes never pass through the model", async () => {
        const { testId } = await create("read it off disk");
        const path = await writeCapture("from-disk");

        const res = await addCp(testId, "dashboard", { image: "", imagePath: path });
        expect(res.isError, res.content[0]?.text).toBeFalsy();

        const stored = await storage.get(`drafts/${testId}/dashboard/preview.png`);
        expect(stored?.equals(capture)).toBe(true);
      });

      it("refuses a relative imagePath, which would resolve against the server's cwd", async () => {
        const { testId } = await create("relative path");
        const res = await addCp(testId, "dashboard", { image: "", imagePath: "./shot.png" });
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toMatch(/ABSOLUTE/);
        expect(await checkpointsOf(testId)).toEqual([]);
      });

      it("refuses an imagePath that is not there, rather than writing a row about nothing", async () => {
        const { testId } = await create("no such file");
        const res = await addCp(testId, "dashboard", {
          image: "",
          imagePath: join(storageDir, "never-captured.png"),
        });
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toMatch(/no such file/);
        expect(await checkpointsOf(testId)).toEqual([]);
      });

      it("refuses both sources at once — two of them is no answer to which was stored", async () => {
        const { testId } = await create("one source only");
        const path = await writeCapture("both");
        const res = await addCp(testId, "dashboard", { image: pngBase64("other"), imagePath: path });
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toMatch(/EITHER/);
        expect(await checkpointsOf(testId)).toEqual([]);
      });

      it("refuses imagePath from a client that is not on this machine", async () => {
        const { testId } = await create("not your filesystem");
        const path = await writeCapture("someone-elses");

        // A forwarding header means the socket peer is a proxy and the real client is elsewhere —
        // so the path would name a file on the SERVER. Disqualifying, not merely unhelpful.
        const res = await request(app.getHttpServer())
          .post("/mcp")
          .set("Authorization", `Bearer ${mcpToken()}`)
          .set("X-Forwarded-For", "203.0.113.7")
          .send({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "add_agent_checkpoint",
              arguments: {
                testId,
                name: "dashboard",
                instructions: "Drive to dashboard.",
                comparePrompt: "The dashboard is on screen.",
                imagePath: path,
              },
            },
          })
          .expect(200);

        const result = res.body.result as { isError?: boolean; content: { text?: string }[] };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toMatch(/same machine/);
        expect(await checkpointsOf(testId)).toEqual([]);
      });

      it("verifies a sha256 the agent sends with its base64, and stores nothing when it differs", async () => {
        const { testId } = await create("hash checked");

        const wrong = await addCp(testId, "dashboard", {
          image: pngBase64("dashboard"),
          sha256: pngSha256(pngFixture("a different capture entirely")),
        });
        expect(wrong.isError).toBe(true);
        expect(wrong.content[0]?.text).toMatch(/does not match the `sha256`/);
        expect(await checkpointsOf(testId)).toEqual([]);

        const right = await addCp(testId, "dashboard", {
          image: pngBase64("dashboard"),
          sha256: pngSha256(capture),
        });
        expect(right.isError, right.content[0]?.text).toBeFalsy();
        expect((await checkpointsOf(testId)).map((c) => c.name)).toEqual(["dashboard"]);
      });

      it("offers the path and the hash in the tool schema, and requires neither source by name", async () => {
        const res = await mcpRpc(app, mcpToken(), "tools/list", {}).expect(200);
        const tools = res.body.result.tools as ToolDescriptor[];

        for (const name of ["add_agent_checkpoint", "submit_checkpoint", "submit_evidence"]) {
          const tool = tools.find((t) => t.name === name);
          expect(tool, name).toBeDefined();
          expect(Object.keys(tool!.inputSchema.properties ?? {}), name).toEqual(
            expect.arrayContaining(["image", "imagePath", "sha256"]),
          );
          // `image` cannot be a required property once a path will do — the refusal for sending
          // neither lives in `decodePng`, where it can say which of the two to send.
          expect(tool!.inputSchema.required, name).not.toContain("image");
        }
      });
    });

    it("refuses two Checkpoints with the same name on one test, in the database", async () => {
      const { testId } = await create("one name one slot");
      expect((await addCp(testId, "dashboard")).isError).toBeFalsy();

      const again = await addCp(testId, "dashboard", { image: pngBase64("second try") });
      expect(again.isError).toBe(true);
      expect(again.content[0]?.text).toMatch(/already has a checkpoint named "dashboard"/);

      expect((await checkpointsOf(testId)).length).toBe(1);
      // The first capture is untouched — a refused duplicate must not overwrite the picture that
      // already belongs to that slot.
      const stored = await storage.get(`drafts/${testId}/dashboard/preview.png`);
      expect(stored?.equals(pngFixture("dashboard"))).toBe(true);
    });

    it("stores each capture as a draft preview — a reference image, never a baseline", async () => {
      const { testId } = await create("captures land as previews");
      await addCp(testId, "first");
      await addCp(testId, "second");

      const previews = await previewRows(testId);
      expect(previews.map((p) => p.checkpoint_name)).toEqual(["first", "second"]);
      for (const p of previews) {
        const bytes = await storage.get(p.artifact_key);
        expect(bytes?.equals(pngFixture(p.checkpoint_name))).toBe(true);
      }

      // Authoring proposes nothing. The first Run still produces the captures a human approves.
      const { rows } = await handle.pool.query<{ n: string }>(
        "select count(*)::text as n from baselines where test_id = $1",
        [testId],
      );
      expect(Number(rows[0].n)).toBe(0);

      // The Drafts queue shows the first Checkpoint's capture as the thumbnail.
      const detail = await authed(app).get(`/drafts/${testId}`).expect(200);
      expect(detail.body.intent).toBe(AUTHORED);
    });

    it("refuses a Checkpoint aimed at a promoted test, including one with a live Agent Run Session", async () => {
      const { testId } = await create("promoted then closed");
      await addCp(testId, "landing");
      await authed(app).post(`/drafts/${testId}/promote`).send({}).expect(201);

      const refused = await addCp(testId, "after-promotion");
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toMatch(/draft/i);
      expect((await checkpointsOf(testId)).map((c) => c.name)).toEqual(["landing"]);

      // And with a run in flight, which is the case that would matter most: a promoted test is
      // the only kind that can HAVE a session, so "the agent cannot edit the test it is running"
      // is already true here rather than being a separate rule.
      const env = await authed(app)
        .post("/environments")
        .send({ name: "authoring-staging", baseUrl: "https://staging.acme.io" })
        .expect(201);
      const session = await mcpTool<{ runId: string }>(app, mcpToken(), "start_agent_run", {
        testId,
        environmentId: env.body.id,
      });
      expect(session.runId).toBeTruthy();

      const duringRun = await addCp(testId, "mid-run");
      expect(duringRun.isError).toBe(true);
      expect((await checkpointsOf(testId)).map((c) => c.name)).toEqual(["landing"]);
    });

    it("refuses a Checkpoint aimed at a pinned Draft, whatever its status", async () => {
      const pinned = await authed(app).post("/tests").send(PINNED).expect(201);
      const res = await addCp(pinned.body.id as string, "hero");
      expect(res.isError).toBe(true);
      expect((await previewRows(pinned.body.id as string))).toEqual([]);
    });

    it("refuses both tools to an agent principal, and no capability grants them", async () => {
      // Provisioned with the RUN capability — the strongest credential Varys issues — so this
      // proves the authoring tools are outside it rather than merely off by default.
      const provisioned = await authed(app)
        .post("/settings/agent-credentials")
        .send({ label: "authoring-drainer", expiresInDays: 7, canStartAgentRuns: true })
        .expect(201);
      const agentToken = (provisioned.body as CreatedAgentCredential).token;
      expect((provisioned.body as CreatedAgentCredential).credential.canStartAgentRuns).toBe(true);

      const names = await mcpToolNames(app, agentToken);
      expect(names).not.toContain("create_agent_test");
      expect(names).not.toContain("add_agent_checkpoint");
      // The run capability it DOES hold is visible, so the absence above is a boundary and not a
      // credential that simply cannot see anything.
      expect(names).toContain("start_agent_run");

      const created = await mcpCallTool(app, agentToken, "create_agent_test", {
        name: "written by a machine at 3am",
        instructions: AUTHORED,
      });
      expect(created.isError).toBe(true);
      expect(created.content[0]?.text).toMatch(/Unknown tool/);

      const { testId } = await create("agent may not extend this");
      const added = await mcpCallTool(app, agentToken, "add_agent_checkpoint", {
        testId,
        name: "snuck-in",
        instructions: "Drive there.",
        comparePrompt: "It looks fine.",
        image: pngBase64("snuck-in"),
      });
      expect(added.isError).toBe(true);
      expect(added.content[0]?.text).toMatch(/Unknown tool/);
      expect(await checkpointsOf(testId)).toEqual([]);

      // Nothing was created under either refusal.
      const queue = await authed(app).get("/drafts").expect(200);
      expect(
        queue.body.some((d: { name: string }) => d.name === "written by a machine at 3am"),
      ).toBe(false);
    });

    it("promotes into a test that runs exactly like a hand-written one", async () => {
      const authoredId = (await create("authored journey")).testId;
      for (const name of ["step-one", "step-two"]) await addCp(authoredId, name);
      await authed(app).post(`/drafts/${authoredId}/promote`).send({}).expect(201);

      // The hand-written control, built through the editor's own routes with the same content.
      const handId = await createAgentTest("hand-written journey", AUTHORED);
      for (const name of ["step-one", "step-two"]) {
        await addCheckpoint(handId, {
          name,
          instructions: `Drive to ${name}.`,
          comparePrompt: `The ${name} state is on screen.`,
        });
      }

      const env = await authed(app)
        .post("/environments")
        .send({ name: "promotion-parity", baseUrl: "https://parity.acme.io" })
        .expect(201);
      const environmentId = env.body.id as string;

      interface Session {
        instructions: string;
        manifest: { step: number; name: string; instructions: string; comparePrompt: string }[];
      }
      const authoredRun = await mcpTool<Session>(app, mcpToken(), "start_agent_run", {
        testId: authoredId,
        environmentId,
      });
      const handRun = await mcpTool<Session>(app, mcpToken(), "start_agent_run", {
        testId: handId,
        environmentId,
      });

      expect(authoredRun.manifest).toEqual(handRun.manifest);
      // The only difference between the two documents is the test's own name in the heading.
      expect(authoredRun.instructions.replace("authored journey", "hand-written journey")).toBe(
        handRun.instructions,
      );

      expect(await versionCount(authoredId)).toBe(1);
    });
  });
});
