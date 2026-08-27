import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import type { RepairJobSummary, RunView, TestConfigView } from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Assertions (Slice 19, slice 09) — a check on a RELATIONSHIP, not on an image.
 *
 * The fixture's invoice is the whole argument for the slice: `totals` and `totalsWrong` render the
 * SAME three line items, structurally identical, and one of them has a total that does not add up.
 * A pixel diff cannot catch that (both pages look perfectly healthy), and an LLM judge would be
 * guessing. An assertion reads both sides and does arithmetic.
 *
 * No judge is configured in this suite and no checkpoint here is `context`-compared, so every
 * verdict below is produced in the worker with no model call at all — which is the property that
 * makes assertions safe to run unattended on someone's corpus.
 */
describe("An assertion checks a relationship, in the worker, with no model call", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-assertions-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    // Assertion extraction has its own (short) timeout; keep the step matcher brisk too so the
    // deliberately-unresolvable target below fails fast rather than sitting out a 30s default.
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

  // ---- helpers ---------------------------------------------------------------------------

  async function createTest(definition: object, policy?: "auto"): Promise<string> {
    const res = await authed(app).post("/tests").send(definition).expect(201);
    const testId = res.body.id as string;
    if (policy) await authed(app).patch(`/tests/${testId}`).send({ repairPolicy: policy }).expect(200);
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

  async function config(testId: string): Promise<TestConfigView> {
    return (await authed(app).get(`/tests/${testId}/config`).expect(200)).body as TestConfigView;
  }

  function assertionOf(view: RunView, id: string) {
    const found = view.assertions.find((a) => a.id === id);
    if (!found) throw new Error(`run ${view.runId} recorded no assertion "${id}"`);
    return found;
  }

  /** "The total equals the sum of the line items" — the pinned form, hand-written (slice 12 is
   *  where Claude proposes one). The sum side reads a SET, so it carries a set selector. */
  const totalMatchesSum = {
    id: "total-matches-sum",
    check: "The total equals the sum of the line items",
    pinned: {
      kind: "relation",
      left: { target: { tag: "span", testId: "total" }, as: "number" },
      right: {
        target: { tag: "td", testId: "row-amount", cssPath: "#invoice .amount" },
        as: "sum-number",
      },
      relation: "eq",
      // Money: a hundredth of a unit of slack, so float arithmetic can't manufacture a failure.
      tolerance: 0.01,
    },
  };

  const invoiceTest = (name: string, assertions: object[] = [totalMatchesSum]) => ({
    name,
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    steps: [{ type: "navigate", url: fixture.url }],
    assertions,
  });

  // ---- the headline ----------------------------------------------------------------------

  it("passes over the fixture page, then fails when the page's values are changed", async () => {
    fixture.setVariant("totals");
    const testId = await createTest(invoiceTest("assertion totals"));

    const green = await runToEnd(testId);
    expect(green.status).toBe("passed");
    expect(green.outcome).toBe("passed");
    expect(green.failureKind).toBeNull();
    const passed = assertionOf(green, "total-matches-sum");
    expect(passed.outcome).toBe("passed");
    expect(passed.cause).toBeNull();
    // Both sides were really read off the page: $60.50 against $10.00 + $20.00 + $30.50.
    expect(passed.left).toBe("60.5");
    expect(passed.right).toBe("60.5");
    // The pinned form travels with the result, so a reader can see WHAT was compared.
    expect(passed.pinned?.relation).toBe("eq");
    expect(passed.pinned?.tolerance).toBe(0.01);
    expect(passed.pinned?.left.target?.testId).toBe("total");
    expect(passed.pinned?.right.as).toBe("sum-number");

    // Same rows, a total that no longer adds up — a page a screenshot would happily call healthy.
    fixture.setVariant("totalsWrong");
    const red = await runToEnd(testId);
    // A failing assertion FAILS the run. Not a review decision, not amber.
    expect(red.status).toBe("failed");
    expect(red.outcome).toBe("failed");
    expect(red.failureKind).toBe("assertion");
    const failed = assertionOf(red, "total-matches-sum");
    // The values were BOTH read and they disagree — the app is wrong, not the test.
    expect(failed.outcome).toBe("relation-false");
    expect(failed.cause).toBeNull();
    expect(failed.left).toBe("70.5");
    expect(failed.right).toBe("60.5");
    // The reason states itself on the run, in the reviewer's own vocabulary.
    expect(red.error ?? "").toContain("The total equals the sum of the line items");
    expect(red.error ?? "").toContain("is false");
  }, 300_000);

  // ---- the distinction the slice exists for ----------------------------------------------

  it("distinguishes a locator that missed from a relation that is false", async () => {
    fixture.setVariant("totalsWrong");
    const testId = await createTest(
      invoiceTest("assertion distinction", [
        totalMatchesSum,
        {
          // Nothing on the page carries this id — the target does not resolve at all.
          id: "discount-applied",
          check: "A discount is applied",
          pinned: {
            kind: "relation",
            left: { target: { tag: "span", testId: "discount-total" }, as: "number" },
            right: { literal: 0 },
            relation: "gt",
          },
        },
      ]),
    );

    const view = await runToEnd(testId);
    expect(view.status).toBe("failed");

    const relationFalse = assertionOf(view, "total-matches-sum");
    const extractionFailed = assertionOf(view, "discount-applied");

    // Two red assertions on one run, and they are NOT the same result. One says the application
    // disagrees with itself; the other says Varys could not look. Slice 10 wires the consequence
    // off exactly this difference, so it must survive the round trip through the DB and the API.
    expect(relationFalse.outcome).toBe("relation-false");
    expect(extractionFailed.outcome).toBe("extraction-failed");
    expect(extractionFailed.cause).toBe("unresolved");
    expect(extractionFailed.left).toBeNull();
    expect(extractionFailed.right).toBeNull();
    expect(extractionFailed.detail).toContain("no fingerprint signal matched");
    // …and the run's summary says "couldn't be checked" for it, never "is false".
    expect(view.error ?? "").toContain("couldn't be checked");
  }, 300_000);

  it("treats an absent element as an ANSWER for `exists`, not as a failure to look", async () => {
    fixture.setVariant("totals");
    const testId = await createTest(
      invoiceTest("assertion exists", [
        {
          id: "no-error-banner",
          check: "No error banner is shown",
          pinned: {
            kind: "relation",
            left: { target: { tag: "div", testId: "error-banner" }, as: "exists" },
            right: { literal: "false" },
            relation: "eq",
          },
        },
      ]),
    );

    const view = await runToEnd(testId);
    expect(view.status).toBe("passed");
    const absent = assertionOf(view, "no-error-banner");
    // The banner genuinely isn't there, which is what the check wanted — a pass, with no
    // extraction failure anywhere near it.
    expect(absent.outcome).toBe("passed");
    expect(absent.cause).toBeNull();
    expect(absent.left).toBe("false");
  }, 300_000);

  // ---- identity, history and the editor -------------------------------------------------

  it("gives each assertion its own history, and the id carries it across a reworded check", async () => {
    fixture.setVariant("totals");
    const testId = await createTest(invoiceTest("assertion history"));

    const first = await runToEnd(testId);
    expect(assertionOf(first, "total-matches-sum").history).toHaveLength(1);

    // Reword the check. The id — and therefore everything already recorded under it — is untouched.
    const before = await config(testId);
    await authed(app)
      .put(`/tests/${testId}/config`)
      .send({
        baseVersion: before.version,
        assertions: [{ id: "total-matches-sum", check: "The invoice total adds up" }],
      })
      .expect(200);
    const after = await config(testId);
    expect(after.version).toBe(before.version + 1);
    expect(after.assertions.map((a) => ({ id: a.id, check: a.check }))).toEqual([
      { id: "total-matches-sum", check: "The invoice total adds up" },
    ]);
    // Re-pinning was never asked for, so the pinned form came through the rewrite intact.
    expect(after.assertions[0].pinned?.relation).toBe("eq");

    fixture.setVariant("totalsWrong");
    const second = await runToEnd(testId);
    const history = assertionOf(second, "total-matches-sum").history;
    // One line, spanning the rename: the same assertion passed and then failed.
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.outcome)).toEqual(["passed", "relation-false"]);
    expect(history[0].runId).toBe(first.runId);
    expect(history[1].runId).toBe(second.runId);
    // The check text is snapshotted per run, so the history stays honest about what it SAID.
    expect(assertionOf(first, "total-matches-sum").check).toBe(
      "The total equals the sum of the line items",
    );
    expect(assertionOf(second, "total-matches-sum").check).toBe("The invoice total adds up");
  }, 300_000);

  it("shows the pinned form in the editor, and lets an assertion be deleted", async () => {
    fixture.setVariant("totals");
    const testId = await createTest(invoiceTest("assertion editor"));

    const view = await config(testId);
    expect(view.assertions).toHaveLength(1);
    const pinned = view.assertions[0].pinned;
    // Which elements it reads, how each is coerced, and what is compared — visible without
    // reading JSON out of the definition.
    expect(pinned?.left.target?.testId).toBe("total");
    expect(pinned?.left.as).toBe("number");
    expect(pinned?.right.target?.selectorOverride).toBeNull();
    expect(pinned?.right.as).toBe("sum-number");
    expect(pinned?.relation).toBe("eq");
    expect(pinned?.right.literal).toBeNull();

    // Blank check text is refused: it is the only part of an assertion a reviewer reads.
    await authed(app)
      .put(`/tests/${testId}/config`)
      .send({
        baseVersion: view.version,
        assertions: [{ id: "total-matches-sum", check: "   " }],
      })
      .expect(400);
    // So is an edit to an assertion this test does not declare.
    await authed(app)
      .put(`/tests/${testId}/config`)
      .send({ baseVersion: view.version, assertions: [{ id: "invented", check: "x" }] })
      .expect(400);

    await authed(app)
      .put(`/tests/${testId}/config`)
      .send({
        baseVersion: view.version,
        assertions: [{ id: "total-matches-sum", remove: true }],
      })
      .expect(200);
    expect((await config(testId)).assertions).toEqual([]);

    // With nothing declared, the run evaluates nothing and reports nothing.
    fixture.setVariant("totalsWrong");
    const after = await runToEnd(testId);
    expect(after.assertions).toEqual([]);
    expect(after.status).toBe("passed");
  }, 300_000);

  // ---- the queue consequence (closes slice 08's partial criterion) -----------------------

  it("enqueues a READ-ONLY triage job for a false assertion relation", async () => {
    fixture.setVariant("totalsWrong");
    const testId = await createTest(invoiceTest("assertion triage"), "auto");

    const view = await runToEnd(testId);
    expect(view.failureKind).toBe("assertion");

    const jobs = (
      (await authed(app).get("/repair-jobs").expect(200)).body as RepairJobSummary[]
    ).filter((j) => j.testId === testId);
    expect(jobs).toHaveLength(1);
    // A false relation means the TEST is right and the APP is wrong. There is nothing here for a
    // repair to fix, so the only job it earns is one that can write a finding and nothing else.
    expect(jobs[0].kind).toBe("triage");
    expect(jobs[0].status).toBe("queued");
  }, 300_000);
});
