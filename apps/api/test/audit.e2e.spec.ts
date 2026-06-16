import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { getAuth } from "../src/auth/auth";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 10 / Issue 4 — audit attribution. The signed-in user is recorded on the audited
 * writes: who edited a test (`test_versions.createdBy`) and who approved a baseline
 * (`baselines.approvedBy`), replacing the old "user"/"system" placeholders, and the
 * approver is surfaced in the run read-model. Chromium-free: the run is seeded directly.
 */
describe("Audit attribution", () => {
  let app: INestApplication;
  let db: TestDb;
  let pool: Pool;
  let cookie: string;
  let email: string;

  const definition = {
    name: "audit-test",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    steps: [
      { type: "navigate", url: "http://fixture.local/" },
      { type: "screenshot", name: "cp1", target: { tag: "div", attributes: { id: "hero" } } },
    ],
  };

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.connectionString;
    pool = new Pool({ connectionString: db.connectionString });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    email = `audit+${Date.now()}@varys.test`;
    const res = await getAuth().api.signUpEmail({
      body: { email, password: "e2e-password-1234", name: "Audit" },
      asResponse: true,
    });
    cookie = (res.headers.get("set-cookie") ?? "").match(/better-auth\.session_token=[^;]+/)?.[0] ?? "";
    expect(cookie).toBeTruthy();
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
    await db?.container.stop();
  });

  it("attributes a config edit to the signed-in user (createdBy)", async () => {
    const created = await request(app.getHttpServer())
      .post("/tests")
      .set("Cookie", cookie)
      .send(definition)
      .expect(201);
    const testId = created.body.id as string;

    // A config save writes a new audited test_version (v2).
    await request(app.getHttpServer())
      .put(`/tests/${testId}/config`)
      .set("Cookie", cookie)
      .send({ baseVersion: 1 })
      .expect(200);

    const { rows } = await pool.query(
      "SELECT created_by FROM test_versions WHERE test_id = $1 AND version = 2",
      [testId],
    );
    expect(rows[0]?.created_by).toBe(email);
  });

  it("attributes a baseline approval to the user (approvedBy) + surfaces it in the read-model", async () => {
    const created = await request(app.getHttpServer())
      .post("/tests")
      .set("Cookie", cookie)
      .send(definition)
      .expect(201);
    const testId = created.body.id as string;

    // Seed a run with a pending-baseline checkpoint directly — no chromium/worker needed;
    // approve only reads the run_result + the version's viewport, not the artifact bytes.
    const { rows: tv } = await pool.query(
      "SELECT id FROM test_versions WHERE test_id = $1 ORDER BY version DESC LIMIT 1",
      [testId],
    );
    const { rows: run } = await pool.query(
      "INSERT INTO runs (test_version_id, status) VALUES ($1, 'needs_review') RETURNING id",
      [tv[0].id],
    );
    const runId = run[0].id as string;
    await pool.query(
      `INSERT INTO run_results (run_id, checkpoint_name, review_state, actual_artifact_key, threshold)
       VALUES ($1, 'cp1', 'pending-baseline', 'seed-actual-key', 0.1)`,
      [runId],
    );

    await request(app.getHttpServer())
      .post(`/runs/${runId}/checkpoints/cp1/approve`)
      .set("Cookie", cookie)
      .expect(201);

    const { rows: baseline } = await pool.query(
      "SELECT approved_by FROM baselines WHERE test_id = $1 AND checkpoint_name = 'cp1'",
      [testId],
    );
    expect(baseline[0]?.approved_by).toBe(email);

    const view = await request(app.getHttpServer())
      .get(`/runs/${runId}`)
      .set("Cookie", cookie)
      .expect(200);
    const cp = (view.body.checkpoints as Array<{ name: string; baselineApprovedBy: string | null }>).find(
      (c) => c.name === "cp1",
    );
    expect(cp?.baselineApprovedBy).toBe(email);
  });
});
