import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { BridgeChatState, BridgeCommand, BridgeEvent, BridgePairResult } from "@varys/review-contract";
import type { Subscription } from "rxjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { BridgeService } from "../src/authoring/bridge.service";
import { authed, authUserId, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 15 (Issue 02) — the Bridge relay pipe. Drives both sides over HTTP with a SIMULATED
 * helper (no Agent SDK, no LLM): the web user creates a bridge, the helper claims the pairing
 * code, a prompt flows down to the helper, an event flows up to the web, and a `session` event
 * correlates the Authoring Session. Streams are observed in-process via the service's Observables
 * (SSE itself never terminates, so it isn't asserted over supertest — same approach as the
 * live-frame test). Also asserts the auth split.
 */
describe("Authoring → Bridge relay", () => {
  let app: INestApplication;
  let db: TestDb;
  let storageDir: string;
  let bridge: BridgeService;

  beforeAll(async () => {
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-"));
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

  it("pairs a helper, relays a prompt down and an event up, and correlates the session", async () => {
    // Web (authenticated) creates a bridge → gets a one-time pairing code.
    const created = await authed(app).post("/authoring/bridge").expect(201);
    const { chatId, pairingCode } = created.body as BridgeChatState;
    expect(typeof chatId).toBe("string");
    expect(typeof pairingCode).toBe("string");
    expect(created.body.helperConnected).toBe(false);

    // The helper (no cookie) claims the code → gets a chat-scoped bridge token.
    const paired = await request(app.getHttpServer())
      .post("/authoring/bridge/pair")
      .send({ code: pairingCode })
      .expect(201);
    const { bridgeToken } = paired.body as BridgePairResult;
    expect(paired.body.chatId).toBe(chatId);
    expect(typeof bridgeToken).toBe("string");

    // Observe both streams in-process (subscribing the helper side marks it connected).
    const cmds: BridgeCommand[] = [];
    const sub1: Subscription = bridge.helperCommands(bridgeToken).subscribe((c) => cmds.push(c));
    const web: BridgeEvent[] = [];
    const sub2: Subscription = bridge.webEvents(chatId, authUserId()).subscribe((e) => web.push(e));

    // Prompt down: web → helper.
    await authed(app)
      .post(`/authoring/bridge/${chatId}/prompt`)
      .send({ text: "go to the dashboard" })
      .expect(201);
    expect(cmds).toContainEqual({ type: "prompt", text: "go to the dashboard" });

    // Events up: helper → web, including a `session` correlation.
    await request(app.getHttpServer())
      .post("/authoring/bridge/helper/events")
      .set("x-bridge-token", bridgeToken)
      .send({
        events: [
          { type: "assistant", text: "On it." },
          { type: "session", sessionId: "sess-123" },
        ],
      })
      .expect(201);
    expect(web).toContainEqual({ type: "assistant", text: "On it." });
    expect(web.some((e) => e.type === "status" && e.sessionId === "sess-123")).toBe(true);

    // While the helper stream is subscribed, the read-model shows it connected, with the
    // correlated session and the consumed (now-null) pairing code.
    const connected = await authed(app).get(`/authoring/bridge/${chatId}`).expect(200);
    expect(connected.body).toMatchObject({ sessionId: "sess-123", helperConnected: true, pairingCode: null });

    // Disconnecting the helper stream is detected and surfaced.
    sub1.unsubscribe();
    sub2.unsubscribe();
    const disconnected = await authed(app).get(`/authoring/bridge/${chatId}`).expect(200);
    expect(disconnected.body.helperConnected).toBe(false);
  });

  it("rejects unauthenticated pairing, helper, and web calls", async () => {
    const server = app.getHttpServer();
    // A bad pairing code is rejected.
    await request(server).post("/authoring/bridge/pair").send({ code: "bogus" }).expect(401);
    // The helper endpoints need a valid bridge token.
    await request(server).get("/authoring/bridge/helper/commands").expect(401);
    await request(server).post("/authoring/bridge/helper/events").send({ events: [] }).expect(401);
    // The web endpoints need a session cookie (unlike the public /mcp).
    await request(server).post("/authoring/bridge").expect(401);
    await request(server).get("/authoring/bridge/anything").expect(401);
  });
});
