import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authed, prepareAuth } from "./auth-harness";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 16.3a (live locator verify) — the probe pinned at the HTTP API against the in-repo
 * fixture app. A transient partial replay drives the preceding steps in a real browser and
 * resolves the CANDIDATE locator at the target step with the real matcher: a matching
 * candidate is `resolved` (with a matched signal); a broken one is `not-found`; a step the
 * drive can't perform is reported as the failed step; and the probe persists NOTHING (no run
 * rows or artifacts). The matcher's ambiguous-vs-not-found verdict is unit-tested in
 * @varys/locator-engine; here we exercise the end-to-end drive.
 */
describe("Locator verify — live probe", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    fixture.setVariant("login"); // has a <button id="submit">Log in</button>
    db = await startTestDb();
    process.env.DATABASE_URL = db.connectionString;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
  });

  // biome-ignore lint/suspicious/noExplicitAny: terse step fixtures
  const mkTest = async (name: string, steps: any[]): Promise<string> => {
    const definition = { name, viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, steps };
    const res = await authed(app).post("/tests").send(definition).expect(201);
    return res.body.id as string;
  };

  it("reports resolved (with a matched signal) for a candidate that matches, and not-found for one that doesn't", async () => {
    const id = await mkTest("verify-login", [
      { type: "navigate", url: fixture.url },
      { type: "click", target: { tag: "button", accessibleName: "Log in" } },
    ]);

    // Unchanged candidate → resolves against the fixture's Log in button.
    const ok = await authed(app)
      .post(`/tests/${id}/config/verify`)
      .send({ stepIndex: 1, target: {} })
      .expect(200);
    expect(ok.body.status).toBe("resolved");
    expect(ok.body.matchedSignal).toBeTruthy();
    expect(ok.body.reachedStep).toBe(1);
    expect(ok.body.failedStepIndex).toBeNull();

    // Rename the locator to something absent → not-found at the same step.
    const no = await authed(app)
      .post(`/tests/${id}/config/verify`)
      .send({ stepIndex: 1, target: { accessibleName: "No Such Button" } })
      .expect(200);
    expect(no.body.status).toBe("not-found");
    expect(no.body.reachedStep).toBe(1);
  }, 60_000);

  it("identifies the failed drive step when an earlier step can't be performed", async () => {
    const id = await mkTest("verify-broken-path", [
      { type: "navigate", url: fixture.url },
      { type: "click", target: { tag: "button", accessibleName: "Ghost" } }, // unlocatable
      { type: "click", target: { tag: "button", accessibleName: "Log in" } },
    ]);

    const r = await authed(app)
      .post(`/tests/${id}/config/verify`)
      .send({ stepIndex: 2, target: {} })
      .expect(200);
    // The drive couldn't get past step 1, so the verdict names it — distinct from a
    // "wrong locator" at the target step.
    expect(r.body.failedStepIndex).toBe(1);
    expect(r.body.reachedStep).toBe(1);
    expect(typeof r.body.failedStepLabel).toBe("string");
  }, 60_000);

  it("rejects verifying a step with no element locator (400)", async () => {
    const id = await mkTest("verify-navigate", [{ type: "navigate", url: fixture.url }]);
    await authed(app)
      .post(`/tests/${id}/config/verify`)
      .send({ stepIndex: 0, target: {} })
      .expect(400);
  });

  it("persists nothing — no run rows or artifacts are created by verifying", async () => {
    const runs = await authed(app).get("/runs").expect(200);
    expect(runs.body.length).toBe(0);
  });
});
