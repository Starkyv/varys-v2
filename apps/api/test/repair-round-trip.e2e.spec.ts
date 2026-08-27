import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import type {
  ClaimedRepairJob,
  CreatedAgentCredential,
  RepairJobSummary,
  RepairReviewItem,
} from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { CLOCK, type Clock } from "../src/repair-jobs/clock";
import { JUDGE_SOURCE, type JudgeSource } from "../src/repair-jobs/judge";
import { authed, mcpToken, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The repair round trip (Slice 19, slice 04): a real locator break → a queued job → a claim → a
 * repair driven through the real repair tools → an UNREVIEWED version → a human accept or reject.
 *
 * Two things this suite exists to pin down, and they are both about what does NOT happen:
 *
 *  - **The run stays failed.** A repair proposes; it does not reach back and recolour the run that
 *    failed. Slice 06 adds a RE-RUN and the `healed` outcome on top of this — a NEW run against the
 *    repaired definition — and it changes nothing here: the original failure is history and stays
 *    red. (`healed` deliberately landed behind slice 05's justification gate, so the state where a
 *    repair turns a run green with no guard in front of it never existed, not even mid-build.)
 *  - **A claim is not a licence.** The agent's tools reach the test of the job it holds and no
 *    other, and the reach ends the moment the claim does — reported, released or lapsed — even
 *    with a repair session still parked on the page.
 *
 * The drainer is SIMULATED: this test speaks the claim protocol over HTTP on a Repair Agent
 * credential and drives the same MCP tools Claude would (`open_repair_session`, `try_locator`,
 * `apply_fix`, `report_repair`). There is no live Claude and no need for one — everything the
 * slice promises is a property of the queue, the scope check and the version write.
 *
 * The break is real: a `@varys/fixture-app` variant renames, resizes and re-parents the target, so
 * the recorded fingerprint genuinely has no signal left to match, and the fix (`data-testid` =
 * the control's new id) genuinely resolves against the live page.
 */
describe("A claimed Repair Job is repaired into an unreviewed version", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
  let pool: Pool;
  let drainer: string;
  let otherDrainer: string;
  let label: string;

  /** Injected so a lease can lapse without the suite sleeping through it. */
  let nowMs = Date.now();
  const clock: Clock = { now: () => new Date(nowMs) };

  /** Every repair here is gated on its justification (slice 05), so the suite needs a judge. This
   *  one passes everything: what the gate REFUSES is `repair-justification-gate.e2e.spec.ts`'s
   *  subject, and pinning it in two places would mean two rubrics to keep in step. */
  const judgeSource: JudgeSource = {
    resolve: async () => ({
      judge: async () => ({ verdict: "pass" as const, reasoning: "same control, renamed" }),
    }),
  };

  beforeAll(async () => {
    fixture = await startFixtureServer();
    // Every run below is recorded against `locatorRepair` and executed against the variant that
    // renamed the control — a genuine hard-fail, not a stubbed one.
    fixture.setVariant("locatorRepairBroken");
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-roundtrip-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    process.env.VARYS_ACTION_TIMEOUT_MS = "1500"; // every run here fails on purpose

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(JUDGE_SOURCE)
      .useValue(judgeSource)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    pool = new Pool({ connectionString: db.connectionString });
    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) => processRun({ db: consumerDb.db, storage }, runId));

    const created = await authed(app)
      .post("/settings/agent-credentials")
      .send({ label: "round-trip", expiresInDays: 7 })
      .expect(201);
    drainer = (created.body as CreatedAgentCredential).token;
    const second = await authed(app)
      .post("/settings/agent-credentials")
      .send({ label: "bystander", expiresInDays: 7 })
      .expect(201);
    otherDrainer = (second.body as CreatedAgentCredential).token;
    label = `Repair Agent "round-trip"`;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
    delete process.env.VARYS_ACTION_TIMEOUT_MS;
  });

  // ---- the simulated drainer -------------------------------------------------------------

  async function call(
    token: string,
    name: string,
    args: unknown = {},
  ): Promise<{ isError: boolean; text: string; data: Record<string, unknown> }> {
    const res = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
    expect(res.body.error).toBeUndefined();
    const result = res.body.result as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? "";
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = {};
    }
    return { isError: Boolean(result.isError), text, data };
  }

  /** A tool call that must succeed — fails the test with the tool's own message if it doesn't. */
  async function ok(token: string, name: string, args: unknown = {}) {
    const res = await call(token, name, args);
    if (res.isError) throw new Error(`tool ${name} failed: ${res.text}`);
    return res.data;
  }

  // ---- fixtures --------------------------------------------------------------------------

  /** A test clicking the control that the broken variant renamed away. */
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

  async function queue(all = false): Promise<RepairJobSummary[]> {
    const res = await authed(app)
      .get(`/repair-jobs${all ? "?all=1" : ""}`)
      .expect(200);
    return res.body as RepairJobSummary[];
  }

  /** Start from a queue holding nothing but what this test is about to create — the queue is
   *  project-wide and first-claim-wins, so a leftover job would make "which job came back" a
   *  coin toss. */
  async function emptyQueue(): Promise<void> {
    for (const job of await queue()) {
      if (job.status === "queued") await authed(app).post(`/repair-jobs/${job.id}/cancel`).expect(200);
    }
  }

  /** A real queued job: a test whose click target the variant renamed, run once under an `auto`
   *  policy so the worker enqueues where the locator failure is detected. */
  async function queuedJob(name: string, locator = "save-btn") {
    const created = await authed(app)
      .post("/tests")
      .send(definitionClickingSave(name, locator))
      .expect(201);
    const testId = created.body.id as string;
    // A Brief is now a precondition of automatic repair: the gate has to have a clause to check
    // the agent's justification against (slice 05).
    await authed(app)
      .patch(`/tests/${testId}`)
      .send({
        repairPolicy: "auto",
        brief: "Saving the form must work: the primary save control on the form panel commits the changes.",
      })
      .expect(200);
    const runId = await runToFailure(testId);
    const [job] = (await queue(true)).filter((j) => j.testId === testId);
    expect(job?.status).toBe("queued");
    return { testId, runId, jobId: job.id };
  }

  async function jobById(id: string): Promise<RepairJobSummary> {
    const found = (await queue(true)).find((j) => j.id === id);
    if (!found) throw new Error(`job ${id} vanished from the queue`);
    return found;
  }

  async function reviews(): Promise<RepairReviewItem[]> {
    const res = await authed(app).get("/repair-jobs/reviews").expect(200);
    return res.body as RepairReviewItem[];
  }

  async function latestVersion(testId: string) {
    const rows = await pool.query(
      `SELECT version, definition, review_state, created_by FROM test_versions
        WHERE test_id = $1 ORDER BY version DESC LIMIT 1`,
      [testId],
    );
    return rows.rows[0] as {
      version: number;
      definition: { steps: Record<string, unknown>[] };
      review_state: string;
      created_by: string | null;
    };
  }

  /**
   * The whole drainer loop, as an unattended agent would run it: claim, open a repair session on
   * the failure, find a candidate that resolves against the live page, write it, report it.
   */
  async function drain(token: string): Promise<{
    job: ClaimedRepairJob;
    sessionId: string;
    applied: Record<string, unknown>;
    reported: Record<string, unknown>;
  }> {
    const claimed = (await ok(token, "claim_repair_job")).job as ClaimedRepairJob | null;
    if (!claimed) throw new Error("expected a claimable job");

    const session = await ok(token, "open_repair_session", { runId: claimed.runId });
    const sessionId = String(session.sessionId);

    // The control was renamed to `commit-btn`; prove that resolves before writing it.
    const tried = await ok(token, "try_locator", { sessionId, testId: "commit-btn" });
    expect(tried.status).toBe("resolved");

    const applied = await ok(token, "apply_fix", { sessionId, testId: "commit-btn" });
    const reported = await ok(token, "report_repair", {
      jobId: claimed.jobId,
      summary: 'Re-pinned the click to the "Commit changes" button (data-testid=commit-btn).',
      justification:
        'The Brief requires that "the primary save control on the form panel commits the changes". It is the same control, relabelled: the button in #form-panel that was data-testid=save-btn / "Save changes" is now data-testid=commit-btn / "Commit changes" — same element, same position, same action.',
    });
    return { job: claimed, sessionId, applied, reported };
  }

  // ---- the round trip --------------------------------------------------------------------

  it("repairs the claimed test, writes an unreviewed version, and leaves the run failed", async () => {
    await emptyQueue();
    const { testId, runId, jobId } = await queuedJob("round trip");
    const { job, sessionId, applied, reported } = await drain(drainer);
    expect(job.jobId).toBe(jobId);
    expect(applied.version).toBe(2);

    // The version exists, is UNREVIEWED, and is attributed to the agent's label — not to a human.
    const written = await latestVersion(testId);
    expect(written.version).toBe(2);
    expect(written.review_state).toBe("unreviewed");
    expect(written.created_by).toContain(label);
    expect(JSON.stringify(written.definition.steps[1])).toContain("commit-btn");

    // The report says what happened and, more importantly, what did not.
    expect(reported).toMatchObject({
      ok: true,
      jobId,
      status: "done",
      testId,
      version: 2,
      reviewState: "unreviewed",
      runId,
      runStatus: "failed",
    });

    // The run that started all this is UNTOUCHED. This is the load-bearing assertion of the
    // slice: a repair proposes, it does not turn anything green.
    const run = await authed(app).get(`/runs/${runId}`).expect(200);
    expect(run.body.status).toBe("failed");

    // And it is waiting for a human, with the context a decision needs.
    const item = (await reviews()).find((r) => r.testId === testId);
    expect(item).toMatchObject({
      testName: "round trip",
      version: 2,
      previousVersion: 1,
      jobId,
      runId,
      isActiveDefinition: true,
    });
    expect(item?.report).toContain("Commit changes");
    expect(item?.createdBy).toContain(label);

    // Reporting ended the claim, so the credential's reach over that test ended with it…
    const refused = await call(drainer, "read_test", { testId });
    expect(refused.isError).toBe(true);
    // …including through the session it opened under that claim, which is still parked.
    const stale = await call(drainer, "apply_fix", { sessionId, testId: "commit-btn" });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("no longer holds a claim");
    // Closing it is still allowed — otherwise the browser would be left running with no way out.
    expect((await call(drainer, "close_repair_session", { sessionId })).isError).toBe(false);

    // Accepting marks it reviewed, and the repaired definition is the active one.
    const accepted = await authed(app)
      .post(`/repair-jobs/reviews/${item?.versionId}/accept`)
      .expect(200);
    expect(accepted.body).toMatchObject({ ok: true, reviewState: "reviewed", revertedToVersion: null });
    const after = await latestVersion(testId);
    expect(after.version).toBe(2);
    expect(after.review_state).toBe("reviewed");
    expect(JSON.stringify(after.definition.steps[1])).toContain("commit-btn");
    // Gone from the queue, and not decidable twice.
    expect((await reviews()).some((r) => r.testId === testId)).toBe(false);
    await authed(app).post(`/repair-jobs/reviews/${item?.versionId}/accept`).expect(409);
    expect((await jobById(jobId)).status).toBe("done");
  }, 300_000);

  it("reverts the test to its previous version when the repair is rejected, and ends the job", async () => {
    await emptyQueue();
    const { testId, runId, jobId } = await queuedJob("rejected repair");
    const before = await latestVersion(testId);
    const { sessionId } = await drain(drainer);
    await call(drainer, "close_repair_session", { sessionId });

    const item = (await reviews()).find((r) => r.testId === testId);
    const rejected = await authed(app)
      .post(`/repair-jobs/reviews/${item?.versionId}/reject`)
      .expect(200);
    expect(rejected.body).toMatchObject({ ok: true, reviewState: "rejected", revertedToVersion: 3 });

    // The test says what it said before the agent touched it — restored by APPENDING, so the
    // rejected attempt is still in the history rather than erased.
    const after = await latestVersion(testId);
    expect(after.version).toBe(3);
    expect(after.definition).toEqual(before.definition);
    expect(after.review_state).toBe("reviewed");
    expect(after.created_by).toContain("rejected repair v2");

    // Terminal, and terminally unsuccessful: no drainer is offered it again.
    expect((await jobById(jobId)).status).toBe("failed");
    expect((await queue()).some((j) => j.id === jobId)).toBe(false);
    expect((await reviews()).some((r) => r.testId === testId)).toBe(false);
    // The run is STILL failed — a rejection changes nothing about the failure that started this.
    expect((await authed(app).get(`/runs/${runId}`).expect(200)).body.status).toBe("failed");
  }, 300_000);

  it("refuses the repair tools for a test the claim does not cover, and for a lapsed claim", async () => {
    await emptyQueue();
    // Two DIFFERENT broken controls, so they are two Failure Clusters and therefore two jobs.
    // Since slice 07 a claim reaches every test in ITS cluster — that is how a clustered repair is
    // written — so "a test the claim does not cover" means one in another cluster.
    const mine = await queuedJob("in scope", "in-scope-btn");
    const theirs = await queuedJob("out of scope", "out-of-scope-btn"); // queued, unclaimed by anyone
    const claimed = (await ok(drainer, "claim_repair_job")).job as ClaimedRepairJob;

    // Whichever job came back, the OTHER test is out of reach — and not merely unwritable:
    // opening a repair session on it is refused too.
    const outOfScope = claimed.testId === mine.testId ? theirs : mine;
    for (const args of [{ testId: outOfScope.testId }, { runId: outOfScope.runId }]) {
      const refused = await call(drainer, "open_repair_session", args);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(label);
    }
    expect((await call(drainer, "read_test", { testId: outOfScope.testId })).isError).toBe(true);
    expect((await call(drainer, "edit_test", { testId: outOfScope.testId, name: "hijacked" })).isError).toBe(true);
    // Nor may a second agent, holding no claim at all, touch either of them.
    expect((await call(otherDrainer, "read_test", { testId: mine.testId })).isError).toBe(true);

    // A repair session opened legitimately stops working the moment the lease lapses.
    const session = await ok(drainer, "open_repair_session", { runId: claimed.runId });
    const sessionId = String(session.sessionId);
    nowMs += 30 * 60_000; // past the lease, without a report
    const lapsed = await call(drainer, "apply_fix", { sessionId, testId: "commit-btn" });
    expect(lapsed.isError).toBe(true);
    expect(lapsed.text).toContain("no longer holds a claim");
    await call(drainer, "close_repair_session", { sessionId });

    // Nothing was written: the test is still on the version that failed.
    expect((await latestVersion(claimed.testId)).version).toBe(1);
  }, 420_000);

  it("refuses a report with no repair behind it, and one for a job it does not hold", async () => {
    await emptyQueue();
    const { jobId } = await queuedJob("empty report");
    const claimed = (await ok(drainer, "claim_repair_job")).job as ClaimedRepairJob;
    expect(claimed.jobId).toBe(jobId);

    // Claimed, but nothing applied. A job closed `done` with no version behind it would be
    // indistinguishable later from one that actually worked.
    const empty = await call(drainer, "report_repair", {
      jobId,
      summary: "all good now",
      justification: "the Brief's save clause — same control, relabelled",
    });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("no repair to report");
    expect((await jobById(jobId)).status).toBe("claimed");

    // Someone else's claim is not-found, not a conflict — a claimant learns nothing about jobs
    // it does not hold.
    const stolen = await call(otherDrainer, "report_repair", {
      jobId,
      summary: "mine now",
      justification: "the Brief's save clause — same control, relabelled",
    });
    expect(stolen.isError).toBe(true);
    expect((await jobById(jobId)).status).toBe("claimed");

    await call(drainer, "release_repair_job", { jobId });
  }, 300_000);

  it("keeps baseline approval, and the review decision, out of the agent's hands", async () => {
    await emptyQueue();
    const { testId, runId } = await queuedJob("approval stays human");
    const claimed = (await ok(drainer, "claim_repair_job")).job as ClaimedRepairJob;
    expect(claimed.testId).toBe(testId);

    // No approval tool exists for anyone, agent included — approving deletes the previous
    // baseline with no rollback (DESIGN §4), so it is web-UI only, at every point in this flow.
    const list = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${drainer}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(200);
    const names = (list.body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["report_repair", "apply_fix"]));
    expect(names.some((n) => /approve|baseline|promote/.test(n))).toBe(false);

    // …and the HTTP surfaces a human uses do not accept an agent credential.
    await request(app.getHttpServer())
      .post(`/runs/${runId}/approve-all`)
      .set("Authorization", `Bearer ${drainer}`)
      .expect(401);
    await request(app.getHttpServer())
      .get("/repair-jobs/reviews")
      .set("Authorization", `Bearer ${drainer}`)
      .expect(401);

    // The human MCP principal, meanwhile, cannot report a repair at all: it is agent-only.
    const human = await call(mcpToken(), "report_repair", {
      jobId: claimed.jobId,
      summary: "x",
      justification: "x",
    });
    expect(human.isError).toBe(true);
    expect(human.text).toContain("Unknown tool");

    await call(drainer, "release_repair_job", { jobId: claimed.jobId });
  }, 300_000);
});
