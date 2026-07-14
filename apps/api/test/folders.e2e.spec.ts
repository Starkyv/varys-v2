import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { authed, prepareAuth } from "./auth-harness";
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
    await prepareAuth();
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
    const res = await authed(app).post("/tests").send(definition).expect(201);
    return res.body.id as string;
  };

  it("deleting a folder unfiles its tests without deleting them", async () => {
    const folder = await authed(app)
      .post("/folders")
      .send({ name: "checkout" })
      .expect(201);
    const folderId = folder.body.id as string;
    const testId = await mkTest("filed test");

    await authed(app)
      .patch(`/tests/${testId}`)
      .send({ folderId })
      .expect(200);

    type Row = { id: string; folderId: string | null; folderName: string | null };
    const filed = await authed(app).get("/tests").expect(200);
    expect((filed.body as Row[]).find((t) => t.id === testId)).toMatchObject({
      folderId,
      folderName: "checkout",
    });

    await authed(app).delete(`/folders/${folderId}`).expect(200);

    // The test survives, unfiled; the folder is gone from the list.
    const after = await authed(app).get("/tests").expect(200);
    expect((after.body as Row[]).find((t) => t.id === testId)).toMatchObject({
      folderId: null,
      folderName: null,
    });
    const foldersLeft = await authed(app).get("/folders").expect(200);
    expect(
      (foldersLeft.body as { id: string }[]).find((f) => f.id === folderId),
    ).toBeUndefined();
  });

  // Slice 5 Issue 2 — one cheap tag assertion folded in (per direction): tags
  // full-replace with normalization, surfaced on the list + the distinct listing.
  it("sets normalized tags on a test and lists the distinct tags in use", async () => {
    const testId = await mkTest("tagged test");

    await authed(app)
      .patch(`/tests/${testId}`)
      .send({ tags: [" release:5.0 ", "feature:dashboard", "release:5.0", "  "] })
      .expect(200);

    type Row = { id: string; tags: string[] };
    const listed = await authed(app).get("/tests").expect(200);
    expect((listed.body as Row[]).find((t) => t.id === testId)?.tags).toEqual([
      "feature:dashboard",
      "release:5.0",
    ]);

    const tags = await authed(app).get("/tags").expect(200);
    expect(tags.body).toEqual(expect.arrayContaining(["feature:dashboard", "release:5.0"]));

    // Full replace covers removals too.
    await authed(app)
      .patch(`/tests/${testId}`)
      .send({ tags: ["feature:dashboard"] })
      .expect(200);
    const after = await authed(app).get("/tests").expect(200);
    expect((after.body as Row[]).find((t) => t.id === testId)?.tags).toEqual([
      "feature:dashboard",
    ]);
  });

  it("renaming and filing a test creates no new test_version", async () => {
    const testId = await mkTest("recorded");
    const folder = await authed(app)
      .post("/folders")
      .send({ name: "smoke" })
      .expect(201);

    await authed(app)
      .patch(`/tests/${testId}`)
      .send({ name: "dashboard smoke", folderId: folder.body.id })
      .expect(200);

    // The rename surfaced, but the version is untouched — organize metadata never
    // reversions the definition (so baselines/review state can't be perturbed).
    const got = await authed(app).get(`/tests/${testId}`).expect(200);
    expect(got.body.name).toBe("dashboard smoke");
    expect(got.body.version).toBe(1);
    expect(got.body.definition.name).toBe("recorded"); // definition jsonb untouched
  });

  it("nests folders, guards cycles + sibling names, and cascade-deletes the subtree (tests unfiled)", async () => {
    type F = { id: string; name: string; parentId: string | null };
    const parent = await authed(app).post("/folders").send({ name: "Marketing" }).expect(201);
    const child = await authed(app)
      .post("/folders")
      .send({ name: "Campaigns", parentId: parent.body.id })
      .expect(201);
    const grandchild = await authed(app)
      .post("/folders")
      .send({ name: "Emails", parentId: child.body.id })
      .expect(201);

    // The list carries parentId so the tree can be built.
    const listed = (await authed(app).get("/folders").expect(200)).body as F[];
    expect(listed.find((f) => f.id === child.body.id)?.parentId).toBe(parent.body.id);

    // Sibling-unique names: duplicate under the SAME parent is rejected; the same name under a
    // different parent is fine.
    await authed(app).post("/folders").send({ name: "Campaigns", parentId: parent.body.id }).expect(409);
    await authed(app).post("/folders").send({ name: "Campaigns", parentId: grandchild.body.id }).expect(201);

    // A folder can't move into one of its own descendants (cycle).
    await authed(app).post(`/folders/${parent.body.id}/move`).send({ parentId: grandchild.body.id }).expect(400);

    // File a test into the grandchild, then delete the top folder.
    const testId = await mkTest("nested test");
    await authed(app).patch(`/tests/${testId}`).send({ folderId: grandchild.body.id }).expect(200);
    await authed(app).delete(`/folders/${parent.body.id}`).expect(200);

    // The whole subtree is gone; the test survives, unfiled.
    const after = (await authed(app).get("/folders").expect(200)).body as F[];
    expect(after.find((f) => f.id === parent.body.id)).toBeUndefined();
    expect(after.find((f) => f.id === child.body.id)).toBeUndefined();
    expect(after.find((f) => f.id === grandchild.body.id)).toBeUndefined();

    const tests = (await authed(app).get("/tests").expect(200)).body as { id: string; folderId: string | null }[];
    expect(tests.find((t) => t.id === testId)).toMatchObject({ folderId: null });
  });
});
