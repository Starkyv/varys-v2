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

  // An environment stores its base URL + cookies + localStorage (no variables/secrets).
  it("stores an environment and returns its base URL", async () => {
    const created = await authed(app)
      .post("/environments")
      .send({
        name: "demo",
        baseUrl: "https://demo.example.com",
        cookies: [{ name: "session", value: "abc" }],
      })
      .expect(201);

    const got = await authed(app)
      .get(`/environments/${created.body.id}`)
      .expect(200);

    expect(got.body).toMatchObject({
      name: "demo",
      baseUrl: "https://demo.example.com",
      cookies: [{ name: "session", value: "abc" }],
    });
    // No variables/secrets fields anymore.
    expect(got.body).not.toHaveProperty("values");
    expect(got.body).not.toHaveProperty("secretNames");
  });

  it("lists environments with their base URL", async () => {
    const created = await authed(app)
      .post("/environments")
      .send({ name: "list-me", baseUrl: "https://list.example.com" })
      .expect(201);

    const listed = await authed(app).get("/environments").expect(200);

    expect(Array.isArray(listed.body)).toBe(true);
    const mine = listed.body.find((e: { id: string }) => e.id === created.body.id);
    expect(mine).toMatchObject({ name: "list-me", baseUrl: "https://list.example.com" });
  });

  // PUT /environments/:id renames and replaces baseUrl / cookies / localStorage.
  it("updates an environment: rename, replace base URL + cookies", async () => {
    const created = await authed(app)
      .post("/environments")
      .send({
        name: "before",
        baseUrl: "https://before.example.com",
        cookies: [{ name: "old", value: "x" }],
      })
      .expect(201);
    const id = created.body.id;

    const updated = await authed(app)
      .put(`/environments/${id}`)
      .send({
        name: "after",
        baseUrl: "https://after.example.com",
        cookies: [{ name: "fresh", value: "y" }], // full-list replace
      })
      .expect(200);

    expect(updated.body).toMatchObject({
      id,
      name: "after",
      baseUrl: "https://after.example.com",
      cookies: [{ name: "fresh", value: "y" }],
    });
  });

  // DELETE /environments/:id removes the env (allowed regardless of referencing runs —
  // no FK) and it leaves the list.
  it("deletes an environment", async () => {
    const created = await authed(app)
      .post("/environments")
      .send({ name: "delete-me", baseUrl: "https://del.example.com" })
      .expect(201);
    const id = created.body.id;

    await authed(app).delete(`/environments/${id}`).expect(200);
    await authed(app).get(`/environments/${id}`).expect(404);

    const listed = await authed(app).get("/environments").expect(200);
    expect(listed.body.find((e: { id: string }) => e.id === id)).toBeUndefined();
  });
});
