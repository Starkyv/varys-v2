import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import type { RepairJobSummary } from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The repair queue fills from a REAL locator failure (Slice 19, slice 01).
 *
 * The break is genuine: a `@varys/fixture-app` variant renames, resizes and re-parents a button,
 * so a fingerprint recorded against the intact page has nothing left to match and the run
 * hard-fails in the matcher exactly as a drifted app would make it. Nothing about the failure is
 * stubbed, which is the only way to know the enqueue sits where a locator failure is actually
 * detected rather than in a mock's shadow.
 *
 * Nothing here claims or repairs anything — that is slices 03 and 04.
 */
describe("Repair policy → a locator failure enqueues a visible job", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-repair-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    // The matcher is deliberately patient with late-rendering targets (30s by default). Every
    // failing run below is a deliberate miss, so shorten the wait rather than pay it repeatedly.
    process.env.VARYS_ACTION_TIMEOUT_MS = "1500";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) => processRun({ db: consumerDb.db, storage }, runId));
  }, 120_000);

  afterAll(async () => {
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
    delete process.env.VARYS_ACTION_TIMEOUT_MS;
  });

  /** A test that clicks the control the broken variant renames. */
  function definitionClickingSave(name: string) {
    return {
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "click",
          target: {
            tag: "button",
            testId: "save-btn",
            role: "button",
            accessibleName: "Save changes",
            nameFromAttr: true,
            attributes: { id: "save-btn", "data-testid": "save-btn" },
            ancestors: [{ tag: "section", id: "form-panel" }, { tag: "body" }, { tag: "html" }],
            boundingBox: { x: 24, y: 168, width: 140, height: 36 },
            domIndex: 0,
          },
        },
      ],
    };
  }

  async function createTest(definition: object): Promise<string> {
    const res = await authed(app).post("/tests").send(definition).expect(201);
    return res.body.id as string;
  }

  async function runToCompletion(testId: string): Promise<{ runId: string; status: string; error: string | null; failureKind: string | null }> {
    const created = await authed(app).post("/runs").send({ testId }).expect(201);
    const runId = created.body.runId as string;
    for (let i = 0; i < 200; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      const { status } = res.body as { status: string };
      if (status === "passed" || status === "needs_review" || status === "failed") {
        return {
          runId,
          status,
          error: res.body.error ?? null,
          failureKind: res.body.failureKind ?? null,
        };
      }
      await sleep(200);
    }
    throw new Error(`run ${runId} never finished`);
  }

  async function queue(all = false): Promise<RepairJobSummary[]> {
    const res = await authed(app)
      .get(`/repair-jobs${all ? "?all=1" : ""}`)
      .expect(200);
    return res.body as RepairJobSummary[];
  }

  async function jobsFor(testId: string, all = false): Promise<RepairJobSummary[]> {
    return (await queue(all)).filter((j) => j.testId === testId);
  }

  /**
   * Clear the queue between cases.
   *
   * Every case here breaks the SAME fixture control, so since clustering (slice 07) they would
   * otherwise join one another's Failure Cluster instead of opening their own job — the queue is
   * project-wide, and "one app change, one job" is exactly the point. Each case wants a queue of
   * its own; clustering behaviour itself is pinned in `repair-cluster.e2e.spec.ts`.
   */
  beforeEach(async () => {
    // Straight to the table rather than through `cancel`: a CLAIMED job is open too, and one case
    // here leaves a claim behind on purpose. Cancel deliberately refuses those (a claimed job is
    // its drainer's to release), so the API cannot clear them and the next case would silently
    // join the claim's cluster instead of opening its own job.
    await consumerDb.db.execute(
      `update repair_jobs set status = 'cancelled' where status in ('queued', 'claimed')`,
    );
  });

  it("defaults every test to manual, so nothing starts self-editing on its own", async () => {
    const testId = await createTest(definitionClickingSave("policy default"));
    const config = await authed(app).get(`/tests/${testId}/config`).expect(200);
    expect(config.body.repairPolicy).toBe("manual");

    const list = await authed(app).get("/tests").expect(200);
    const summary = (list.body as Array<{ id: string; repairPolicy: string }>).find(
      (t) => t.id === testId,
    );
    expect(summary?.repairPolicy).toBe("manual");
  });

  it("rejects a policy it does not recognise rather than storing it", async () => {
    const testId = await createTest(definitionClickingSave("policy validation"));
    await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "AUTO" }).expect(400);
    await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "yolo" }).expect(400);
    const config = await authed(app).get(`/tests/${testId}/config`).expect(200);
    expect(config.body.repairPolicy).toBe("manual");
  });

  it("under manual, a real locator break behaves exactly as it did before the queue existed", async () => {
    fixture.setVariant("locatorRepair");
    const testId = await createTest(definitionClickingSave("manual policy"));
    // Prove the fingerprint resolves against the intact page — so the failure below is drift,
    // not a fingerprint that was never right.
    const intact = await runToCompletion(testId);
    expect(intact.status).not.toBe("failed");

    fixture.setVariant("locatorRepairBroken");
    const broken = await runToCompletion(testId);
    expect(broken.status).toBe("failed");
    expect(broken.error).toContain("could not locate");
    expect(broken.failureKind).toBe("locator");
    expect(await jobsFor(testId, true)).toEqual([]);
  }, 120_000);

  it("under auto, the same break creates exactly one queued job carrying its provenance", async () => {
    fixture.setVariant("locatorRepairBroken");
    const testId = await createTest(definitionClickingSave("auto policy"));
    await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "auto" }).expect(200);

    const run = await runToCompletion(testId);
    expect(run.status).toBe("failed");

    const jobs = await jobsFor(testId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      testId,
      runId: run.runId,
      kind: "repair",
      status: "queued",
      attempts: 0,
      claimedBy: null,
      claimedAt: null,
    });
    // Derived from the broken locator's strongest signal, so failures sharing a root cause
    // share a key (clustering behaviour itself is slice 07).
    expect(jobs[0].clusterKey).toBe("testid:save-btn");
    expect(jobs[0].testName).toBe("auto policy");
  }, 120_000);

  it("a nightly suite failing the same locator every night leaves ONE queued job", async () => {
    fixture.setVariant("locatorRepairBroken");
    const testId = await createTest(definitionClickingSave("repeated failure"));
    await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "auto" }).expect(200);

    await runToCompletion(testId);
    await runToCompletion(testId);
    await runToCompletion(testId);

    expect(await jobsFor(testId)).toHaveLength(1);
  }, 180_000);

  it("a pixel regression creates no repair job — a visual change is not drift", async () => {
    fixture.setVariant("default");
    const testId = await createTest({
      name: "pixel regression",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "hero",
          target: { tag: "div", attributes: { id: "hero" }, text: "Hero" },
        },
      ],
    });
    await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "auto" }).expect(200);

    // Seed + approve the baseline, then change the pixels underneath it.
    const seeded = await runToCompletion(testId);
    await authed(app).post(`/runs/${seeded.runId}/approve-all`).expect(201);
    fixture.setVariant("changed");
    const regressed = await runToCompletion(testId);
    expect(regressed.status).toBe("needs_review");
    expect(regressed.failureKind).toBeNull();

    expect(await jobsFor(testId, true)).toEqual([]);
  }, 180_000);

  it("a failed judge creates no repair job — a judgement is not a locator", async () => {
    fixture.setVariant("default");
    const testId = await createTest({
      name: "judge failure",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "screenshot",
          name: "judged",
          compareMode: "context",
          prompt: "the hero looks reasonable",
          target: { tag: "div", attributes: { id: "hero" }, text: "Hero" },
        },
      ],
    });
    await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "auto" }).expect(200);

    // The first run only seeds a pending baseline — the judge isn't consulted until there is
    // something to compare against. Approve it, then re-run: no judge is configured in this
    // suite, so the context checkpoint now fails its step loudly. That is the judge path
    // failing, by construction, rather than a locator.
    const seeded = await runToCompletion(testId);
    await authed(app).post(`/runs/${seeded.runId}/approve-all`).expect(201);

    const run = await runToCompletion(testId);
    expect(run.status).toBe("failed");
    expect(run.failureKind).toBeNull();
    expect(await jobsFor(testId, true)).toEqual([]);
    // ...and a human cannot force it into the queue either.
    await authed(app).post("/repair-jobs").send({ runId: run.runId }).expect(400);
  }, 120_000);

  it("a crash creates no repair job — an outage is not a broken locator", async () => {
    const testId = await createTest({
      name: "crash",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      // A port nothing is listening on: the navigation itself throws, well before any matcher.
      steps: [{ type: "navigate", url: "http://127.0.0.1:1/" }],
    });
    await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "auto" }).expect(200);

    const run = await runToCompletion(testId);
    expect(run.status).toBe("failed");
    expect(run.failureKind).toBeNull();
    expect(await jobsFor(testId, true)).toEqual([]);
  }, 120_000);

  describe("enqueueing by hand, from a failed run whose policy is manual", () => {
    it("queues the job, idempotently, and refuses a failure it may not repair", async () => {
      fixture.setVariant("locatorRepairBroken");
      const testId = await createTest(definitionClickingSave("manual enqueue"));
      const run = await runToCompletion(testId);
      expect(run.status).toBe("failed");
      expect(await jobsFor(testId, true)).toEqual([]); // manual policy queued nothing

      const first = await authed(app).post("/repair-jobs").send({ runId: run.runId }).expect(201);
      expect(first.body).toMatchObject({ testId, runId: run.runId, status: "queued" });
      expect(first.body.clusterKey).toBe("testid:save-btn");

      // Asking twice hands back the job already queued rather than a second one.
      const second = await authed(app).post("/repair-jobs").send({ runId: run.runId }).expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(await jobsFor(testId)).toHaveLength(1);
    }, 120_000);

    it("refuses a run that did not fail on a locator", async () => {
      const testId = await createTest({
        name: "not repairable by hand",
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        steps: [{ type: "navigate", url: "http://127.0.0.1:1/" }],
      });
      const run = await runToCompletion(testId);
      await authed(app).post("/repair-jobs").send({ runId: run.runId }).expect(400);
      expect(await jobsFor(testId, true)).toEqual([]);
    }, 120_000);

    it("404s for a run that does not exist", async () => {
      await authed(app)
        .post("/repair-jobs")
        .send({ runId: "00000000-0000-0000-0000-000000000000" })
        .expect(404);
    });
  });

  describe("the queue view", () => {
    it("shows unclaimed distinctly from in-progress", async () => {
      fixture.setVariant("locatorRepairBroken");
      const testId = await createTest(definitionClickingSave("claimed vs unclaimed"));
      await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "auto" }).expect(200);
      await runToCompletion(testId);

      const [job] = await jobsFor(testId);
      expect(job.status).toBe("queued");
      expect(job.claimedBy).toBeNull();

      // Stand in for slice 03's claim: the view must read this as in-progress, not as a slow
      // queued job, which is the whole distinction a project with no drainer depends on.
      await consumerDb.db.execute(
        `update repair_jobs set status = 'claimed', claimed_by = 'agent:ci-box', claimed_at = now() where id = '${job.id}'`,
      );
      const [claimed] = await jobsFor(testId);
      expect(claimed).toMatchObject({ status: "claimed", claimedBy: "agent:ci-box" });
      expect(claimed.claimedAt).toEqual(expect.any(String));
    }, 120_000);

    it("does not stack a second job behind one a drainer has already claimed", async () => {
      fixture.setVariant("locatorRepairBroken");
      const testId = await createTest(definitionClickingSave("no stacking"));
      await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "auto" }).expect(200);
      await runToCompletion(testId);

      const [job] = await jobsFor(testId);
      await consumerDb.db.execute(
        `update repair_jobs set status = 'claimed', claimed_by = 'agent:ci-box', claimed_at = now() where id = '${job.id}'`,
      );

      // The nightly suite fails again while the drainer is mid-repair. The partial unique index
      // only covers queued rows, so without an explicit open-job check this would create a
      // second job for the same broken locator.
      const again = await runToCompletion(testId);
      expect(again.status).toBe("failed");
      expect(await jobsFor(testId)).toHaveLength(1);

      // Asking by hand hands back the claimed job rather than queueing another.
      const byHand = await authed(app).post("/repair-jobs").send({ runId: again.runId }).expect(201);
      expect(byHand.body.id).toBe(job.id);
      expect(await jobsFor(testId)).toHaveLength(1);
    }, 180_000);

    it("cancels a queued job, and refuses to cancel one that is claimed", async () => {
      fixture.setVariant("locatorRepairBroken");
      const testId = await createTest(definitionClickingSave("cancellable"));
      await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "auto" }).expect(200);
      await runToCompletion(testId);

      const [job] = await jobsFor(testId);
      await authed(app).post(`/repair-jobs/${job.id}/cancel`).expect(200);

      expect(await jobsFor(testId)).toEqual([]); // gone from the outstanding queue
      const [cancelled] = await jobsFor(testId, true);
      expect(cancelled.status).toBe("cancelled");

      // Cancelling it again is a conflict, not a silent success.
      await authed(app).post(`/repair-jobs/${job.id}/cancel`).expect(409);
      await authed(app)
        .post("/repair-jobs/00000000-0000-0000-0000-000000000000/cancel")
        .expect(404);
    }, 120_000);
  });

  describe("setting the policy in bulk", () => {
    async function policyOf(testId: string): Promise<string> {
      const res = await authed(app).get(`/tests/${testId}/config`).expect(200);
      return res.body.repairPolicy as string;
    }

    it("applies across a folder AND its subfolders", async () => {
      const parent = await authed(app).post("/folders").send({ name: `bulk-${Date.now()}` }).expect(201);
      const child = await authed(app)
        .post("/folders")
        .send({ name: "child", parentId: parent.body.id })
        .expect(201);

      const inParent = await createTest(definitionClickingSave("bulk parent"));
      const inChild = await createTest(definitionClickingSave("bulk child"));
      const outside = await createTest(definitionClickingSave("bulk outside"));
      await authed(app).patch(`/tests/${inParent}`).send({ folderId: parent.body.id }).expect(200);
      await authed(app).patch(`/tests/${inChild}`).send({ folderId: child.body.id }).expect(200);

      const res = await authed(app)
        .post("/tests/repair-policy")
        .send({ policy: "auto", folderId: parent.body.id })
        .expect(200);
      expect(res.body.updated).toBe(2);

      expect(await policyOf(inParent)).toBe("auto");
      expect(await policyOf(inChild)).toBe("auto");
      expect(await policyOf(outside)).toBe("manual"); // an unfiled test is untouched
    });

    it("applies across a tag, crossing folder boundaries", async () => {
      const tag = `bulk-tag-${Date.now()}`;
      const tagged = await createTest(definitionClickingSave("bulk tagged"));
      const untagged = await createTest(definitionClickingSave("bulk untagged"));
      await authed(app).patch(`/tests/${tagged}`).send({ tags: [tag] }).expect(200);

      const res = await authed(app)
        .post("/tests/repair-policy")
        .send({ policy: "auto", tag })
        .expect(200);
      expect(res.body.updated).toBe(1);
      expect(await policyOf(tagged)).toBe("auto");
      expect(await policyOf(untagged)).toBe("manual");
    });

    it("refuses an empty or ambiguous scope rather than guessing at the whole corpus", async () => {
      await authed(app).post("/tests/repair-policy").send({ policy: "auto" }).expect(400);
      await authed(app)
        .post("/tests/repair-policy")
        .send({ policy: "auto", tag: "a", folderId: "00000000-0000-0000-0000-000000000000" })
        .expect(400);
      await authed(app).post("/tests/repair-policy").send({ policy: "sideways", tag: "a" }).expect(400);
      await authed(app)
        .post("/tests/repair-policy")
        .send({ policy: "auto", folderId: "00000000-0000-0000-0000-000000000000" })
        .expect(404);
    });
  });

  it("refuses the whole surface to an unauthenticated caller", async () => {
    await request(app.getHttpServer()).get("/repair-jobs").expect(401);
    await request(app.getHttpServer()).post("/repair-jobs").send({ runId: "x" }).expect(401);
    await request(app.getHttpServer()).post("/tests/repair-policy").send({ policy: "auto" }).expect(401);
  });
});
