import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 5 Issue 3 — the two guarantees worth pinning (per direction, everything
 * else is manual-verified): updating a suite REPLACES its member list wholesale,
 * and deleting a suite removes the selection only — member tests are untouched.
 */
describe("Suites API", () => {
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

  it("replaces a suite's member list wholesale on update", async () => {
    const a = await mkTest("suite-member-a");
    const b = await mkTest("suite-member-b");
    const c = await mkTest("suite-member-c");

    const suite = await request(app.getHttpServer())
      .post("/suites")
      .send({ name: "smoke", testIds: [a, b] })
      .expect(201);
    const suiteId = suite.body.id as string;

    type View = { name: string; tests: { id: string }[] };
    const before = await request(app.getHttpServer()).get(`/suites/${suiteId}`).expect(200);
    expect((before.body as View).tests.map((t) => t.id).sort()).toEqual([a, b].sort());

    // Full replace: b drops out, c comes in — one write covers adds and removals.
    await request(app.getHttpServer())
      .put(`/suites/${suiteId}`)
      .send({ name: "smoke v2", testIds: [a, c] })
      .expect(200);

    const after = await request(app.getHttpServer()).get(`/suites/${suiteId}`).expect(200);
    expect((after.body as View).name).toBe("smoke v2");
    expect((after.body as View).tests.map((t) => t.id).sort()).toEqual([a, c].sort());

    // The list's member count reflects the replacement.
    const listed = await request(app.getHttpServer()).get("/suites").expect(200);
    expect(
      (listed.body as { id: string; testCount: number }[]).find((s) => s.id === suiteId)
        ?.testCount,
    ).toBe(2);
  });

  it("deleting a suite leaves its member tests intact (a test can be in many suites)", async () => {
    const shared = await mkTest("shared-member");
    const s1 = await request(app.getHttpServer())
      .post("/suites")
      .send({ name: "release", testIds: [shared] })
      .expect(201);
    const s2 = await request(app.getHttpServer())
      .post("/suites")
      .send({ name: "nightly", testIds: [shared] })
      .expect(201);

    await request(app.getHttpServer()).delete(`/suites/${s1.body.id}`).expect(200);
    await request(app.getHttpServer()).get(`/suites/${s1.body.id}`).expect(404);

    // The member test survives, still listed and still in the other suite.
    const tests = await request(app.getHttpServer()).get("/tests").expect(200);
    expect((tests.body as { id: string }[]).find((t) => t.id === shared)).toBeDefined();
    const other = await request(app.getHttpServer()).get(`/suites/${s2.body.id}`).expect(200);
    expect((other.body as { tests: { id: string }[] }).tests.map((t) => t.id)).toContain(shared);
  });
});
