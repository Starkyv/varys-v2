import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import type { ClaimedRepairJob, CreatedAgentCredential, RepairJobSummary } from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { CLOCK, type Clock } from "../src/repair-jobs/clock";
import { authed, mcpToken, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Claiming a Repair Job under a lease (Slice 19, slice 03) — the control inversion of ADR-0003
 * seen from the outside: Varys queues, something external claims.
 *
 * The drainer here is SIMULATED — it is this test speaking the claim protocol over HTTP on a
 * Repair Agent credential, exactly as `bridge.e2e.spec.ts` drives the relay with a simulated
 * helper. There is no live Claude anywhere, and there does not need to be: everything this slice
 * promises (exclusivity, invisibility, expiry, release, the attempt cap, who claimed it) is a
 * property of the queue, not of the model that drains it.
 *
 * The break is real — a `@varys/fixture-app` variant renames the target so a recorded fingerprint
 * genuinely fails to resolve — so every job below was enqueued by an actual locator failure.
 *
 * **Time is injected.** The lease is minutes long in production; asserting on it by sleeping
 * would be slow AND flaky. The API's clock is overridden with one this test steps forward, so
 * every assertion is about the OUTCOME of an expiry rather than about how long it waited.
 */
describe("A Repair Job is claimed under a lease", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;

  /** The injected clock: starts at the real now and only moves when a test says so. */
  let nowMs = Date.now();
  const clock: Clock = { now: () => new Date(nowMs) };
  const advanceMinutes = (minutes: number) => {
    nowMs += minutes * 60_000;
  };

  /** Two independent drainers, so "first-claim-wins" is observed between two identities. */
  let drainerA: string;
  let drainerB: string;
  let labelA: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    fixture.setVariant("locatorRepairBroken");
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-claim-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    // Every run below fails on purpose; don't pay the patient default wait for each one.
    process.env.VARYS_ACTION_TIMEOUT_MS = "1500";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) => processRun({ db: consumerDb.db, storage }, runId));

    const a = await authed(app)
      .post("/settings/agent-credentials")
      .send({ label: "drainer-a", expiresInDays: 7 })
      .expect(201);
    const b = await authed(app)
      .post("/settings/agent-credentials")
      .send({ label: "drainer-b", expiresInDays: 7 })
      .expect(201);
    drainerA = (a.body as CreatedAgentCredential).token;
    drainerB = (b.body as CreatedAgentCredential).token;
    labelA = `Repair Agent "drainer-a"`;
  }, 180_000);

  afterAll(async () => {
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
    delete process.env.VARYS_ACTION_TIMEOUT_MS;
  });

  // ---- the simulated drainer -------------------------------------------------------------

  const rpc = (token: string, method: string, params: unknown) =>
    request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method, params });

  /** One tool call as `token`, returning the parsed result (or the error text). */
  async function call(
    token: string,
    name: string,
    args: unknown = {},
  ): Promise<{ isError: boolean; text: string; data: Record<string, unknown> }> {
    const res = await rpc(token, "tools/call", { name, arguments: args }).expect(200);
    expect(res.body.error).toBeUndefined();
    const result = res.body.result as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? "";
    let data: Record<string, unknown> = {};
    if (!result.isError) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    return { isError: Boolean(result.isError), text, data };
  }

  /** `claim_repair_job` as a drainer would: the claimed job, or null for an empty queue. */
  async function claim(token: string): Promise<ClaimedRepairJob | null> {
    const res = await call(token, "claim_repair_job");
    expect(res.isError).toBe(false);
    return (res.data.job as ClaimedRepairJob | null) ?? null;
  }

  async function release(token: string, jobId: string) {
    return call(token, "release_repair_job", { jobId });
  }

  async function toolNames(token: string): Promise<string[]> {
    const res = await rpc(token, "tools/list", {}).expect(200);
    return (res.body.result.tools as { name: string }[]).map((t) => t.name);
  }

  // ---- fixtures --------------------------------------------------------------------------

  /**
   * A test that clicks the control the broken variant renames.
   *
   * `locator` overrides which control, and therefore which FAILURE CLUSTER the break belongs to.
   * Since clustering (slice 07) a job covers a cluster rather than a test, so two tests that
   * record the SAME broken control share one job — which is correct, and is why the cases here
   * that need two independent jobs ask for two independent breaks. A locator that is not on the
   * page at all fails to resolve exactly as a renamed one does, which is all those cases need.
   */
  function definitionClickingSave(name: string, locator = "save-btn") {
    return {
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        {
          type: "click",
          target: {
            tag: "button",
            testId: locator,
            role: "button",
            accessibleName: "Save changes",
            nameFromAttr: true,
            attributes: { id: locator, "data-testid": locator },
            ancestors: [{ tag: "section", id: "form-panel" }, { tag: "body" }, { tag: "html" }],
            boundingBox: { x: 24, y: 168, width: 140, height: 36 },
            domIndex: 0,
          },
        },
      ],
    };
  }

  async function runToFailure(testId: string): Promise<string> {
    const created = await authed(app).post("/runs").send({ testId }).expect(201);
    const runId = created.body.runId as string;
    for (let i = 0; i < 200; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      if (res.body.status === "failed") return runId;
      if (res.body.status === "passed" || res.body.status === "needs_review") {
        throw new Error(`run ${runId} was expected to fail on its locator`);
      }
      await sleep(200);
    }
    throw new Error(`run ${runId} never finished`);
  }

  /**
   * A real queued job: a test whose click target the broken variant renamed, run once under an
   * `auto` policy so the worker enqueues at the point the locator failure is detected.
   */
  async function queuedJob(
    name: string,
    locator = "save-btn",
  ): Promise<{ testId: string; runId: string; jobId: string }> {
    const created = await authed(app)
      .post("/tests")
      .send(definitionClickingSave(name, locator))
      .expect(201);
    const testId = created.body.id as string;
    await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: "auto" }).expect(200);
    const runId = await runToFailure(testId);
    const [job] = (await queue(true)).filter((j) => j.testId === testId);
    expect(job?.status).toBe("queued");
    return { testId, runId, jobId: job.id };
  }

  async function queue(all = false): Promise<RepairJobSummary[]> {
    const res = await authed(app)
      .get(`/repair-jobs${all ? "?all=1" : ""}`)
      .expect(200);
    return res.body as RepairJobSummary[];
  }

  /**
   * Start a test from a queue holding nothing but what that test is about to create. The queue is
   * project-wide and first-claim-wins, so a job another test left behind would be handed to the
   * next `claim_repair_job` and every assertion about WHICH job came back would be a coin toss.
   */
  async function emptyQueue(): Promise<void> {
    for (const job of await queue()) {
      if (job.status === "queued") await authed(app).post(`/repair-jobs/${job.id}/cancel`).expect(200);
    }
  }

  async function jobById(id: string): Promise<RepairJobSummary> {
    const found = (await queue(true)).find((j) => j.id === id);
    if (!found) throw new Error(`job ${id} vanished from the queue`);
    return found;
  }

  // ---- the lifecycle ---------------------------------------------------------------------

  it("hands the claimer the test, the failing step and the brief — and records who took it", async () => {
    await emptyQueue();
    const { testId, runId, jobId } = await queuedJob("claim payload");
    // The Brief is only written by the authoring path today (slice 05 makes it editable), so
    // state it directly — what is under test is that a claim carries it.
    await consumerDb.db.execute(
      `update tests set intent = 'A member can save their changes' where id = '${testId}'`,
    );

    const job = await claim(drainerA);
    expect(job).toMatchObject({
      jobId,
      testId,
      runId,
      kind: "repair",
      testName: "claim payload",
      brief: "A member can save their changes",
      clusterKey: "testid:save-btn",
      attempts: 0,
      attemptsRemaining: 3,
    });
    // The step that broke, off the version that actually ran — with the run's own error.
    expect(job?.failingStep?.index).toBe(1);
    expect(job?.failingStep?.label).toContain("click");
    expect(job?.failingStep?.error).toContain("could not locate");
    expect(Date.parse(job?.claimExpiresAt ?? "")).toBeGreaterThan(nowMs);

    // …and the queue records the claimer, which is what makes a later repair attributable.
    const row = await jobById(jobId);
    expect(row).toMatchObject({ status: "claimed", claimedBy: expect.stringContaining("agent:") });
    expect(row.claimedAt).toEqual(expect.any(String));
    expect(row.claimExpiresAt).toEqual(expect.any(String));

    await release(drainerA, jobId); // leave the queue clean for the tests below
  }, 180_000);

  it("is exclusive: two drainers claiming at once end up with different jobs, never the same one", async () => {
    await emptyQueue();
    // Two DIFFERENT broken controls, so they are two Failure Clusters and therefore two jobs.
    // Two tests broken by the same control would (correctly, since slice 07) be one job, and
    // there would be nothing for the second drainer to win.
    const first = await queuedJob("race one", "race-one-btn");
    const second = await queuedJob("race two", "race-two-btn");

    const [a, b] = await Promise.all([claim(drainerA), claim(drainerB)]);
    const claimed = [a?.jobId, b?.jobId].filter(Boolean);
    expect(new Set(claimed).size).toBe(2); // two jobs, one each — nobody won twice
    expect(claimed.sort()).toEqual([first.jobId, second.jobId].sort());

    await release(drainerA, a?.jobId ?? "");
    await release(drainerB, b?.jobId ?? "");
    // Both are back and claimable, so this test leaves nothing wedged.
    for (const id of [first.jobId, second.jobId]) {
      expect((await jobById(id)).status).toBe("queued");
    }
  }, 240_000);

  it("hides a claimed job from every other claimer while the claim holds", async () => {
    await emptyQueue();
    const { jobId } = await queuedJob("exclusive");
    const mine = await claim(drainerA);
    expect(mine?.jobId).toBe(jobId);

    // The only job in the queue is claimed, so the other drainer is handed nothing at all —
    // not the same job, and not an error.
    expect(await claim(drainerB)).toBeNull();
    // Nor can it release someone else's claim: it learns nothing about a job it does not hold.
    const stolen = await release(drainerB, jobId);
    expect(stolen.isError).toBe(true);
    expect((await jobById(jobId)).status).toBe("claimed");

    await release(drainerA, jobId);
  }, 180_000);

  it("returns a job to the queue when its claim lapses, counting the attempt", async () => {
    await emptyQueue();
    const { testId, jobId } = await queuedJob("lapsed claim");
    const job = await claim(drainerA);
    expect(job?.jobId).toBe(jobId);
    // While the claim holds, the claimer may read the test it covers.
    expect((await call(drainerA, "read_test", { testId })).isError).toBe(false);

    advanceMinutes(30); // past the lease, without the drainer ever reporting

    const lapsed = await jobById(jobId);
    expect(lapsed).toMatchObject({ status: "queued", claimedBy: null, claimedAt: null, attempts: 1 });
    expect(lapsed.claimExpiresAt).toBeNull();

    // The dead claimer's reach shrank back with it…
    const refused = await call(drainerA, "read_test", { testId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no claimed repair job");

    // …and the work is somebody else's now.
    const retaken = await claim(drainerB);
    expect(retaken?.jobId).toBe(jobId);
    expect(retaken?.attempts).toBe(1);
    expect(retaken?.attemptsRemaining).toBe(2);
    await release(drainerB, jobId);
  }, 180_000);

  it("releases a claim on request, returning the job immediately rather than at the deadline", async () => {
    await emptyQueue();
    const { jobId } = await queuedJob("released");
    const job = await claim(drainerA);
    expect(job?.jobId).toBe(jobId);

    const released = await release(drainerA, jobId);
    expect(released.isError).toBe(false);
    expect(released.data.status).toBe("queued");

    // No clock movement at all: it is claimable again right now.
    const row = await jobById(jobId);
    expect(row).toMatchObject({ status: "queued", claimedBy: null, attempts: 1 });
    const retaken = await claim(drainerB);
    expect(retaken?.jobId).toBe(jobId);
    await release(drainerB, jobId);
  }, 180_000);

  it("abandons a job that burns through the attempt cap, and stops offering it", async () => {
    await emptyQueue();
    const { testId, jobId } = await queuedJob("impossible");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = await claim(drainerA);
      expect(job?.jobId).toBe(jobId);
      expect(job?.attempts).toBe(attempt - 1);
      // Alternate how the attempt ends: a lapse and a release must both count, or a drainer
      // that keeps releasing loops on an unfixable job forever.
      if (attempt === 2) advanceMinutes(30);
      else await release(drainerA, jobId);
    }

    const abandoned = await jobById(jobId);
    expect(abandoned).toMatchObject({ status: "failed", attempts: 3, claimedBy: null });
    // Terminal: gone from the outstanding queue, and no drainer is offered it again.
    expect((await queue()).some((j) => j.id === jobId)).toBe(false);
    expect(await claim(drainerA)).toBeNull();
    // …and the credential's reach over that test is gone with the claim.
    expect((await call(drainerA, "read_test", { testId })).isError).toBe(true);
  }, 240_000);

  it("scopes the claimer to the test it claimed, and nothing else", async () => {
    await emptyQueue();
    // Different clusters again: a test in the SAME cluster is deliberately IN scope now, because a
    // clustered repair has to be written across all of them. "Nothing else" means another cluster.
    const claimed = await queuedJob("in scope", "in-scope-btn");
    const other = await queuedJob("out of scope", "out-of-scope-btn");
    const job = await claim(drainerA);
    expect(job?.jobId).toBe(claimed.jobId);

    expect((await call(drainerA, "read_test", { testId: claimed.testId })).isError).toBe(false);
    const refused = await call(drainerA, "read_test", { testId: other.testId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(labelA);

    await release(drainerA, claimed.jobId);
  }, 240_000);

  it("does not put the claim tools in a human's hands", async () => {
    const human = await toolNames(mcpToken());
    expect(human).not.toContain("claim_repair_job");
    expect(human).not.toContain("release_repair_job");

    await emptyQueue();
    const { jobId } = await queuedJob("human hands off");
    const res = await call(mcpToken(), "claim_repair_job");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Unknown tool");
    expect((await jobById(jobId)).status).toBe("queued"); // untouched

    // The agent, meanwhile, sees both.
    const agent = await toolNames(drainerA);
    expect(agent).toEqual(expect.arrayContaining(["claim_repair_job", "release_repair_job"]));
  }, 180_000);

  it("answers an empty queue with nothing, which is not an error", async () => {
    await emptyQueue();
    const res = await call(drainerA, "claim_repair_job");
    expect(res.isError).toBe(false);
    expect(res.data.job).toBeNull();
  }, 180_000);
});
