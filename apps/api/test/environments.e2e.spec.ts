import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { authed, prepareAuth } from "./auth-harness";
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
    await prepareAuth();
  });

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
  });

  // Issue 4 TB2 — environments store secrets but never return their values.
  it("stores an environment and never returns secret values", async () => {
    const created = await authed(app)
      .post("/environments")
      .send({
        name: "demo",
        values: { baseUrl: "https://demo.example.com", username: "alice" },
        secrets: { password: "s3cr3t" },
      })
      .expect(201);

    const got = await authed(app)
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

  // Slice 1 — GET /environments lists envs as { id, name, values, secretNames }
  // and never leaks a secret value.
  it("lists environments without ever returning secret values", async () => {
    const created = await authed(app)
      .post("/environments")
      .send({
        name: "list-me",
        values: { baseUrl: "https://list.example.com" },
        secrets: { token: "list-secret-value" },
      })
      .expect(201);

    const listed = await authed(app).get("/environments").expect(200);

    expect(Array.isArray(listed.body)).toBe(true);
    const mine = listed.body.find((e: { id: string }) => e.id === created.body.id);
    expect(mine).toMatchObject({
      name: "list-me",
      values: { baseUrl: "https://list.example.com" },
    });
    expect(mine.secretNames).toContain("token");
    // No secret value anywhere in the whole list payload.
    expect(JSON.stringify(listed.body)).not.toContain("list-secret-value");
  });

  // Slice 1 — PUT /environments/:id renames, replaces values, sets new secrets,
  // and clears named secrets — never echoing a secret value.
  it("updates an environment: rename, replace values, set + clear secrets", async () => {
    const created = await authed(app)
      .post("/environments")
      .send({
        name: "before",
        values: { baseUrl: "https://before.example.com", stale: "drop-me" },
        secrets: { password: "old-pw", apiKey: "remove-me" },
      })
      .expect(201);
    const id = created.body.id;

    const updated = await authed(app)
      .put(`/environments/${id}`)
      .send({
        name: "after",
        values: { baseUrl: "https://after.example.com" }, // full replace — `stale` drops
        secrets: { password: "new-pw" }, // overwrite
        removeSecrets: ["apiKey"], // clear
      })
      .expect(200);

    expect(updated.body).toMatchObject({
      id,
      name: "after",
      values: { baseUrl: "https://after.example.com" },
    });
    expect(updated.body.values).not.toHaveProperty("stale");
    expect(updated.body.secretNames).toContain("password");
    expect(updated.body.secretNames).not.toContain("apiKey");
    // Neither the old nor the new secret value is ever returned.
    const body = JSON.stringify(updated.body);
    expect(body).not.toContain("old-pw");
    expect(body).not.toContain("new-pw");
  });

  // Slice 1 — DELETE /environments/:id removes the env (allowed regardless of
  // referencing runs — no FK) and it leaves the list.
  it("deletes an environment", async () => {
    const created = await authed(app)
      .post("/environments")
      .send({ name: "delete-me", values: { baseUrl: "https://del.example.com" } })
      .expect(201);
    const id = created.body.id;

    await authed(app).delete(`/environments/${id}`).expect(200);
    await authed(app).get(`/environments/${id}`).expect(404);

    const listed = await authed(app).get("/environments").expect(200);
    expect(listed.body.find((e: { id: string }) => e.id === id)).toBeUndefined();
  });
});
