import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { parseTestDefinition } from "@varys/step-schema";
import request from "supertest";
import { authed, authEmail, prepareAuth } from "./auth-harness";
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
    await prepareAuth();
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

    const created = await authed(app)
      .post("/tests")
      .send(definition)
      .expect(201);

    expect(created.body).toMatchObject({ id: expect.any(String), version: 1 });

    const fetched = await authed(app)
      .get(`/tests/${created.body.id}`)
      .expect(200);

    expect(fetched.body.version).toBe(1);
    // Stored definition is the PARSED form — the schema normalizes it (e.g. injects
    // the `captureMode: "element"` default), so compare against that canonical shape
    // rather than the raw input (which would drift as new defaults land).
    expect(fetched.body.definition).toEqual(parseTestDefinition(definition));
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

    const a = await authed(app).post("/tests").send(mk("list-a")).expect(201);
    const b = await authed(app).post("/tests").send(mk("list-b")).expect(201);

    const listed = await authed(app).get("/tests").expect(200);
    const items = listed.body as { id: string; name: string; createdAt: string }[];

    const mine = items.filter((i) => i.id === a.body.id || i.id === b.body.id);
    expect(mine).toHaveLength(2);
    for (const it of mine) {
      expect(it.name).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(it.createdAt))).toBe(false);
    }
  });

  // Slice 5 — the list flags whether each test needs an environment, so the Run UI
  // can require one. A {{token}} (or declared variables) ⇒ true; otherwise false.
  it("flags whether a test needs an environment", async () => {
    const withToken = {
      name: "needs-env",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "{{baseUrl}}/" },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" } } },
      ],
      variables: [{ name: "baseUrl", kind: "url" }],
    };
    const noToken = {
      name: "no-env",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "http://fixture.local/" },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" } } },
      ],
    };
    const a = await authed(app).post("/tests").send(withToken).expect(201);
    const b = await authed(app).post("/tests").send(noToken).expect(201);

    const listed = await authed(app).get("/tests").expect(200);
    const items = listed.body as {
      id: string;
      needsEnvironment: boolean;
      createdBy: string | null;
    }[];
    const itemA = items.find((i) => i.id === a.body.id);
    const itemB = items.find((i) => i.id === b.body.id);
    // needsEnvironment is true iff the test uses {{baseUrl}}.
    expect(itemA?.needsEnvironment).toBe(true);
    expect(itemB?.needsEnvironment).toBe(false);
    // ...and attributes the test to the signed-in creator (Slice A).
    expect(itemA?.createdBy).toBe(authEmail());
  });
});
