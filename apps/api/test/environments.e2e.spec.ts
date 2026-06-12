import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

describe("Environments API", () => {
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

  // Issue 4 TB2 — environments store secrets but never return their values.
  it("stores an environment and never returns secret values", async () => {
    const created = await request(app.getHttpServer())
      .post("/environments")
      .send({
        name: "demo",
        values: { baseUrl: "https://demo.example.com", username: "alice" },
        secrets: { password: "s3cr3t" },
      })
      .expect(201);

    const got = await request(app.getHttpServer())
      .get(`/environments/${created.body.id}`)
      .expect(200);

    expect(got.body).toMatchObject({
      name: "demo",
      values: { baseUrl: "https://demo.example.com", username: "alice" },
    });
    expect(got.body.secretNames).toContain("password");
    // The secret value must never appear anywhere in the response.
    expect(JSON.stringify(got.body)).not.toContain("s3cr3t");
  });
});
