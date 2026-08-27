import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import type { RunView, TestConfigView } from "@varys/review-contract";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, mcpAuthed, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Claude pins assertions during authoring (Slice 19, slice 12).
 *
 * The authoring loop closed: an author writes a check in plain language, and the model works out
 * HOW to evaluate it — which elements, which coercions, which relation — so every later run
 * evaluates it in the worker with no model call at all.
 *
 * Driven as a deterministic JSON-RPC script against the real MCP surface, with NO live model. That
 * is the point of the seam: the tool contract is what has to hold, and a scripted drive exercises
 * every guarantee (only-the-vocabulary, real fingerprints, verified-before-stored) without anyone
 * having to trust a model to demonstrate them.
 *
 * The fixture's invoice is the whole argument for assertions: `totals` and `totalsWrong` render the
 * SAME three line items and one of them has a total that does not add up. A screenshot cannot tell
 * them apart.
 */
describe("Claude pins an assertion during authoring", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
  /** An authored test's entry URL is `{{baseUrl}}` — environment-agnostic by design — so replaying
   *  one needs an environment that supplies the fixture's origin. */
  let environmentId: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-assert-authoring-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    // A real worker, so the last test can prove that what Claude pinned is what the worker
    // evaluates — the whole claim of the slice, and not something the tool contract alone shows.
    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) => processRun({ db: consumerDb.db, storage }, runId));

    const env = await authed(app)
      .post("/environments")
      .send({ name: "invoice-fixture", baseUrl: fixture.url })
      .expect(201);
    environmentId = env.body.id as string;
  }, 180_000);

  afterAll(async () => {
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  const rpc = (method: string, params: unknown, id: number | null = 1) =>
    mcpAuthed(app).post("/mcp").send({ jsonrpc: "2.0", id, method, params });

  const callTool = async (name: string, args: unknown) => {
    const res = await rpc("tools/call", { name, arguments: args }).expect(200);
    expect(res.body.error).toBeUndefined();
    if (res.body.result.isError) {
      throw new Error(`tool ${name} failed: ${res.body.result.content?.[0]?.text}`);
    }
    return JSON.parse(res.body.result.content[0].text);
  };

  /** Call a tool EXPECTING refusal, and return the message. */
  const expectRefused = async (name: string, args: unknown): Promise<string> => {
    const res = await rpc("tools/call", { name, arguments: args }).expect(200);
    expect(res.body.result.isError).toBe(true);
    return String(res.body.result.content[0].text);
  };

  const openInvoice = async (name: string): Promise<string> => {
    const opened = await callTool("open_session", { startUrl: fixture.url, name, mode: "batch" });
    return opened.sessionId as string;
  };

  /** Ref the total and the amount column — the two things every pin below reads. */
  const refs = async (sid: string): Promise<{ total: string; amount: string; amountCount: number }> => {
    const total = await callTool("find_elements", { sessionId: sid, selector: '[data-testid="total"]' });
    const amounts = await callTool("find_elements", { sessionId: sid, selector: "#invoice .amount" });
    return {
      total: total.nodes[0].ref as string,
      amount: amounts.nodes[0].ref as string,
      amountCount: amounts.total as number,
    };
  };

  const configOf = async (testId: string): Promise<TestConfigView> =>
    (await authed(app).get(`/tests/${testId}/config`).expect(200)).body as TestConfigView;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Replay a promoted test against the fixture environment. */
  async function run(testId: string): Promise<RunView> {
    const created = await authed(app).post("/runs").send({ testId, environmentId }).expect(201);
    const runId = created.body.runId as string;
    for (let i = 0; i < 300; i++) {
      const view = (await authed(app).get(`/runs/${runId}`).expect(200)).body as RunView;
      if (["passed", "needs_review", "failed", "cancelled"].includes(view.status)) return view;
      await sleep(200);
    }
    throw new Error(`run ${runId} never finished`);
  }

  /** Promote the draft — a human act, deliberately NOT an MCP tool — then replay it. */
  async function promoteAndRun(testId: string): Promise<RunView> {
    await authed(app).post(`/drafts/${testId}/promote`).send({ tags: [] }).expect(201);
    return run(testId);
  }

  // ---- the perception gap this slice had to close ----------------------------------------

  it("refs the values an assertion reads, which `observe` never surfaces", async () => {
    fixture.setVariant("totals");
    const sid = await openInvoice("find elements");

    // The invoice has no links, buttons or headings, so a snapshot is empty of the things an
    // assertion cares about. That is not a fixture quirk: `observe` lists what you can ACT on, and
    // a total in a <span> is not one of them.
    const snapshot = await callTool("observe", { sessionId: sid });
    const observedTotals = (snapshot.nodes as Array<{ testId?: string }>).filter(
      (n) => n.testId === "total" || n.testId === "row-amount",
    );
    expect(observedTotals).toEqual([]);

    // find_elements reaches them, and reports what each one SAYS — which is how a model catches
    // that it has pointed at a right-looking wrong node before it pins to it.
    const found = await callTool("find_elements", { sessionId: sid, selector: '[data-testid="total"]' });
    expect(found.total).toBe(1);
    expect(found.nodes[0].text).toBe("$60.50");
    expect(found.nodes[0].testId).toBe("total");
    expect(found.nodes[0].ref).toMatch(/^e\d+$/);

    // For a set side, `total` is exactly the number the assertion will read.
    const amounts = await callTool("find_elements", { sessionId: sid, selector: "#invoice .amount" });
    expect(amounts.total).toBe(3);
    expect((amounts.nodes as Array<{ text: string }>).map((n) => n.text)).toEqual([
      "$10.00",
      "$20.00",
      "$30.50",
    ]);

    // A selector that matches nothing says so rather than returning a plausible empty answer.
    const none = await callTool("find_elements", { sessionId: sid, selector: ".no-such-thing" });
    expect(none.total).toBe(0);
    expect(none.note).toMatch(/Nothing matched/i);
    expect(await expectRefused("find_elements", { sessionId: sid, selector: "[[[" })).toMatch(
      /not a valid CSS selector/i,
    );

    await callTool("discard_session", { sessionId: sid, confirm: true });
  }, 120_000);

  // ---- the headline ----------------------------------------------------------------------

  it("pins a check written in plain language, verifies it live, and carries it onto the draft", async () => {
    fixture.setVariant("totals");
    const sid = await openInvoice("pinned invoice");
    const { total, amount, amountCount } = await refs(sid);
    expect(amountCount).toBe(3);

    const pinned = await callTool("pin_assertion", {
      sessionId: sid,
      id: "total-matches-sum",
      check: "The invoice total equals the sum of the line items",
      left: { ref: total, as: "number" },
      // A sum side reads a SET, which one ref cannot express — so it carries the set selector too,
      // while the ref still supplies the fingerprint and the frame.
      right: { ref: amount, as: "sum-number", selector: "#invoice .amount" },
      relation: "eq",
      tolerance: 0.01,
    });

    expect(pinned.ok).toBe(true);
    expect(pinned.assertion.mode).toBe("pinned");
    // It was EVALUATED against the page it was authored against — not merely accepted.
    expect(pinned.verdict).toBe("passed");
    expect(pinned.detail).toContain("60.5");
    // …and the author is told which elements, which coercions and which relation, in words.
    expect(pinned.proposed).toContain("number of");
    expect(pinned.proposed).toContain("sum-number of");
    expect(pinned.proposed).toContain("eq");
    expect(pinned.note).toBeNull();

    const finished = await callTool("finish_session", { sessionId: sid });
    expect(finished.assertionCount).toBe(1);
    expect(finished.pinnedAssertionCount).toBe(1);
    expect(finished.judgedAssertionCount).toBe(0);
    // A draft that declares an assertion is NOT a draft that asserts nothing, even with no
    // checkpoints — the warning must not claim otherwise.
    expect(finished.checkpointCount).toBe(0);
    expect(finished.warning).toBeNull();

    const config = await configOf(finished.testId);
    expect(config.assertions).toHaveLength(1);
    const a = config.assertions[0];
    expect(a.id).toBe("total-matches-sum");
    expect(a.mode).toBe("pinned");
    expect(a.pinned?.relation).toBe("eq");
    expect(a.pinned?.tolerance).toBe(0.01);
    expect(a.unpinnableReason).toBeNull();

    // The stored pin carries a FULL multi-signal fingerprint, not the selector that found it —
    // which is what lets the check survive a re-skin that would break the selector.
    expect(a.pinned?.left.target?.testId).toBe("total");
    expect(a.pinned?.left.target?.tag).toBe("span");
    expect(a.pinned?.left.target?.elementId).toBe("total");
    expect(a.pinned?.left.target?.selectorOverride).toBeNull();
    // …and the set side keeps its selector, because that is the only way to address a set.
    expect(a.pinned?.right.target?.testId).toBe("row-amount");
    expect(a.pinned?.right.target?.selectorOverride).toBe("#invoice .amount");
  }, 120_000);

  // ---- verified before stored ------------------------------------------------------------

  it("REFUSES a pin that cannot be evaluated, and stores nothing", async () => {
    fixture.setVariant("totals");
    const sid = await openInvoice("refused pin");
    const { total } = await refs(sid);

    // "n/a" as a number is the classic bad fit: the element resolves, the text is read, and it
    // cannot become the value the coercion asked for.
    const refused = await expectRefused("pin_assertion", {
      sessionId: sid,
      id: "label-as-number",
      check: "The word Total is greater than five",
      // The summary div's text is "Total $60.50" — `number` cannot parse it as one figure.
      left: { ref: (await callTool("find_elements", { sessionId: sid, selector: "#summary td, #invoice td:first-child" })).nodes[0].ref, as: "number" },
      right: { literal: 5 },
      relation: "gt",
    });
    expect(refused).toMatch(/does not evaluate against the page/i);
    expect(refused).toMatch(/has not been stored/i);
    // It names the honest exit rather than leaving the model to invent one.
    expect(refused).toMatch(/declare_unpinnable_assertion/);

    // Nothing outside the fixed vocabulary is accepted, ever.
    expect(
      await expectRefused("pin_assertion", {
        sessionId: sid,
        id: "invented",
        check: "x",
        left: { ref: total, as: "number" },
        right: { literal: 1 },
        relation: "approximately-equals",
      }),
    ).toMatch(/must be one of/i);
    expect(
      await expectRefused("pin_assertion", {
        sessionId: sid,
        id: "invented2",
        check: "x",
        left: { ref: total, as: "regex-match" },
        right: { literal: 1 },
        relation: "eq",
      }),
    ).toMatch(/one of text, number, sum-number, count, exists/i);

    // A hand-written selector is not a substitute for pinning to the element.
    expect(
      await expectRefused("pin_assertion", {
        sessionId: sid,
        id: "no-ref",
        check: "x",
        left: { as: "number" },
        right: { literal: 1 },
        relation: "eq",
      }),
    ).toMatch(/needs a `ref`/i);

    // A set coercion without a set selector would silently sum ONE element — a wrong answer
    // wearing a right one's clothes.
    expect(
      await expectRefused("pin_assertion", {
        sessionId: sid,
        id: "sum-no-selector",
        check: "x",
        left: { ref: total, as: "sum-number" },
        right: { literal: 1 },
        relation: "eq",
      }),
    ).toMatch(/needs a `selector`/i);

    // …and a set selector matching nothing would pin a count of zero that looks legitimate.
    expect(
      await expectRefused("pin_assertion", {
        sessionId: sid,
        id: "empty-set",
        check: "x",
        left: { ref: total, as: "count", selector: ".nothing-here" },
        right: { literal: 0 },
        relation: "eq",
      }),
    ).toMatch(/matches nothing on this page/i);

    // Every refusal above stored nothing: the draft declares no assertions at all.
    const finished = await callTool("finish_session", { sessionId: sid });
    expect(finished.assertionCount).toBe(0);
    expect((await configOf(finished.testId)).assertions).toEqual([]);
  }, 120_000);

  it("STORES a pin whose relation is false, and says so rather than hiding it", async () => {
    // The distinction that carries the slice. A pin that cannot be read is broken and is refused.
    // A pin that reads both values and finds they disagree is CORRECT — the page is wrong — and
    // refusing it would train an author to reword their check until the app agrees with it, which
    // is the exact bug assertions exist to catch.
    fixture.setVariant("totalsWrong");
    const sid = await openInvoice("false relation at authoring");
    const { total, amount } = await refs(sid);

    const pinned = await callTool("pin_assertion", {
      sessionId: sid,
      id: "total-matches-sum",
      check: "The invoice total equals the sum of the line items",
      left: { ref: total, as: "number" },
      right: { ref: amount, as: "sum-number", selector: "#invoice .amount" },
      relation: "eq",
      tolerance: 0.01,
    });

    expect(pinned.ok).toBe(true);
    expect(pinned.verdict).toBe("relation-false");
    // Both values really were read — 70.50 against 10.00 + 20.00 + 30.50.
    expect(pinned.detail).toContain("70.5");
    expect(pinned.detail).toContain("60.5");
    // …and the model is told, in as many words, not to make it pass.
    expect(pinned.note).toMatch(/finding about the application/i);
    expect(pinned.note).toMatch(/Do NOT reword the check/i);

    const finished = await callTool("finish_session", { sessionId: sid });
    expect(finished.pinnedAssertionCount).toBe(1);
    // Stored exactly as written — not loosened, not re-pinned to agree.
    const a = (await configOf(finished.testId)).assertions[0];
    expect(a.check).toBe("The invoice total equals the sum of the line items");
    expect(a.pinned?.relation).toBe("eq");
    expect(a.pinned?.tolerance).toBe(0.01);
  }, 120_000);

  // ---- the honest exit -------------------------------------------------------------------

  it("declares an unpinnable check with a reason, instead of forcing a bad fit", async () => {
    fixture.setVariant("totals");
    const sid = await openInvoice("unpinnable");
    const { total } = await refs(sid);

    const judged = await callTool("declare_unpinnable_assertion", {
      sessionId: sid,
      id: "invoice-looks-healthy",
      check: "The invoice looks like a healthy invoice and not an error page",
      reason:
        "'looks like a healthy invoice' is a judgement about the whole page, not a comparison between two values on it — there is no element pair to read.",
    });
    expect(judged.ok).toBe(true);
    expect(judged.assertion.mode).toBe("judged");
    expect(judged.verdict).toBeNull();

    // A reason is mandatory, and "I couldn't" is not one the tool will take on trust — the field
    // exists to be read by an author deciding whether to rephrase, so it must say something.
    expect(
      await expectRefused("declare_unpinnable_assertion", {
        sessionId: sid,
        id: "no-reason",
        check: "something",
        reason: "   ",
      }),
    ).toMatch(/`reason` is required/i);

    // A pinned check and a judged one coexist on one test, which is the shape slice 11 evaluates.
    await callTool("pin_assertion", {
      sessionId: sid,
      id: "total-is-positive",
      check: "The invoice total is greater than zero",
      left: { ref: total, as: "number" },
      right: { literal: 0 },
      relation: "gt",
    });

    const finished = await callTool("finish_session", { sessionId: sid });
    expect(finished.assertionCount).toBe(2);
    expect(finished.pinnedAssertionCount).toBe(1);
    expect(finished.judgedAssertionCount).toBe(1);

    const config = await configOf(finished.testId);
    const approximate = config.assertions.find((a) => a.id === "invoice-looks-healthy");
    const exact = config.assertions.find((a) => a.id === "total-is-positive");

    expect(approximate?.mode).toBe("judged");
    expect(approximate?.pinned).toBeNull();
    // The reason survives onto the test, which is what turns the editor's "Approximate" badge from
    // a verdict into something the author can act on.
    expect(approximate?.unpinnableReason).toMatch(/not a comparison between two values/i);
    expect(approximate?.pinningHelp).toContain("sum-number");

    expect(exact?.mode).toBe("pinned");
    expect(exact?.pinned?.relation).toBe("gt");
    expect(exact?.pinned?.right.literal).toBe(0);
    expect(exact?.unpinnableReason).toBeNull();
  }, 120_000);

  it("pins a UNARY relation without inventing a right-hand side", async () => {
    fixture.setVariant("totals");
    const sid = await openInvoice("unary pin");
    const { total } = await refs(sid);

    const pinned = await callTool("pin_assertion", {
      sessionId: sid,
      id: "total-is-shown",
      check: "The invoice total is shown",
      left: { ref: total, as: "text" },
      relation: "non-empty",
    });
    expect(pinned.verdict).toBe("passed");
    expect(pinned.proposed).toContain("non-empty");

    // A right-hand side must be REJECTED rather than quietly ignored — a caller that passed one
    // believes it is being compared.
    expect(
      await expectRefused("pin_assertion", {
        sessionId: sid,
        id: "unary-with-right",
        check: "x",
        left: { ref: total, as: "text" },
        right: { literal: "anything" },
        relation: "non-empty",
      }),
    ).toMatch(/reads the left-hand side only/i);

    const finished = await callTool("finish_session", { sessionId: sid });
    const a = (await configOf(finished.testId)).assertions[0];
    expect(a.pinned?.relation).toBe("non-empty");
    // The stored right side is an inert empty literal, NOT a copy of the left target. A mirrored
    // target would give slice 10's repair path a fingerprint for a side that does not exist, and it
    // would happily "re-pin" it.
    expect(a.pinned?.right.literal).toBe("");
    expect(a.pinned?.right.target).toBeNull();
  }, 120_000);

  // ---- re-pinning within a session -------------------------------------------------------

  it("lets a re-declared id CORRECT the pin rather than duplicate it", async () => {
    fixture.setVariant("totals");
    const sid = await openInvoice("re-pin");
    const { total } = await refs(sid);

    await callTool("pin_assertion", {
      sessionId: sid,
      id: "total-check",
      check: "first attempt",
      left: { ref: total, as: "number" },
      right: { literal: 0 },
      relation: "gt",
    });
    await callTool("pin_assertion", {
      sessionId: sid,
      id: "total-check",
      check: "The invoice total is at least sixty",
      left: { ref: total, as: "number" },
      right: { literal: 60 },
      relation: "gte",
    });

    const finished = await callTool("finish_session", { sessionId: sid });
    // One assertion, corrected — not two, which the definition schema would reject outright and
    // take the whole session down with it.
    expect(finished.assertionCount).toBe(1);
    const a = (await configOf(finished.testId)).assertions[0];
    expect(a.check).toBe("The invoice total is at least sixty");
    expect(a.pinned?.relation).toBe("gte");
  }, 120_000);

  // ---- the loop, closed ------------------------------------------------------------------

  it("evaluates what Claude pinned on a real run, with no model call", async () => {
    // The claim the whole slice rests on: Claude decides HOW to evaluate the check once, during
    // authoring, and every later run applies that answer in the worker without a model. Nothing
    // short of an actual replay demonstrates it — the tool contract only shows what was stored.
    fixture.setVariant("totals");
    const sid = await openInvoice("authored then replayed");
    const { total, amount } = await refs(sid);
    await callTool("pin_assertion", {
      sessionId: sid,
      id: "total-matches-sum",
      check: "The invoice total equals the sum of the line items",
      left: { ref: total, as: "number" },
      right: { ref: amount, as: "sum-number", selector: "#invoice .amount" },
      relation: "eq",
      tolerance: 0.01,
    });
    const finished = await callTool("finish_session", { sessionId: sid });

    // No judge is configured in this suite and the test declares no context checkpoint, so a green
    // run here is a run that did the arithmetic itself.
    const green = await promoteAndRun(finished.testId);
    expect(green.status).toBe("passed");
    const passed = green.assertions.find((a) => a.id === "total-matches-sum");
    expect(passed?.outcome).toBe("passed");
    expect(passed?.mode).toBe("pinned");
    // The fingerprint Claude captured resolved on replay, and both sides were really read.
    expect(passed?.left).toBe("60.5");
    expect(passed?.right).toBe("60.5");

    // …and it catches the bug it was written for: the same three rows, a total that no longer adds
    // up, on a page a screenshot would happily call healthy.
    fixture.setVariant("totalsWrong");
    const red = await run(finished.testId);
    expect(red.status).toBe("failed");
    const failed = red.assertions.find((a) => a.id === "total-matches-sum");
    expect(failed?.outcome).toBe("relation-false");
    expect(failed?.left).toBe("70.5");
    expect(failed?.right).toBe("60.5");
  }, 300_000);

  // ---- the capability boundary -----------------------------------------------------------

  it("exposes the three assertion tools to a human author", async () => {
    // The other half of the boundary — that a Repair Agent sees neither declaring tool — lives in
    // `agent-credential.e2e.spec.ts`, which already holds the agent harness and the rest of that
    // toolset's scope rules.
    const listed = await rpc("tools/list", {}).expect(200);
    const humanTools = (listed.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(humanTools).toContain("pin_assertion");
    expect(humanTools).toContain("declare_unpinnable_assertion");
    expect(humanTools).toContain("find_elements");
  }, 60_000);
});
