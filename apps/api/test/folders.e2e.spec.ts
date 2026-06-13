import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 5 Issue 1 — the two guarantees worth pinning (per direction, everything
 * else is manual-verified): deleting a folder UNFILES its tests (never deletes
 * them), and organize actions (rename/file) never create a test_version.
 */
describe("Folders API", () => {
  let app: INestApplication;
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.connectionString;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
  });

  const mkTest = async (name: string): Promise<string> => {
    const definition = {
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "http://fixture.local/" },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" } } },
      ],
    };
    const res = await request(app.getHttpServer()).post("/tests").send(definition).expect(201);
    return res.body.id as string;
  };

  it("deleting a folder unfiles its tests without deleting them", async () => {
    const folder = await request(app.getHttpServer())
      .post("/folders")
      .send({ name: "checkout" })
      .expect(201);
    const folderId = folder.body.id as string;
    const testId = await mkTest("filed test");

    await request(app.getHttpServer())
      .patch(`/tests/${testId}`)
      .send({ folderId })
      .expect(200);

    type Row = { id: string; folderId: string | null; folderName: string | null };
    const filed = await request(app.getHttpServer()).get("/tests").expect(200);
    expect((filed.body as Row[]).find((t) => t.id === testId)).toMatchObject({
      folderId,
      folderName: "checkout",
    });

    await request(app.getHttpServer()).delete(`/folders/${folderId}`).expect(200);

    // The test survives, unfiled; the folder is gone from the list.
    const after = await request(app.getHttpServer()).get("/tests").expect(200);
    expect((after.body as Row[]).find((t) => t.id === testId)).toMatchObject({
      folderId: null,
      folderName: null,
    });
    const foldersLeft = await request(app.getHttpServer()).get("/folders").expect(200);
    expect(
      (foldersLeft.body as { id: string }[]).find((f) => f.id === folderId),
    ).toBeUndefined();
  });

  // Slice 5 Issue 2 — one cheap tag assertion folded in (per direction): tags
  // full-replace with normalization, surfaced on the list + the distinct listing.
  it("sets normalized tags on a test and lists the distinct tags in use", async () => {
    const testId = await mkTest("tagged test");

    await request(app.getHttpServer())
      .patch(`/tests/${testId}`)
      .send({ tags: [" release:5.0 ", "feature:dashboard", "release:5.0", "  "] })
      .expect(200);

    type Row = { id: string; tags: string[] };
    const listed = await request(app.getHttpServer()).get("/tests").expect(200);
    expect((listed.body as Row[]).find((t) => t.id === testId)?.tags).toEqual([
      "feature:dashboard",
      "release:5.0",
    ]);

    const tags = await request(app.getHttpServer()).get("/tags").expect(200);
    expect(tags.body).toEqual(expect.arrayContaining(["feature:dashboard", "release:5.0"]));

    // Full replace covers removals too.
    await request(app.getHttpServer())
      .patch(`/tests/${testId}`)
      .send({ tags: ["feature:dashboard"] })
      .expect(200);
    const after = await request(app.getHttpServer()).get("/tests").expect(200);
    expect((after.body as Row[]).find((t) => t.id === testId)?.tags).toEqual([
      "feature:dashboard",
    ]);
  });

  it("renaming and filing a test creates no new test_version", async () => {
    const testId = await mkTest("recorded");
    const folder = await request(app.getHttpServer())
      .post("/folders")
      .send({ name: "smoke" })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/tests/${testId}`)
      .send({ name: "dashboard smoke", folderId: folder.body.id })
      .expect(200);

    // The rename surfaced, but the version is untouched — organize metadata never
    // reversions the definition (so baselines/review state can't be perturbed).
    const got = await request(app.getHttpServer()).get(`/tests/${testId}`).expect(200);
    expect(got.body.name).toBe("dashboard smoke");
    expect(got.body.version).toBe(1);
    expect(got.body.definition.name).toBe("recorded"); // definition jsonb untouched
  });
});
