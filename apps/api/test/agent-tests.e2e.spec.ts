import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle, baselines } from "@varys/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

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
    process.env.DATABASE_URL = db.connectionString;
    handle = createDb(db.connectionString);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();
  });

  afterAll(async () => {
    await handle?.pool.end();
    await app?.close();
    await db?.container.stop();
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
});
