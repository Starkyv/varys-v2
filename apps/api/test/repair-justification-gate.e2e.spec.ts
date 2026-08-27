import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import type { JudgeInput, JudgeProvider, JudgeResult } from "@varys/judge-engine";
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
import { JUDGE_SOURCE, type JudgeSource } from "../src/repair-jobs/judge";
import { authed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The brief-justification gate (Slice 19, slice 05): the guard that stops a plausible-but-wrong
 * repair from landing.
 *
 * What this suite pins is the CONSEQUENCE of each verdict, end to end and through the real
 * machinery — a real locator break, a real claim, a real repair written by the real tools, and
 * then the gate. The judge itself is scripted, deliberately: the verdicts are the inputs here, and
 * the thing under test is what Varys does with them.
 *
 *  - **pass** → the version stands, unreviewed, with the justification stored beside the Brief.
 *  - **fail** → the repair is ABANDONED: the test goes back to what it said before, the run is
 *    still failed, and the job ends terminally so the next drainer does not re-pin to the same
 *    plausible substitute.
 *  - **throw** → also abandoned, never applied — but the job returns to the queue, because a
 *    broken judge says nothing about the repair.
 *  - **no Brief at all** → refused before any judge is asked: there is no clause to check against,
 *    and an unchecked repair is exactly what this gate exists to prevent.
 *
 * The rubric's WORDING — whether the real model accepts a rename and rejects a substitution — is
 * exercised by the live-judge block at the bottom, which runs only when a real judge is configured
 * (`VARYS_JUDGE_API_KEY` + `VARYS_JUDGE_MODEL`). It is skipped in CI rather than faked, because a
 * fake judge cannot tell you anything about the wording of a prompt.
 *
 * The two breaks are real, and they are the two cases the gate has to tell apart:
 *  - `locatorRepairBroken` — the same control, RENAMED. A genuine repair.
 *  - `locatorRepairDeleted` — the control is GONE, and a different, plausible one ("Refresh") sits
 *    in its place. Re-pinning to it produces a locator that resolves perfectly and asserts the
 *    wrong thing. This is the scenario the gate exists for.
 */
describe("Every repair is gated on a brief-clause justification", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
  let pool: Pool;
  let drainer: string;

  /** The scripted judge, steered per scenario — the same shape `context-compare.e2e.spec.ts`
   *  uses for the checkpoint judge. `calls` proves the gate ASKED (a no-Brief refusal must not). */
  let judgeMode: "pass" | "fail" | "throw" | "absent" = "pass";
  let judgeCalls: JudgeInput[] = [];
  const judgeSource: JudgeSource = {
    resolve: async (): Promise<JudgeProvider | undefined> => {
      if (judgeMode === "absent") return undefined;
      return {
        judge: async (input: JudgeInput): Promise<JudgeResult> => {
          judgeCalls.push(input);
          if (judgeMode === "throw") throw new Error("judge failed after 3 attempt(s): overloaded");
          return judgeMode === "pass"
            ? { verdict: "pass", reasoning: "the same control, relabelled" }
            : { verdict: "fail", reasoning: "this is a different control, not the one that was removed" };
        },
      };
    },
  };

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-justification-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    process.env.VARYS_ACTION_TIMEOUT_MS = "1500"; // every run here fails on purpose

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
      .send({ label: "gate", expiresInDays: 7 })
      .expect(201);
    drainer = (created.body as CreatedAgentCredential).token;
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
    name: string,
    args: unknown = {},
  ): Promise<{ isError: boolean; text: string; data: Record<string, unknown> }> {
    const res = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${drainer}`)
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

  async function ok(name: string, args: unknown = {}) {
    const res = await call(name, args);
    if (res.isError) throw new Error(`tool ${name} failed: ${res.text}`);
    return res.data;
  }

  // ---- fixtures --------------------------------------------------------------------------

  const BRIEF =
    "Saving the form must work: the primary save control on the form panel commits the changes.";

  /** A test clicking the control that both broken variants take away. */
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

  /** The queue is project-wide and first-claim-wins, so a leftover job would make "which job did
   *  I claim" a coin toss. `keep` is the one job this case is about. */
  async function emptyQueue(keep?: string): Promise<void> {
    for (const job of await queue()) {
      if (job.status === "queued" && job.id !== keep) {
        await authed(app).post(`/repair-jobs/${job.id}/cancel`).expect(200);
      }
    }
  }

  /**
   * Wait until no run is in flight.
   *
   * Since slice 06 an ACCEPTED repair queues a re-run of the test it fixed, so a passing case
   * leaves a run executing after its assertions are done. It replays the repaired definition
   * against whatever variant the fixture is serving by the time it gets there — and the next case
   * flips that variant — so left alone it can fail on a locator and enqueue a repair job of its
   * own, which the drainer below would then claim instead of the one under test. Draining to quiet
   * before touching the variant is what keeps each case's queue its own.
   */
  async function quiesce(): Promise<void> {
    for (let i = 0; i < 300; i++) {
      const rows = (await authed(app).get("/runs").expect(200)).body as { status: string }[];
      if (!rows.some((r) => r.status === "queued" || r.status === "running")) return;
      await sleep(200);
    }
    throw new Error("runs never settled");
  }

  /** A real queued job on a real break: pick the variant, and whether the test has a Brief. */
  async function queuedJob(
    name: string,
    variant: "locatorRepairBroken" | "locatorRepairDeleted",
    brief: string | null = BRIEF,
  ) {
    await quiesce();
    fixture.setVariant(variant);
    await emptyQueue();
    const created = await authed(app).post("/tests").send(definitionClickingSave(name)).expect(201);
    const testId = created.body.id as string;
    await authed(app)
      .patch(`/tests/${testId}`)
      .send(brief === null ? { repairPolicy: "auto" } : { repairPolicy: "auto", brief })
      .expect(200);
    const runId = await runToFailure(testId);
    const [job] = (await queue(true)).filter((j) => j.testId === testId);
    expect(job?.status).toBe("queued");
    // Anything else that reached the queue while this case was setting up goes now, so
    // `claim_repair_job` below can only return the job this case is about.
    await emptyQueue(job.id);
    judgeCalls = [];
    return { testId, runId, jobId: job.id };
  }

  async function jobById(id: string): Promise<RepairJobSummary> {
    const found = (await queue(true)).find((j) => j.id === id);
    if (!found) throw new Error(`job ${id} vanished from the queue`);
    return found;
  }

  async function versions(testId: string) {
    const rows = await pool.query(
      `SELECT version, definition, review_state, justification, justification_reasoning, created_by
         FROM test_versions WHERE test_id = $1 ORDER BY version ASC`,
      [testId],
    );
    return rows.rows as Array<{
      version: number;
      definition: { steps: Record<string, unknown>[] };
      review_state: string;
      justification: string | null;
      justification_reasoning: string | null;
      created_by: string | null;
    }>;
  }

  async function reviews(): Promise<RepairReviewItem[]> {
    const res = await authed(app).get("/repair-jobs/reviews").expect(200);
    return res.body as RepairReviewItem[];
  }

  /** Claim, diagnose, re-pin to `newTestId`, and write it — everything up to (not including) the
   *  report, which is what each scenario below varies. */
  async function repairUpTo(newTestId: string, expectedJobId?: string): Promise<ClaimedRepairJob> {
    const claimed = (await ok("claim_repair_job")).job as ClaimedRepairJob | null;
    if (!claimed) throw new Error("expected a claimable job");
    // Claiming somebody else's job would make every assertion below meaningless in a way that is
    // very hard to read from the eventual failure — so say it here instead.
    if (expectedJobId) expect(claimed.jobId).toBe(expectedJobId);
    const session = await ok("open_repair_session", { runId: claimed.runId });
    const sessionId = String(session.sessionId);
    const tried = await ok("try_locator", { sessionId, testId: newTestId });
    // The point of the whole slice: the wrong fix resolves just as cleanly as the right one.
    expect(tried.status).toBe("resolved");
    await ok("apply_fix", { sessionId, testId: newTestId });
    return claimed;
  }

  const GOOD_JUSTIFICATION =
    'The Brief requires that "the primary save control on the form panel commits the changes". It is the same control, relabelled: the button that was data-testid=save-btn / "Save changes" is now data-testid=commit-btn / "Commit changes" — same element, same action.';

  // ---- the gate --------------------------------------------------------------------------

  it("refuses a repair with no brief-clause justification, without abandoning it", async () => {
    judgeMode = "pass";
    const { testId, jobId } = await queuedJob("no justification", "locatorRepairBroken");
    await repairUpTo("commit-btn", jobId);

    const refused = await call("report_repair", { jobId, summary: "re-pinned the click" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/justification/i);
    expect(refused.text).toMatch(/Brief/);
    // No judge was troubled, and — crucially — the repair was NOT thrown away: an agent that
    // simply forgot the argument can make it and report again.
    expect(judgeCalls).toHaveLength(0);
    expect((await jobById(jobId)).status).toBe("claimed");
    expect((await versions(testId)).map((v) => v.review_state)).toEqual(["reviewed", "unreviewed"]);

    // ...which it now does, and the repair stands.
    const reported = await ok("report_repair", {
      jobId,
      summary: "re-pinned the click",
      justification: GOOD_JUSTIFICATION,
    });
    expect(reported.status).toBe("done");
  }, 300_000);

  it("validates the justification against the Brief and the actual before/after signals", async () => {
    judgeMode = "pass";
    const { jobId } = await queuedJob("judged evidence", "locatorRepairBroken");
    await repairUpTo("commit-btn", jobId);
    await ok("report_repair", {
      jobId,
      summary: "re-pinned the click",
      justification: GOOD_JUSTIFICATION,
    });

    // The gate is not shown the agent's account alone: the Brief it must be checked against, and
    // the signal change as the DEFINITIONS record it, both reach the judge. Without them the
    // verdict would be a review of the agent's prose.
    expect(judgeCalls).toHaveLength(1);
    const prompt = judgeCalls[0].prompt;
    expect(prompt).toContain(BRIEF);
    expect(prompt).toContain(GOOD_JUSTIFICATION);
    expect(prompt).toContain("save-btn");
    expect(prompt).toContain("commit-btn");
    // Text-only, and graded on its own rubric rather than the visual-QA one.
    expect(judgeCalls[0].baseline).toBeUndefined();
    expect(judgeCalls[0].system).toMatch(/safety gate/i);
  }, 300_000);

  it("stores an accepted justification on the version and shows it beside the brief", async () => {
    judgeMode = "pass";
    const { testId, jobId } = await queuedJob("accepted justification", "locatorRepairBroken");
    await repairUpTo("commit-btn", jobId);
    const reported = await ok("report_repair", {
      jobId,
      summary: "re-pinned the click to the Commit changes button",
      justification: GOOD_JUSTIFICATION,
    });

    expect(reported.justification).toBe(GOOD_JUSTIFICATION);
    expect(reported.justificationReasoning).toBe("the same control, relabelled");

    const stored = (await versions(testId)).at(-1);
    expect(stored?.review_state).toBe("unreviewed");
    expect(stored?.justification).toBe(GOOD_JUSTIFICATION);
    expect(stored?.justification_reasoning).toBe("the same control, relabelled");

    // And the reviewer sees the claim next to the thing it was checked against — a verdict with
    // no Brief beside it tells them nothing.
    const item = (await reviews()).find((r) => r.testId === testId);
    expect(item?.justification).toBe(GOOD_JUSTIFICATION);
    expect(item?.justificationReasoning).toBe("the same control, relabelled");
    expect(item?.brief).toBe(BRIEF);
  }, 300_000);

  it("abandons the repair when the justification is rejected: test unchanged, run still failed", async () => {
    judgeMode = "fail";
    // The scenario the gate exists for: "Save changes" is GONE, and the agent re-pins to the
    // plausible "Refresh" button that took its place.
    const { testId, runId, jobId } = await queuedJob("wrong control", "locatorRepairDeleted");
    const before = await versions(testId);
    await repairUpTo("refresh-btn", jobId);

    const refused = await call("report_repair", {
      jobId,
      summary: "re-pinned the click to the Refresh button",
      justification:
        'The Brief says saving must work, and Refresh re-runs the form, which achieves the same outcome.',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("NOT applied");
    expect(refused.text).toContain("different control");

    // The test is back on what it said before — same definition, not merely a reverted flag.
    const after = await versions(testId);
    expect(after.at(-1)?.definition).toEqual(before.at(-1)?.definition);
    expect(JSON.stringify(after.at(-1)?.definition)).toContain("save-btn");
    expect(JSON.stringify(after.at(-1)?.definition)).not.toContain("refresh-btn");
    // The repaired version is kept, marked `rejected` — the attempt stays readable.
    expect(after.filter((v) => v.review_state === "rejected")).toHaveLength(1);
    // And nothing is waiting for a human: an abandoned repair is not a review item.
    expect((await reviews()).some((r) => r.testId === testId)).toBe(false);

    // The run is untouched, and the job is terminal — the next drainer will not re-pin to the
    // same plausible substitute and be refused again.
    const run = await authed(app).get(`/runs/${runId}`).expect(200);
    expect(run.body.status).toBe("failed");
    expect((await jobById(jobId)).status).toBe("failed");
  }, 300_000);

  it("abandons the repair when the judge throws — and gives the job back to the queue", async () => {
    judgeMode = "throw";
    const { testId, runId, jobId } = await queuedJob("judge down", "locatorRepairBroken");
    const before = await versions(testId);
    await repairUpTo("commit-btn", jobId);

    const refused = await call("report_repair", {
      jobId,
      summary: "re-pinned the click",
      justification: GOOD_JUSTIFICATION,
    });
    // A transport error is NOT a pass. The repair is gone, not applied-and-flagged.
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("NOT applied");
    expect(refused.text).toMatch(/could not be validated/i);

    const after = await versions(testId);
    expect(after.at(-1)?.definition).toEqual(before.at(-1)?.definition);
    const run = await authed(app).get(`/runs/${runId}`).expect(200);
    expect(run.body.status).toBe("failed");

    // But a broken judge says nothing about THIS repair, so the job is retryable rather than
    // burned — an expired API key must not quietly empty the queue.
    const job = await jobById(jobId);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(job.claimedBy).toBeNull();
  }, 300_000);

  it("refuses to repair a test with no Brief at all, without asking a judge", async () => {
    judgeMode = "pass";
    const { testId, runId, jobId } = await queuedJob("no brief", "locatorRepairBroken", null);
    const before = await versions(testId);
    await repairUpTo("commit-btn", jobId);

    const refused = await call("report_repair", {
      jobId,
      summary: "re-pinned the click",
      justification: "it is the same button, renamed",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no Brief");
    // Nothing to check the claim against means nothing was checked — so nothing is asked, and
    // nothing is applied.
    expect(judgeCalls).toHaveLength(0);
    expect((await versions(testId)).at(-1)?.definition).toEqual(before.at(-1)?.definition);
    const run = await authed(app).get(`/runs/${runId}`).expect(200);
    expect(run.body.status).toBe("failed");
    expect((await jobById(jobId)).status).toBe("failed");
  }, 300_000);

  it("refuses when no judge is configured — an unvalidated repair is never applied", async () => {
    judgeMode = "absent";
    const { testId, jobId } = await queuedJob("no judge", "locatorRepairBroken");
    const before = await versions(testId);
    await repairUpTo("commit-btn", jobId);

    const refused = await call("report_repair", {
      jobId,
      summary: "re-pinned the click",
      justification: GOOD_JUSTIFICATION,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no judge is configured");
    expect((await versions(testId)).at(-1)?.definition).toEqual(before.at(-1)?.definition);
    expect((await jobById(jobId)).status).toBe("queued");
    judgeMode = "pass";
  }, 300_000);
});
