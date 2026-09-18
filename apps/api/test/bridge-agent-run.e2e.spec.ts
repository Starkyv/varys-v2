import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type {
  BridgeChatState,
  BridgeCommand,
  BridgeHelperPresence,
  BridgePairResult,
} from "@varys/review-contract";
import type { Subscription } from "rxjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { BridgeService } from "../src/authoring/bridge.service";
import { authed, cookieAuthed, mintUser, prepareAuth, type TestIdentity } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

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
 */
describe("Bridge relay → running an Agent-Driven Test", () => {
  let app: INestApplication;
  let db: TestDb;
  let storageDir: string;
  let bridge: BridgeService;

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
    return { chatId, commands, stop: () => sub.unsubscribe() };
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    bridge = moduleRef.get(BridgeService);
    await prepareAuth();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
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
