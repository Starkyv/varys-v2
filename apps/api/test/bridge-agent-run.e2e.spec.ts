import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type {
  AgentRunRequestState,
  BridgeChatState,
  BridgeCommand,
  BridgeHelperPresence,
  BridgePairResult,
} from "@varys/review-contract";
import type { Subscription } from "rxjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runs, type DbHandle } from "@varys/db";
import { eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { BridgeService } from "../src/authoring/bridge.service";
import {
  authed,
  authEmail,
  cookieAuthed,
  mcpToken,
  mintSession,
  mintUser,
  prepareAuth,
  type TestIdentity,
} from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";
import { mcpTool } from "./mcp-harness";

/**
 * Slice 17 — pressing Run on an Agent-Driven Test reaches your own Bridge Helper.
 *
 * Driven entirely at the relay's HTTP surface with a SIMULATED helper: it pairs like the real one
 * and holds the downward command stream, and every assertion is about what ARRIVES at it. No Agent
 * SDK, no LLM, no browser — Varys hosts none of those for this kind, and a test that stubbed one
 * would be testing the stub.
 *
 * The properties worth more than the happy path are the ones the design leans on:
 *
 *  - the command carries the test id and the environment id and NOTHING ELSE. Instructions, the
 *    Checkpoint Manifest and baselines are what `start_agent_run` returns; a second copy riding
 *    down here is a second copy that can disagree with the first.
 *  - a request that named no environment arrives carrying none, not a guessed one — `default` is
 *    resolved once, by `start_agent_run`, and never twice.
 *  - a request reaches the sender's OWN helper or nobody's. There is no chat id in the request, so
 *    addressing somebody else's is unrepresentable rather than merely forbidden.
 *  - the refusals are distinguishable, and the two that would otherwise burn a person's Claude
 *    subscription (pinned, empty Manifest) happen BEFORE anything is sent.
 *
 * Slice 18 gives that request a bounded, observable life on the same surface. Its properties are
 * the ones a press with nothing durable behind it needs:
 *
 *  - the wait ENDS. A helper that is paired and wedged produces `lapsed` inside the bound, not an
 *    indefinite outstanding request — and lapsing writes nothing, because nothing was created.
 *  - a second press while one is open is refused BY THE RELAY, so it holds across two browser
 *    sessions of the same owner rather than only within one page's disabled button.
 *  - the state is owner-scoped: one person's open request neither shows to nor blocks another.
 */
describe("Bridge relay → running an Agent-Driven Test", () => {
  let app: INestApplication;
  let db: TestDb;
  let storageDir: string;
  let bridge: BridgeService;
  let handle: DbHandle;

  /** The lapse bound for this suite. Long enough that an "outstanding" assertion is not a race;
   *  short enough that nothing here waits on a real one. */
  const REQUEST_MS = 4_000;

  const PINNED = {
    name: "pinned smoke",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    steps: [
      { type: "navigate", url: "http://fixture.local/" },
      { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
    ],
  };

  /** Pair a stand-in helper onto a fresh bridge and hold its command stream open. */
  async function pairHelper(actor: TestIdentity | null = null): Promise<{
    chatId: string;
    bridgeToken: string;
    commands: BridgeCommand[];
    stop: () => void;
  }> {
    const web = actor ? cookieAuthed(app, actor) : authed(app);
    const created = await web.post("/authoring/bridge").expect(201);
    const { chatId, pairingCode } = created.body as BridgeChatState;
    const paired = await request(app.getHttpServer())
      .post("/authoring/bridge/pair")
      .send({ code: pairingCode })
      .expect(201);
    const { bridgeToken } = paired.body as BridgePairResult;
    const commands: BridgeCommand[] = [];
    const sub: Subscription = bridge.helperCommands(bridgeToken).subscribe((c) => commands.push(c));
    return { chatId, bridgeToken, commands, stop: () => sub.unsubscribe() };
  }

  async function createAgentTest(name: string): Promise<string> {
    const res = await authed(app).post("/tests/agent").send({ name }).expect(201);
    return res.body.id as string;
  }

  async function addCheckpoint(testId: string, name: string): Promise<void> {
    await authed(app).post(`/tests/${testId}/agent-checkpoints`).send({ name }).expect(201);
  }

  beforeAll(async () => {
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-bridgerun-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;
    // The lapse bound, shrunk from two minutes to four seconds. Read per request, so the lapse
    // test can shrink it further still for its own press and put it back afterwards — the only
    // way to exercise a deadline without either waiting for it or pretending it is not there.
    process.env.VARYS_AGENT_RUN_REQUEST_MS = String(REQUEST_MS);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    bridge = moduleRef.get(BridgeService);
    handle = createDb(db.connectionString);
    await prepareAuth();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await handle?.pool.end();
    await db?.container.stop();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it("reports whether a helper is listening, and flips as one connects and drops", async () => {
    const before = await authed(app).get("/authoring/bridge/helper").expect(200);
    expect((before.body as BridgeHelperPresence).helperConnected).toBe(false);
    expect(before.body.chatId).toBeNull();

    const helper = await pairHelper();
    const during = await authed(app).get("/authoring/bridge/helper").expect(200);
    expect(during.body).toMatchObject({ helperConnected: true, chatId: helper.chatId });

    helper.stop();
    const after = await authed(app).get("/authoring/bridge/helper").expect(200);
    expect(after.body).toMatchObject({ helperConnected: false, chatId: null });
  });

  it("sends the test id and the chosen environment id down to the paired helper, and nothing else", async () => {
    const helper = await pairHelper();
    const testId = await createAgentTest("checkout journey");
    await addCheckpoint(testId, "basket");
    const env = await authed(app)
      .post("/environments")
      .send({ name: "staging", baseUrl: "https://staging.example.com" })
      .expect(201);

    const res = await authed(app)
      .post("/authoring/bridge/run-agent-test")
      .send({ testId, environmentId: env.body.id })
      .expect(201);
    expect(res.body.chatId).toBe(helper.chatId);

    // Exact equality, not a subset match: the absence of instructions, Manifest and baselines is
    // the assertion. A `toMatchObject` here would pass with all three smuggled alongside.
    expect(helper.commands).toEqual([
      { type: "run-agent-test", testId, environmentId: env.body.id },
    ]);

    helper.stop();
  });

  it("carries no environment when none was named, rather than guessing one", async () => {
    const helper = await pairHelper();
    const testId = await createAgentTest("env-less journey");
    await addCheckpoint(testId, "home");

    await authed(app).post("/authoring/bridge/run-agent-test").send({ testId }).expect(201);

    expect(helper.commands).toEqual([{ type: "run-agent-test", testId, environmentId: null }]);
    helper.stop();
  });

  it("refuses a pinned test, an empty Checkpoint Manifest and an unknown test — before anything is sent", async () => {
    const helper = await pairHelper();

    const pinned = await authed(app).post("/tests").send(PINNED).expect(201);
    const refusedPinned = await authed(app)
      .post("/authoring/bridge/run-agent-test")
      .send({ testId: pinned.body.id })
      .expect(400);
    expect(refusedPinned.body.message).toMatch(/pinned test/i);

    const empty = await createAgentTest("nothing to reach");
    const refusedEmpty = await authed(app)
      .post("/authoring/bridge/run-agent-test")
      .send({ testId: empty })
      .expect(400);
    expect(refusedEmpty.body.message).toMatch(/no checkpoints/i);

    await authed(app)
      .post("/authoring/bridge/run-agent-test")
      .send({ testId: "00000000-0000-4000-8000-000000000000" })
      .expect(404);

    // The helper was listening throughout and heard none of it.
    expect(helper.commands).toEqual([]);
    helper.stop();
  });

  it("refuses a run request when no helper is paired, distinguishably from the other refusals", async () => {
    const testId = await createAgentTest("nobody home");
    await addCheckpoint(testId, "home");

    const refused = await authed(app)
      .post("/authoring/bridge/run-agent-test")
      .send({ testId })
      .expect(409);
    expect(refused.body.message).toMatch(/no bridge helper is paired/i);
  });

  it("refuses an unauthenticated request, and never reaches another user's helper", async () => {
    const helper = await pairHelper();
    const testId = await createAgentTest("someone else's");
    await addCheckpoint(testId, "home");

    // No session cookie at all.
    await request(app.getHttpServer())
      .post("/authoring/bridge/run-agent-test")
      .send({ testId })
      .expect(401);
    await request(app.getHttpServer()).get("/authoring/bridge/helper").expect(401);
    await request(app.getHttpServer()).get(`/authoring/bridge/run-request/${testId}`).expect(401);

    // A different signed-in person, with no helper of their own. There is no field in which to
    // name someone else's, so this is refused as "none paired" and the owner's helper hears
    // nothing — the isolation is structural, not a check that could be forgotten.
    const other = await mintUser("E2E other");
    const presence = await cookieAuthed(app, other).get("/authoring/bridge/helper").expect(200);
    expect(presence.body).toMatchObject({ helperConnected: false, chatId: null });
    await cookieAuthed(app, other)
      .post("/authoring/bridge/run-agent-test")
      .send({ testId })
      .expect(409);

    expect(helper.commands).toEqual([]);
    helper.stop();
  });

  describe("the request's bounded life", () => {
    /** Poll the request's state until it reads `phase`, or give up. Polling, not sleeping: the
     *  lapse is derived from a deadline, and what matters is that a reader eventually sees it. */
    async function until(
      testId: string,
      phase: AgentRunRequestState["phase"],
      budgetMs = 5_000,
    ): Promise<AgentRunRequestState> {
      const deadline = Date.now() + budgetMs;
      let last: AgentRunRequestState = { testId, phase: "none", requestedAt: null, lapsesAt: null, acknowledgedAt: null, runId: null };
      while (Date.now() < deadline) {
        const res = await authed(app).get(`/authoring/bridge/run-request/${testId}`).expect(200);
        last = res.body as AgentRunRequestState;
        if (last.phase === phase) return last;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`request for ${testId} never reached "${phase}" (last was "${last.phase}")`);
    }

    it("is none before a press, outstanding after one, and acknowledged when the helper says it launched Claude", async () => {
      const helper = await pairHelper();
      const testId = await createAgentTest("acknowledged journey");
      await addCheckpoint(testId, "home");

      const before = await authed(app).get(`/authoring/bridge/run-request/${testId}`).expect(200);
      expect(before.body).toMatchObject({ testId, phase: "none", requestedAt: null, runId: null });

      const pressed = await authed(app)
        .post("/authoring/bridge/run-agent-test")
        .send({ testId })
        .expect(201);
      const opened = pressed.body.request as AgentRunRequestState;
      expect(opened.phase).toBe("outstanding");
      expect(opened.acknowledgedAt).toBeNull();
      // The bound is reported with the request, so the wait has a visible end from the instant it
      // begins rather than only once it has already expired.
      expect(opened.lapsesAt).toBeGreaterThan(opened.requestedAt ?? 0);

      await request(app.getHttpServer())
        .post("/authoring/bridge/helper/events")
        .set("x-bridge-token", helper.bridgeToken)
        .send({ events: [{ type: "agent-run-launched", testId }] })
        .expect(201);

      const acked = await until(testId, "acknowledged");
      expect(acked.acknowledgedAt).toBeGreaterThanOrEqual(acked.requestedAt ?? 0);
      // Still no Run: the helper claimed to have launched Claude, which is a statement about the
      // helper and not about Varys. Only `start_agent_run` can say a Run exists.
      expect(acked.runId).toBeNull();
      const runs = await authed(app).get(`/runs?testId=${testId}`).expect(200);
      expect(runs.body).toEqual([]);

      helper.stop();
    });

    it("is fulfilled by the Run that start_agent_run creates, and names it", async () => {
      const helper = await pairHelper();
      const testId = await createAgentTest("fulfilled journey");
      await addCheckpoint(testId, "home");

      await authed(app).post("/authoring/bridge/run-agent-test").send({ testId }).expect(201);

      // The real thing the helper's Claude would call — same tool, same principal, same surface.
      const session = await mcpTool<{ runId: string }>(app, mcpToken(), "start_agent_run", {
        testId,
      });

      const done = await until(testId, "fulfilled");
      expect(done.runId).toBe(session.runId);
      // Nothing to count down to any more.
      expect(done.lapsesAt).toBeNull();

      // And the request is closed: pressing again is allowed, because nothing is open.
      await authed(app).post("/authoring/bridge/run-agent-test").send({ testId }).expect(201);

      helper.stop();
    });

    it("lapses inside its bound rather than staying outstanding, and leaves nothing behind", async () => {
      process.env.VARYS_AGENT_RUN_REQUEST_MS = "250";
      try {
        const helper = await pairHelper();
        const testId = await createAgentTest("wedged helper");
        await addCheckpoint(testId, "home");

        // The helper is paired and holding the stream — it simply never answers. This is exactly
        // the case that is indistinguishable from a slow one without a bound.
        const pressed = await authed(app)
          .post("/authoring/bridge/run-agent-test")
          .send({ testId })
          .expect(201);
        expect(pressed.body.request.phase).toBe("outstanding");
        expect(helper.commands).toEqual([{ type: "run-agent-test", testId, environmentId: null }]);

        const lapsed = await until(testId, "lapsed", 3_000);
        // Never acknowledged — which is what tells the author their helper was asked and did not
        // answer, rather than that Claude started and produced nothing.
        expect(lapsed.acknowledgedAt).toBeNull();
        expect(lapsed.runId).toBeNull();

        // Nothing durable was written at any point in its life, including the lapse.
        const runs = await authed(app).get(`/runs?testId=${testId}`).expect(200);
        expect(runs.body).toEqual([]);

        // And the button is not bricked: a lapsed request blocks nothing.
        await authed(app).post("/authoring/bridge/run-agent-test").send({ testId }).expect(201);
        helper.stop();
      } finally {
        process.env.VARYS_AGENT_RUN_REQUEST_MS = String(REQUEST_MS);
      }
    });

    it("keeps a lapse final — a session that starts afterwards does not reopen it", async () => {
      process.env.VARYS_AGENT_RUN_REQUEST_MS = "250";
      let testId = "";
      try {
        const helper = await pairHelper();
        testId = await createAgentTest("late but not forgiven");
        await addCheckpoint(testId, "home");
        await authed(app).post("/authoring/bridge/run-agent-test").send({ testId }).expect(201);
        await until(testId, "lapsed", 3_000);
        helper.stop();
      } finally {
        process.env.VARYS_AGENT_RUN_REQUEST_MS = String(REQUEST_MS);
      }

      // The helper WAS listening after all, just far too slowly. The Run is real and belongs in
      // Runs — but the request Varys already reported as lapsed does not un-lapse, or the author
      // would be told two different things about the same press.
      const session = await mcpTool<{ runId: string }>(app, mcpToken(), "start_agent_run", {
        testId,
      });
      const after = await authed(app).get(`/authoring/bridge/run-request/${testId}`).expect(200);
      expect(after.body).toMatchObject({ phase: "lapsed", runId: null });

      const runs = await authed(app).get(`/runs?testId=${testId}`).expect(200);
      expect(runs.body).toHaveLength(1);
      expect(runs.body[0].runId).toBe(session.runId);
    });

    it("refuses a second press while one is open, from a different browser session of the same owner", async () => {
      const helper = await pairHelper();
      const testId = await createAgentTest("one at a time");
      await addCheckpoint(testId, "home");

      await authed(app).post("/authoring/bridge/run-agent-test").send({ testId }).expect(201);

      // A SECOND session for the same person — a second browser, or a second tab that reloaded.
      // Its page has never seen the first press and its button is not disabled, which is exactly
      // why the rule cannot live in the page.
      const secondTab = cookieAuthed(app, { cookie: await mintSession(authEmail()) });
      const refused = await secondTab
        .post("/authoring/bridge/run-agent-test")
        .send({ testId })
        .expect(409);
      expect(refused.body.message).toMatch(/already asked/i);

      // The second tab sees the first tab's request, rather than an empty one of its own.
      const seen = await secondTab.get(`/authoring/bridge/run-request/${testId}`).expect(200);
      expect(seen.body.phase).toBe("outstanding");

      // One command reached the helper, not two. The refusal is the whole point of this test and
      // the count is the only thing that proves it happened before the send.
      expect(helper.commands).toEqual([{ type: "run-agent-test", testId, environmentId: null }]);
      helper.stop();
    });

    it("keeps one owner's open request invisible to, and non-blocking for, another", async () => {
      const mine = await pairHelper();
      const testId = await createAgentTest("shared test, separate requests");
      await addCheckpoint(testId, "home");
      await authed(app).post("/authoring/bridge/run-agent-test").send({ testId }).expect(201);

      const other = await mintUser("E2E second owner");
      const theirs = await pairHelper(other);

      // Same test, different owner: no request on record, so nothing of mine is visible to them.
      const seen = await cookieAuthed(app, other)
        .get(`/authoring/bridge/run-request/${testId}`)
        .expect(200);
      expect(seen.body).toMatchObject({ testId, phase: "none", requestedAt: null });

      // And nothing of mine blocks them: their press is accepted and reaches THEIR helper.
      await cookieAuthed(app, other)
        .post("/authoring/bridge/run-agent-test")
        .send({ testId })
        .expect(201);
      expect(theirs.commands).toEqual([{ type: "run-agent-test", testId, environmentId: null }]);
      expect(mine.commands).toEqual([{ type: "run-agent-test", testId, environmentId: null }]);

      theirs.stop();
      mine.stop();
    });
  });

  /**
   * Issue #15 — a Run started from the web app says so.
   *
   * Two doors now reach the same Agent Run Session: pressing Run here, or typing to your own
   * Claude. The Runs they produce are otherwise identical, which is the point — so the only thing
   * asserted here is the marker, and the absence of any other difference between the two.
   *
   * The marker is read off Varys' own record of the press. `start_agent_run` is called identically
   * in both cases below and carries nothing that says how it was summoned, which is exactly why a
   * stamp cannot be forged by an agent claiming it came from the web app.
   */
  describe("which door the Run came through", () => {
    /** The Run as a person would later open it. */
    async function readRun(runId: string): Promise<Record<string, unknown>> {
      const res = await authed(app).get(`/runs/${runId}`).expect(200);
      return res.body as Record<string, unknown>;
    }

    it("marks a Run that answered a press, and leaves one started by asking Claude directly alone", async () => {
      const helper = await pairHelper();

      // Door one: the button. Press, then the helper's Claude reaches `start_agent_run`.
      const requested = await createAgentTest("pressed the button");
      await addCheckpoint(requested, "home");
      await authed(app).post("/authoring/bridge/run-agent-test").send({ testId: requested }).expect(201);
      const fromVarys = await mcpTool<{ runId: string }>(app, mcpToken(), "start_agent_run", {
        testId: requested,
      });

      // Door two: no press at all — the same person, the same tool, on a different test. The
      // helper is still paired throughout, so pairing is not what distinguishes the two.
      const typed = await createAgentTest("typed it myself");
      await addCheckpoint(typed, "home");
      const byHand = await mcpTool<{ runId: string }>(app, mcpToken(), "start_agent_run", {
        testId: typed,
      });

      expect((await readRun(fromVarys.runId)).triggerSource).toBe("varys");
      // Not merely "not varys": unchanged from what this path recorded before the marker existed.
      expect((await readRun(byHand.runId)).triggerSource).toBe("manual");

      // And the marker is on the run a reader browses to, not only on the one they opened.
      const listed = await authed(app).get(`/runs?testId=${requested}`).expect(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]).toMatchObject({ runId: fromVarys.runId, triggerSource: "varys" });

      helper.stop();
    });

    it("changes nothing about the Run but the marker", async () => {
      const helper = await pairHelper();
      const requested = await createAgentTest("marked but identical");
      await addCheckpoint(requested, "basket");
      await addCheckpoint(requested, "checkout");
      const typed = await createAgentTest("unmarked and identical");
      await addCheckpoint(typed, "basket");
      await addCheckpoint(typed, "checkout");

      await authed(app).post("/authoring/bridge/run-agent-test").send({ testId: requested }).expect(201);
      const marked = await mcpTool<{
        runId: string;
        leaseSeconds: number;
        manifest: { name: string }[];
      }>(app, mcpToken(), "start_agent_run", { testId: requested });
      const unmarked = await mcpTool<{
        runId: string;
        leaseSeconds: number;
        manifest: { name: string }[];
      }>(app, mcpToken(), "start_agent_run", { testId: typed });

      // The Wall-Clock Lease is stamped by `start_agent_run` and the marker is written after it —
      // a press must not buy, or cost, a single second.
      expect(marked.leaseSeconds).toBe(unmarked.leaseSeconds);
      expect(marked.manifest.map((m) => m.name)).toEqual(unmarked.manifest.map((m) => m.name));

      const a = await readRun(marked.runId);
      const b = await readRun(unmarked.runId);
      expect(a.triggerSource).toBe("varys");
      expect(b.triggerSource).toBe("manual");

      // Pre-seeded red, the closed Manifest, and the review state every slot starts in: the
      // guarantees a reviewer leans on, asserted to be the same on both sides of the marker.
      for (const key of ["status", "outcome", "failureKind", "error", "kind", "agentSummary"]) {
        expect([key, a[key]]).toEqual([key, b[key]]);
      }
      const states = (run: Record<string, unknown>) =>
        (run.checkpoints as { name: string; reviewState: string }[]).map((c) => [
          c.name,
          c.reviewState,
        ]);
      expect(states(a)).toEqual(states(b));
      // Nothing is approved on either, and the marker gives neither a head start.
      expect(states(a).every(([, state]) => state === "missing")).toBe(true);
      expect((a.session as { status: string } | null)?.status).toBe(
        (b.session as { status: string } | null)?.status,
      );

      helper.stop();
    });

    it("reads a Run recorded before the marker existed as 'not known to have come from Varys'", async () => {
      const testId = await createAgentTest("from the archives");
      await addCheckpoint(testId, "home");
      const session = await mcpTool<{ runId: string }>(app, mcpToken(), "start_agent_run", {
        testId,
      });
      // What every run looks like that predates attribution being recorded at all. Arranged
      // directly because there is no longer any code path that produces one.
      await handle.db
        .update(runs)
        .set({ triggerSource: null, triggeredBy: null })
        .where(eq(runs.id, session.runId));

      const view = await readRun(session.runId);
      expect(view).toMatchObject({ runId: session.runId, triggerSource: null, triggeredBy: null });
      const listed = await authed(app).get(`/runs?testId=${testId}`).expect(200);
      expect(listed.body[0]).toMatchObject({ triggerSource: null, triggeredBy: null });
    });
  });

  it("still relays a chat prompt down and an event up", async () => {
    const created = await authed(app).post("/authoring/bridge").expect(201);
    const { chatId, pairingCode } = created.body as BridgeChatState;
    const paired = await request(app.getHttpServer())
      .post("/authoring/bridge/pair")
      .send({ code: pairingCode })
      .expect(201);
    const { bridgeToken } = paired.body as BridgePairResult;

    const commands: BridgeCommand[] = [];
    const sub = bridge.helperCommands(bridgeToken).subscribe((c) => commands.push(c));

    await authed(app)
      .post(`/authoring/bridge/${chatId}/prompt`)
      .send({ text: "write me a test" })
      .expect(201);
    expect(commands).toContainEqual({ type: "prompt", text: "write me a test" });

    await request(app.getHttpServer())
      .post("/authoring/bridge/helper/events")
      .set("x-bridge-token", bridgeToken)
      .send({ events: [{ type: "assistant", text: "On it." }] })
      .expect(201);

    sub.unsubscribe();
  });
});
