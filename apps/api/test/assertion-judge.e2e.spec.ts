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
import type { RepairJobSummary, RunView, TestConfigView } from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The judge fallback for unpinnable assertions (Slice 19, slice 11).
 *
 * Not every check reduces to two extractions and a relation. "The chart looks reasonable" cannot be
 * pinned, and the honest answer is to judge it rather than to pretend — so an assertion with no
 * pinned form falls back to the existing `JudgeProvider`, and every surface says out loud that the
 * verdict is approximate.
 *
 * The judge here is a FAKE, scripted per test, including its throw path. That is not a shortcut: it
 * is the property the seam exists for. The one behaviour a real model could never be relied on to
 * demonstrate is the one that matters most — a transport error must mark the run needs-review and
 * never a pass, because a model outage that reads as green is a corpus that silently stops
 * verifying anything.
 */
describe("An unpinnable assertion is judged, and a judge that cannot answer is never a pass", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;

  /**
   * What the fake judge does on the NEXT run, and what it was asked. Mutable module state rather
   * than a per-run injection because the worker is started once for the suite — each test sets the
   * script it needs before triggering its run.
   */
  let script: ((input: JudgeInput) => JudgeResult) | null = null;
  let asked: JudgeInput[] = [];

  const fakeJudge: JudgeProvider = {
    async judge(input: JudgeInput): Promise<JudgeResult> {
      asked.push(input);
      if (!script) throw new Error("no script set for this run");
      return script(input);
    },
  };

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-assertion-judge-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    process.env.VARYS_ACTION_TIMEOUT_MS = "1500";

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) =>
      // `judge: undefined` is a real configuration — a deployment with no judge set — and the
      // "unconfigured" test below exercises exactly that branch.
      processRun({ db: consumerDb.db, storage, judge: script ? fakeJudge : undefined }, runId),
    );
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

  beforeEach(() => {
    asked = [];
    script = null;
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

  function assertionOf(view: RunView, id: string) {
    const found = view.assertions.find((a) => a.id === id);
    if (!found) throw new Error(`run ${view.runId} recorded no assertion "${id}"`);
    return found;
  }

  async function jobsFor(testId: string): Promise<RepairJobSummary[]> {
    const body = (await authed(app).get("/repair-jobs").expect(200)).body as RepairJobSummary[];
    return body.filter((j) => j.testId === testId);
  }

  /** The qualitative check the whole slice exists for: real, worth asserting, and unpinnable. */
  const chartLooksRight = {
    id: "chart-looks-right",
    check: "The invoice looks like a healthy invoice and not an error page",
  };

  /** The exact one, for the mixed test — the same pinned form slice 09 established. */
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
      tolerance: 0.01,
    },
  };

  const judgedTest = (name: string, assertions: object[] = [chartLooksRight]) => ({
    name,
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    steps: [{ type: "navigate", url: fixture.url }],
    assertions,
  });

  // ---- the headline ----------------------------------------------------------------------

  it("evaluates an assertion with no pinned form through the judge, and marks it approximate", async () => {
    fixture.setVariant("totals");
    script = () => ({ verdict: "pass", reasoning: "line items, a total and no error banner" });
    const testId = await createTest(judgedTest("judged assertion pass"));

    const view = await runToEnd(testId);
    expect(view.status).toBe("passed");
    expect(view.failureKind).toBeNull();

    // The judge really was asked, and asked about the author's own sentence — not a paraphrase, and
    // not a screenshot comparison: there is no baseline here to compare against.
    expect(asked).toHaveLength(1);
    expect(asked[0].prompt).toContain(chartLooksRight.check);
    expect(asked[0].baseline).toBeUndefined();
    expect(asked[0].current).toBeInstanceOf(Buffer);

    const judged = assertionOf(view, "chart-looks-right");
    expect(judged.outcome).toBe("passed");
    // The property the author-facing half rests on: a judged pass is never mistakable for an exact
    // one, at any surface, however green the run looks.
    expect(judged.mode).toBe("judged");
    expect(judged.pinned).toBeNull();
    expect(judged.reasoning).toBe("line items, a total and no error banner");
    // Nothing was extracted, so there are no values pretending to have been compared.
    expect(judged.left).toBeNull();
    expect(judged.right).toBeNull();
    // …and it has its own history, keyed off the same stable id a pinned one uses.
    expect(judged.history).toHaveLength(1);
  }, 300_000);

  it("fails the run on a judged FAIL, and refuses every repair for it", async () => {
    fixture.setVariant("totals");
    script = () => ({ verdict: "fail", reasoning: "the page is showing an error state" });
    const testId = await createTest(judgedTest("judged assertion fail"), "auto");

    const view = await runToEnd(testId);
    // A failing assertion fails the run — whichever machinery reached the verdict. An approximate
    // check is still a check.
    expect(view.status).toBe("failed");
    expect(view.outcome).toBe("failed");
    expect(view.failureKind).toBe("assertion");
    expect(view.error ?? "").toContain(chartLooksRight.check);
    expect(view.error ?? "").toContain("was judged false");

    const judged = assertionOf(view, "chart-looks-right");
    expect(judged.outcome).toBe("judge-failed");
    expect(judged.mode).toBe("judged");
    expect(judged.reasoning).toBe("the page is showing an error state");

    // The consequence: a READ-ONLY triage job, never a repair. A judged fail is (approximate)
    // evidence about the app, and re-pinning until a model agrees hides the same class of bug
    // re-pinning until numbers agree does.
    const jobs = await jobsFor(testId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("triage");
  }, 300_000);

  it("refuses a judged failure to a human asking for a repair by hand", async () => {
    // The by-hand escape hatch deliberately bypasses the circuit breaker, because a human asking IS
    // the human decision. It does NOT bypass this: the refusal is a property of the failure, not of
    // who is asking, and it comes back in the engine's own words rather than a generic 400.
    fixture.setVariant("totals");
    script = () => ({ verdict: "fail", reasoning: "the page is showing an error state" });
    const testId = await createTest(judgedTest("judged manual refusal", [chartLooksRight]), undefined);

    const view = await runToEnd(testId);
    expect(view.status).toBe("failed");
    // `manual` (the default) means the worker enqueued nothing at all.
    expect(await jobsFor(testId)).toEqual([]);

    const refused = await authed(app)
      .post("/repair-jobs")
      .send({ runId: view.runId })
      .expect(400);
    expect(String(refused.body.message)).toContain("not repairable");
    expect(String(refused.body.message)).toContain(chartLooksRight.check);
    expect(String(refused.body.message)).toContain("a model read the page");
    expect(await jobsFor(testId)).toEqual([]);
  }, 300_000);

  // ---- the property a real model could never demonstrate ---------------------------------

  it("marks the run NEEDS-REVIEW when the judge transport throws — never a pass", async () => {
    fixture.setVariant("totals");
    script = () => {
      throw new Error("429 rate limited by the model provider");
    };
    const testId = await createTest(judgedTest("judged assertion outage"), "auto");

    const view = await runToEnd(testId);
    // Not green: nothing was checked, and a run that went green here would be asserting something
    // nobody verified. Not red either: no finding was reached, so there is no bug to report.
    expect(view.status).toBe("needs_review");
    expect(view.status).not.toBe("passed");
    expect(view.failureKind).toBeNull();

    const judged = assertionOf(view, "chart-looks-right");
    expect(judged.outcome).toBe("judge-unavailable");
    expect(judged.mode).toBe("judged");
    expect(judged.detail).toContain("429 rate limited");
    expect(judged.reasoning).toBeNull();

    // And no job of either kind: there is nothing to repair and nothing to diagnose. Filing one
    // would be a bug report about an application nobody looked at.
    expect(await jobsFor(testId)).toEqual([]);
  }, 300_000);

  it("says the same thing when no judge is configured at all", async () => {
    fixture.setVariant("totals");
    script = null; // ⇒ processRun is handed `judge: undefined`
    const testId = await createTest(judgedTest("judged assertion unconfigured"));

    const view = await runToEnd(testId);
    expect(view.status).toBe("needs_review");
    const judged = assertionOf(view, "chart-looks-right");
    expect(judged.outcome).toBe("judge-unavailable");
    // The message names the fix, so a reader is not left guessing why their check never ran.
    expect(judged.detail).toContain("no judge provider is configured");
    expect(asked).toEqual([]);
  }, 300_000);

  // ---- the two kinds coexist -------------------------------------------------------------

  it("runs a pinned and a judged assertion on one test, and lets either fail the run", async () => {
    // The pinned one passes and the judged one fails: the run is red because of the approximate
    // check, which is the half of the claim that is easy to get wrong.
    fixture.setVariant("totals");
    script = () => ({ verdict: "fail", reasoning: "the header is missing" });
    const testId = await createTest(
      judgedTest("judged and pinned", [totalMatchesSum, chartLooksRight]),
    );

    const judgedRed = await runToEnd(testId);
    expect(judgedRed.status).toBe("failed");
    expect(assertionOf(judgedRed, "total-matches-sum").outcome).toBe("passed");
    expect(assertionOf(judgedRed, "total-matches-sum").mode).toBe("pinned");
    expect(assertionOf(judgedRed, "chart-looks-right").outcome).toBe("judge-failed");
    expect(judgedRed.error ?? "").toContain(chartLooksRight.check);
    expect(judgedRed.error ?? "").not.toContain(totalMatchesSum.check);

    // Now the other way round: the judged one passes and the pinned one is false. Same test, same
    // run, and the exact check is the one that makes it red.
    fixture.setVariant("totalsWrong");
    script = () => ({ verdict: "pass", reasoning: "looks like an ordinary invoice" });
    const pinnedRed = await runToEnd(testId);
    expect(pinnedRed.status).toBe("failed");
    expect(assertionOf(pinnedRed, "chart-looks-right").outcome).toBe("passed");
    expect(assertionOf(pinnedRed, "chart-looks-right").mode).toBe("judged");
    expect(assertionOf(pinnedRed, "total-matches-sum").outcome).toBe("relation-false");
    expect(pinnedRed.error ?? "").toContain(totalMatchesSum.check);

    // One judge call per RUN — one for each of the two runs above, and not a second one for the
    // pinned assertion sharing the test with it.
    expect(asked).toHaveLength(2);
  }, 300_000);

  it("costs no model call at all when every assertion is pinned", async () => {
    // The property that makes assertions cheap enough to run nightly across a corpus: the fallback
    // is a fallback, and a fully-pinned test must never reach for it (nor for the screenshot it
    // would need).
    fixture.setVariant("totals");
    script = () => ({ verdict: "pass", reasoning: "should never be asked" });
    const testId = await createTest(judgedTest("all pinned", [totalMatchesSum]));

    const view = await runToEnd(testId);
    expect(view.status).toBe("passed");
    expect(assertionOf(view, "total-matches-sum").mode).toBe("pinned");
    expect(asked).toEqual([]);
  }, 300_000);

  // ---- the author-facing half ------------------------------------------------------------

  it("tells the author in the editor which checks are exact and which are approximate", async () => {
    fixture.setVariant("totals");
    const testId = await createTest(
      judgedTest("judged editor", [totalMatchesSum, chartLooksRight]),
    );

    const view = (await authed(app).get(`/tests/${testId}/config`).expect(200))
      .body as TestConfigView;
    const exact = view.assertions.find((a) => a.id === "total-matches-sum");
    const approximate = view.assertions.find((a) => a.id === "chart-looks-right");

    expect(exact?.mode).toBe("pinned");
    expect(exact?.pinned?.relation).toBe("eq");
    // Nothing to rephrase — it is already exact.
    expect(exact?.pinningHelp).toBeNull();

    expect(approximate?.mode).toBe("judged");
    expect(approximate?.pinned).toBeNull();
    // …and the approximate one carries enough to rephrase it: the actual vocabulary a pinned check
    // is built from, so "this is only approximate" comes with a route out.
    const help = approximate?.pinningHelp ?? "";
    expect(help).toContain("sum-number");
    expect(help).toContain("non-empty");
    expect(help).toContain("tolerance");
  }, 300_000);
});
