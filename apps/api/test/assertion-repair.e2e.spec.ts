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
  RunView,
  TestConfigView,
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
 * Extraction-failed is repairable; relation-false never is (Slice 19, slice 10).
 *
 * This is the smallest slice in the assertions branch by line count and the most important one,
 * because it is where a safety property stops being a comment and becomes executable. Two fixture
 * variants make the whole argument, and they differ by one thing each:
 *
 *  - `totalsMissing` — the arithmetic is CORRECT and the element the total is read from moved
 *    (`span#total` → `strong#invoice-total`). Varys can no longer look. That is a locator failure,
 *    identical in kind to a broken click target, and it earns a REPAIR job.
 *  - `totalsWrong`   — the same markup, and a total that does not add up. Varys looked, read both
 *    values, and they disagree. That is evidence about the APPLICATION, and it earns a repair job
 *    under no policy, at no threshold, by no agent — because the only way to "repair" it is to
 *    re-pin until the numbers agree, which is a machine for hiding the exact bugs assertions exist
 *    to catch.
 *
 * Both refusals are asserted through the paths that could bypass them: the unattended enqueue in
 * the worker, and the by-hand enqueue endpoint a human can reach.
 */
describe("An assertion's extraction failure is repairable; its false relation never is", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
  let pool: Pool;
  let drainer: string;

  /** The justification gate (slice 05) sits in front of every repair, so the suite needs a judge.
   *  What the gate REFUSES is `repair-justification-gate.e2e.spec.ts`'s subject. */
  const judgeSource: JudgeSource = {
    resolve: async () => ({
      judge: async () => ({ verdict: "pass" as const, reasoning: "same total, re-marked-up" }),
    }),
  };

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-assertion-repair-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    // Every extraction failure below is deliberate; don't sit out a 30s default waiting for it.
    process.env.VARYS_ACTION_TIMEOUT_MS = "1500";

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
      .send({ label: "assertion-repair", expiresInDays: 7 })
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

  // ---- helpers ---------------------------------------------------------------------------

  /** "The total equals the sum of the line items" — pinned by hand, reading `span#total` on the
   *  left and the set of row amounts on the right. */
  const totalMatchesSum = {
    id: "total-matches-sum",
    check: "The total equals the sum of the line items",
    pinned: {
      kind: "relation",
      left: { target: { tag: "span", testId: "total", attributes: { id: "total" } }, as: "number" },
      right: {
        target: { tag: "td", testId: "row-amount", cssPath: "#invoice .amount" },
        as: "sum-number",
      },
      relation: "eq",
      tolerance: 0.01,
    },
  };

  async function createTest(
    name: string,
    policy: "manual" | "auto",
  ): Promise<string> {
    const res = await authed(app)
      .post("/tests")
      .send({
        name,
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        steps: [{ type: "navigate", url: fixture.url }],
        assertions: [totalMatchesSum],
      })
      .expect(201);
    const testId = res.body.id as string;
    await authed(app)
      .patch(`/tests/${testId}`)
      .send({
        repairPolicy: policy,
        brief:
          "The invoice must add up: the summary total shown beside the line items equals the sum of those line items.",
      })
      .expect(200);
    return testId;
  }

  async function runToEnd(testId: string): Promise<RunView> {
    const created = await authed(app).post("/runs").send({ testId }).expect(201);
    const runId = created.body.runId as string;
    for (let i = 0; i < 300; i++) {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      const view = res.body as RunView;
      if (["passed", "needs_review", "failed", "cancelled"].includes(view.status)) return view;
      await sleep(200);
    }
    throw new Error(`run ${runId} never finished`);
  }

  async function jobsFor(testId: string): Promise<RepairJobSummary[]> {
    const res = await authed(app).get("/repair-jobs?all=1").expect(200);
    return (res.body as RepairJobSummary[]).filter((j) => j.testId === testId);
  }

  /** Leave nothing queued behind: the queue is project-wide and first-claim-wins, so a leftover
   *  job would make "which job came back" a coin toss for the next case. */
  async function emptyQueue(): Promise<void> {
    for (const job of await authed(app).get("/repair-jobs").expect(200).then((r) => r.body as RepairJobSummary[])) {
      if (job.status === "queued") await authed(app).post(`/repair-jobs/${job.id}/cancel`).expect(200);
    }
  }

  async function call(name: string, args: unknown = {}) {
    const res = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${drainer}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
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

  async function config(testId: string): Promise<TestConfigView> {
    return (await authed(app).get(`/tests/${testId}/config`).expect(200)).body as TestConfigView;
  }

  async function latestVersion(testId: string) {
    const rows = await pool.query(
      `SELECT version, definition, review_state FROM test_versions
        WHERE test_id = $1 ORDER BY version DESC LIMIT 1`,
      [testId],
    );
    return rows.rows[0] as {
      version: number;
      definition: { assertions: Array<Record<string, never>> };
      review_state: string;
    };
  }

  // ---- the two variants, and the two consequences -----------------------------------------

  it("enqueues a REPAIR job when the assertion's target no longer resolves", async () => {
    await emptyQueue();
    fixture.setVariant("totals");
    const testId = await createTest("assertion repairable", "auto");
    expect((await runToEnd(testId)).status).toBe("passed");

    // The total still adds up. The element it is read FROM moved.
    fixture.setVariant("totalsMissing");
    const red = await runToEnd(testId);
    expect(red.status).toBe("failed");
    // Recorded as what it IS: a locator failure. Not `assertion` — every consumer of this column
    // (the manual-enqueue endpoint, the breaker census, the queue) reads the distinction from here
    // rather than re-deriving it, which is how three of them would come to disagree.
    expect(red.failureKind).toBe("locator");

    const failed = red.assertions.find((a) => a.id === "total-matches-sum");
    expect(failed?.outcome).toBe("extraction-failed");
    expect(failed?.cause).toBe("unresolved");
    // Nothing was compared, so neither value is claimed to have been read.
    expect(failed?.left).toBeNull();
    expect(failed?.right).toBeNull();

    const jobs = await jobsFor(testId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("repair");
    expect(jobs[0].status).toBe("queued");
    // Keyed on the fingerprint that missed — the assertion's own target, not the failing step's
    // (there is none: every step of this run passed).
    expect(jobs[0].clusterKey).toBe("testid:total");
  }, 300_000);

  it("enqueues NO repair job when the relation is false, under an `auto` policy", async () => {
    await emptyQueue();
    fixture.setVariant("totalsWrong");
    const testId = await createTest("assertion relation false", "auto");

    const red = await runToEnd(testId);
    expect(red.status).toBe("failed");
    expect(red.failureKind).toBe("assertion");
    const failed = red.assertions.find((a) => a.id === "total-matches-sum");
    expect(failed?.outcome).toBe("relation-false");
    // Both values really were read: this is the app disagreeing with itself.
    expect(failed?.left).toBe("70.5");
    expect(failed?.right).toBe("60.5");

    const jobs = await jobsFor(testId);
    expect(jobs).toHaveLength(1);
    expect(jobs.map((j) => j.kind)).toEqual(["triage"]);
    // The line the slice exists for: no repair job, of any status, ever.
    expect(jobs.filter((j) => j.kind === "repair")).toEqual([]);
  }, 300_000);

  it("refuses a relation-false run even when a human enqueues the job by hand", async () => {
    await emptyQueue();
    fixture.setVariant("totalsWrong");
    const testId = await createTest("assertion manual refusal", "manual");
    const red = await runToEnd(testId);
    expect(red.failureKind).toBe("assertion");
    // `manual` means the worker enqueued nothing at all.
    expect(await jobsFor(testId)).toEqual([]);

    // …and the by-hand escape hatch — the one path that deliberately bypasses the circuit breaker
    // because a human asking IS the human decision — refuses this, and says why.
    const refused = await authed(app)
      .post("/repair-jobs")
      .send({ runId: red.runId })
      .expect(400);
    expect(refused.body.message).toContain("not repairable");
    expect(refused.body.message).toContain("evidence about the APP");
    expect(await jobsFor(testId)).toEqual([]);
  }, 300_000);

  it("lets a human enqueue the extraction failure by hand under a `manual` policy", async () => {
    await emptyQueue();
    fixture.setVariant("totalsMissing");
    const testId = await createTest("assertion manual enqueue", "manual");
    const red = await runToEnd(testId);
    expect(red.failureKind).toBe("locator");
    expect(await jobsFor(testId)).toEqual([]);

    const created = await authed(app).post("/repair-jobs").send({ runId: red.runId }).expect(201);
    expect((created.body as RepairJobSummary).kind).toBe("repair");
    // Idempotent, as the step-locator path is: asking twice hands back the open job.
    const again = await authed(app).post("/repair-jobs").send({ runId: red.runId }).expect(201);
    expect((again.body as RepairJobSummary).id).toBe((created.body as RepairJobSummary).id);
    expect(await jobsFor(testId)).toHaveLength(1);
  }, 300_000);

  // ---- the repair itself -------------------------------------------------------------------

  it("re-pins the assertion's extraction target into an UNREVIEWED version", async () => {
    await emptyQueue();
    fixture.setVariant("totals");
    const testId = await createTest("assertion repair round trip", "auto");
    expect((await runToEnd(testId)).status).toBe("passed");
    fixture.setVariant("totalsMissing");
    const red = await runToEnd(testId);
    const before = await config(testId);

    const claimed = (await ok("claim_repair_job")).job as ClaimedRepairJob | null;
    if (!claimed) throw new Error("expected a claimable job");
    expect(claimed.kind).toBe("repair");
    expect(claimed.testId).toBe(testId);
    // The drainer is told WHICH assertion and which side — `failingStep` is null, because every
    // step of that run passed, so without this there is nothing to find.
    expect(claimed.failingStep).toBeNull();
    expect(claimed.failingAssertion).toMatchObject({
      id: "total-matches-sum",
      outcome: "extraction-failed",
      cause: "unresolved",
      side: "left",
      repairable: true,
    });

    // read_test reports the assertion an edit is keyed off…
    const read = await ok("read_test", { testId });
    expect((read.assertions as Array<{ id: string }>).map((a) => a.id)).toEqual([
      "total-matches-sum",
    ]);

    // …and the re-pin is a locator patch on that side, merged onto the recorded fingerprint
    // exactly as a step's would be.
    const edited = await ok("edit_test", {
      testId,
      assertions: [{ id: "total-matches-sum", left: { testId: "invoice-total" } }],
    });
    expect(edited.version).toBe(before.version + 1);
    expect((edited.changes as string[]).join(" ")).toContain("re-pinned the left-hand target");

    const reported = await ok("report_repair", {
      jobId: claimed.jobId,
      summary: 'Re-pinned the total the assertion reads to data-testid="invoice-total".',
      justification:
        'The Brief requires that "the summary total shown beside the line items equals the sum of those line items". It is the same total, re-marked-up: the element in #summary that was span#total / data-testid=total is now strong#invoice-total, same position, same value — the arithmetic it reports is unchanged.',
    });
    expect(reported.reviewState).toBe("unreviewed");

    const written = await latestVersion(testId);
    expect(written.review_state).toBe("unreviewed");
    // The definition now reads the element that IS there — and the assertion kept its id, so every
    // verdict already recorded under it still belongs to the same line on the chart.
    const pinned = (await config(testId)).assertions[0];
    expect(pinned.id).toBe("total-matches-sum");
    expect(pinned.pinned?.left.target?.testId).toBe("invoice-total");
    // The rest of the bundle survived the re-pin: a repair never collapses a fingerprint to one
    // signal.
    expect(pinned.pinned?.right.as).toBe("sum-number");
    expect(pinned.pinned?.relation).toBe("eq");

    // The run that failed is STILL failed. A repair proposes; it does not recolour history.
    const after = await authed(app).get(`/runs/${red.runId}`).expect(200);
    expect((after.body as RunView).status).toBe("failed");
  }, 300_000);

  it("refuses a re-pin that has no target, no signal left, or no such assertion", async () => {
    fixture.setVariant("totals");
    // Three assertions, chosen for what each one CANNOT be re-pinned into: a literal right side, a
    // left side whose only signal is its test id, and one with no pinned form at all.
    const created = await authed(app)
      .post("/tests")
      .send({
        name: "assertion re-pin guards",
        viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        steps: [{ type: "navigate", url: fixture.url }],
        assertions: [
          {
            id: "total-is-positive",
            check: "The total is greater than zero",
            pinned: {
              kind: "relation",
              left: { target: { tag: "span", testId: "total" }, as: "number" },
              right: { literal: 0 },
              relation: "gt",
            },
          },
          { id: "someday", check: "Someday this will be checked" },
        ],
      })
      .expect(201);
    const testId = created.body.id as string;
    const version = (await config(testId)).version;

    const repin = (assertions: unknown[], baseVersion = version) =>
      authed(app).put(`/tests/${testId}/config`).send({ baseVersion, assertions });

    // A literal has no locator by construction; "re-pin it" is a category error, not an edit.
    const literal = await repin([{ id: "total-is-positive", right: { testId: "x" } }]).expect(400);
    expect(literal.body.message).toContain("literal");

    // An unpinned assertion is documentation — no run evaluates it, so there is nothing pinned to
    // move.
    const unpinned = await repin([{ id: "someday", left: { testId: "x" } }]).expect(400);
    expect(unpinned.body.message).toContain("no pinned form");

    // Clearing the last signal would write a locator that can never resolve. Refused for an
    // assertion exactly as it is for a step: a repair may only replace a broken locator with one
    // that demonstrably can match.
    const stripped = await repin([{ id: "total-is-positive", left: { testId: "" } }]).expect(400);
    expect(stripped.body.message).toContain("no signal left");

    // And an assertion this test does not declare is refused rather than silently ignored.
    await repin([{ id: "invented", left: { testId: "x" } }]).expect(400);

    // Nothing above was written: a refused patch leaves the definition where it was.
    expect((await config(testId)).version).toBe(version);
  }, 300_000);
});
