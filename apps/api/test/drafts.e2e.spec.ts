import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { TestsService } from "../src/tests/tests.service";
import { startTestDb, type TestDb } from "./db-harness";

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
    tests = app.get(TestsService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());

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
});
