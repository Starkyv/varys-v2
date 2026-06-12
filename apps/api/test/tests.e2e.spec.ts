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
        { type: "screenshot", name: "hero", selector: "#hero" },
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
});
