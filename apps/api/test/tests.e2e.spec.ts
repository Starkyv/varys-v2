import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

describe("Tests API", () => {
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

  // TB1 — walking skeleton, slice 1.
  it("a created test definition can be retrieved by id", async () => {
    const definition = {
      name: "dashboard smoke",
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "http://fixture.local/" },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    };

    const created = await request(app.getHttpServer())
      .post("/tests")
      .send(definition)
      .expect(201);

    expect(created.body).toMatchObject({ id: expect.any(String), version: 1 });

    const fetched = await request(app.getHttpServer())
      .get(`/tests/${created.body.id}`)
      .expect(200);

    expect(fetched.body.version).toBe(1);
    expect(fetched.body.definition).toEqual(definition);
  });

  // The Tests view lists saved recordings so they can be found and run.
  it("lists saved tests, newest first", async () => {
    const mk = (name: string) => ({
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "http://fixture.local/" },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    });

    const a = await request(app.getHttpServer()).post("/tests").send(mk("list-a")).expect(201);
    const b = await request(app.getHttpServer()).post("/tests").send(mk("list-b")).expect(201);

    const listed = await request(app.getHttpServer()).get("/tests").expect(200);
    const items = listed.body as { id: string; name: string; createdAt: string }[];

    const mine = items.filter((i) => i.id === a.body.id || i.id === b.body.id);
    expect(mine).toHaveLength(2);
    for (const it of mine) {
      expect(it.name).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(it.createdAt))).toBe(false);
    }
  });
});
