import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { authed, prepareAuth } from "./auth-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { AgentTestsService } from "../src/tests/agent-tests.service";
import { TestsService } from "../src/tests/tests.service";
import { startTestDb, type TestDb } from "./db-harness";
import { pngFixture } from "./mcp-harness";

/**
 * Slice 14 (Issue 5) — the Draft lifecycle, chromium-free. Seeds a draft through the
 * service (no browser), then exercises the human-facing rail: it's in the review queue,
 * excluded from the active Tests list (so it can't join a suite), promotable to active
 * with a folder + tags, and discardable. The review/promote UX itself is the manual
 * click-through gate; this pins the API behaviour behind it.
 */
const DEFINITION = {
  name: "seeded draft",
  viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  steps: [
    { type: "navigate", url: "{{baseUrl}}/" },
    { type: "screenshot", name: "home", captureMode: "fullpage" },
  ],
};

describe("Draft lifecycle", () => {
  let app: INestApplication;
  let db: TestDb;
  let storageDir: string;
  let tests: TestsService;

  beforeAll(async () => {
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();
    tests = app.get(TestsService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  const http = () => authed(app);

  it("a draft is in the review queue and excluded from the active Tests list", async () => {
    const { id } = await tests.createDraft(DEFINITION, { intent: "verify the home page" });

    const drafts = await http().get("/drafts").expect(200);
    expect((drafts.body as Array<{ id: string }>).find((d) => d.id === id)).toMatchObject({
      origin: "ai",
      checkpointCount: 1,
      intent: "verify the home page",
    });

    // Held out of /tests — the suite editor reads /tests, so a draft can't join a suite.
    const active = await http().get("/tests").expect(200);
    expect((active.body as Array<{ id: string }>).some((t) => t.id === id)).toBe(false);
  });

  it("surfaces authoring-preview screenshots in the list + draft detail", async () => {
    // A 1x1 PNG stands in for a checkpoint screenshot captured during authoring.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const { id } = await tests.createDraft(DEFINITION, {
      intent: "with preview",
      previews: [{ checkpointName: "home", bytes: png }],
    });

    // List carries a representative thumbnail URL.
    const list = await http().get("/drafts").expect(200);
    const row = (list.body as Array<{ id: string; previewUrl: string | null }>).find((d) => d.id === id);
    expect(row?.previewUrl).toEqual(expect.any(String));

    // Detail carries the per-checkpoint preview.
    const detail = await http().get(`/drafts/${id}`).expect(200);
    const home = (detail.body.checkpoints as Array<{ name: string; previewUrl: string | null }>).find(
      (c) => c.name === "home",
    );
    expect(home?.previewUrl).toEqual(expect.any(String));

    // And it actually serves a PNG through the artifacts route.
    const img = await http().get(home!.previewUrl as string);
    expect(img.status).toBe(200);
  });

  it("promote files it (folder + tags) and flips it active; it leaves the queue", async () => {
    const { id } = await tests.createDraft(DEFINITION, { intent: "promote me" });
    const folder = await http().post("/folders").send({ name: "Promoted" }).expect(201);

    await http().post(`/drafts/${id}/promote`).send({ folderId: folder.body.id, tags: ["release:5.0"] }).expect(201);

    // Now in the active list, filed + tagged, marked active/ai.
    const active = await http().get("/tests").expect(200);
    const promoted = (active.body as Array<{ id: string; status: string; origin: string; folderName: string | null; tags: string[] }>).find(
      (t) => t.id === id,
    );
    expect(promoted).toMatchObject({ status: "active", origin: "ai", folderName: "Promoted", tags: ["release:5.0"] });

    // ...and gone from the review queue.
    const drafts = await http().get("/drafts").expect(200);
    expect((drafts.body as Array<{ id: string }>).some((d) => d.id === id)).toBe(false);

    // Promoting again is a 409 (only a draft can be promoted).
    await http().post(`/drafts/${id}/promote`).send({}).expect(409);
  });

  it("discard hard-deletes a draft", async () => {
    const { id } = await tests.createDraft(DEFINITION, { intent: "discard me" });
    await http().delete(`/drafts/${id}`).expect(200);
    const drafts = await http().get("/drafts").expect(200);
    expect((drafts.body as Array<{ id: string }>).some((d) => d.id === id)).toBe(false);
  });
  /**
   * An **Agent-Driven Test** Claude authored (ticket #11). Everything above reads a pinned
   * Draft, whose checkpoints are recorded screenshot steps in its definition. This kind keeps
   * them somewhere else entirely, and the queue reading the wrong place is not a cosmetic bug:
   * a count of zero is the queue's own flag for "a test that asserts nothing", so an eight-
   * Checkpoint journey would arrive wearing the badge of the thing it is furthest from.
   */
  describe("an Agent-Driven Draft in the queue", () => {
    const png = pngFixture;

    const AUTHORED = "App is on http://localhost:3000. Sign in as qa@acme.io / hunter2.";

    /** Build one the way `/mcp` does: a Draft, then Checkpoints with their captures. */
    async function authoredDraft(name: string, checkpointNames: string[]): Promise<string> {
      const agent = app.get(AgentTestsService);
      const { id } = await agent.createDraft({ name, instructions: AUTHORED }, "qa@acme.io");
      for (const cp of checkpointNames) {
        await agent.addCheckpoint(id, {
          name: cp,
          instructions: `Drive to ${cp}.`,
          comparePrompt: `The ${cp} state is on screen; figures may differ.`,
        });
        await tests.putDraftPreview(id, cp, png(cp));
      }
      return id;
    }

    it("reports its real Checkpoint count, not the zero its stub definition would give", async () => {
      const id = await authoredDraft("authored journey", ["signed-in", "cart-filled", "order-placed"]);

      const list = await http().get("/drafts").expect(200);
      const row = (list.body as Array<{ id: string; kind: string; checkpointCount: number; previewUrl: string | null }>).find(
        (d) => d.id === id,
      );
      expect(row?.kind).toBe("agent");
      expect(row?.checkpointCount).toBe(3);
      // The thumbnail is the FIRST Checkpoint's capture — journey order, not alphabetical, which
      // is why "cart-filled" winning here would be a silent wrong answer rather than an error.
      expect(row?.previewUrl).toEqual(expect.any(String));
      const img = await http().get(row!.previewUrl as string);
      expect(img.body.equals(png("signed-in"))).toBe(true);
    });

    it("carries the AI Instructions and the ordered Checkpoints, each beside its capture", async () => {
      const id = await authoredDraft("inspected journey", ["landing", "filtered", "exported"]);

      const detail = await http().get(`/drafts/${id}`).expect(200);
      expect(detail.body.kind).toBe("agent");
      // The Brief slot holds the artifact Claude authored, not a sentence that asked for it.
      expect(detail.body.intent).toBe(AUTHORED);

      const cps = detail.body.checkpoints as Array<{
        name: string;
        instructions: string | null;
        comparePrompt: string | null;
        captureMode: string | null;
        previewUrl: string | null;
      }>;
      expect(cps.map((c) => c.name)).toEqual(["landing", "filtered", "exported"]);
      expect(cps[1].instructions).toBe("Drive to filtered.");
      expect(cps[1].comparePrompt).toBe("The filtered state is on screen; figures may differ.");
      // Varys did not take these pictures and has no opinion about how they were framed.
      expect(cps.every((c) => c.captureMode === null)).toBe(true);
      expect(cps.every((c) => typeof c.previewUrl === "string")).toBe(true);
    });

    it("still reports zero for an authored Draft with no Checkpoints yet", async () => {
      const id = await authoredDraft("abandoned half way", []);
      const list = await http().get("/drafts").expect(200);
      const row = (list.body as Array<{ id: string; checkpointCount: number; previewUrl: string | null }>).find(
        (d) => d.id === id,
      );
      expect(row?.checkpointCount).toBe(0);
      expect(row?.previewUrl).toBeNull();
    });

    it("promotes with a folder and tags exactly as a pinned Draft does", async () => {
      const id = await authoredDraft("promotable journey", ["home"]);
      const folder = await http().post("/folders").send({ name: "Agent flows" }).expect(201);

      await http()
        .post(`/drafts/${id}/promote`)
        .send({ folderId: folder.body.id, tags: ["smoke"] })
        .expect(201);

      const active = await http().get("/tests").expect(200);
      expect(
        (active.body as Array<{ id: string; status: string; origin: string; kind: string; folderName: string | null; tags: string[] }>).find(
          (t) => t.id === id,
        ),
      ).toMatchObject({ status: "active", origin: "ai", kind: "agent", folderName: "Agent flows", tags: ["smoke"] });

      const drafts = await http().get("/drafts").expect(200);
      expect((drafts.body as Array<{ id: string }>).some((d) => d.id === id)).toBe(false);
    });

    it("leaves a pinned Draft reading exactly as it did", async () => {
      const { id } = await tests.createDraft(DEFINITION, { intent: "verify the home page" });
      const list = await http().get("/drafts").expect(200);
      const row = (list.body as Array<{ id: string; kind: string; checkpointCount: number }>).find(
        (d) => d.id === id,
      );
      expect(row?.kind).toBe("pinned");
      expect(row?.checkpointCount).toBe(1);

      const detail = await http().get(`/drafts/${id}`).expect(200);
      expect(detail.body.kind).toBe("pinned");
      const cps = detail.body.checkpoints as Array<{ name: string; captureMode: string | null; instructions: string | null }>;
      expect(cps.map((c) => c.name)).toEqual(["home"]);
      expect(cps[0].captureMode).toBe("fullpage");
      // A recorded step carries no prose of its own — that is the half of the shape this kind lacks.
      expect(cps[0].instructions).toBeNull();
    });
  });
});
