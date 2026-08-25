import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import type { AuthoringDraftEvent, AuthoringFrame, AuthoringSessionSummary } from "@varys/review-contract";
import type { Subscription } from "rxjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthoringSessionService } from "../src/authoring/authoring-session.service";
import {
  authed,
  cookieAuthed,
  mcpAuthed,
  mintUser,
  prepareAuth,
  type TestIdentity,
} from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 15 (Issue 01) — live preview of an Authoring Session. Drives the MCP tool layer with a
 * deterministic script (NO live LLM) and asserts the human-only live-frame channel: a frame is
 * emitted after each MUTATING tool (navigate/type/click/checkpoint) and never after a
 * perception/control tool (observe/hover/wait) or finish. Also asserts the authenticated
 * session-list surface.
 */
describe("Authoring → live frames", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let authoring: AuthoringSessionService;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    authoring = moduleRef.get(AuthoringSessionService);
    await prepareAuth();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  // `/mcp` takes the OAuth bearer token; the web surfaces below take the session cookie.
  // Both resolve to the SAME user, which is what makes the live preview find the session.
  const callTool = async (name: string, args: unknown) => {
    const res = await mcpAuthed(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
      .expect(200);
    expect(res.body.error).toBeUndefined();
    if (res.body.result.isError) {
      throw new Error(`tool ${name} failed: ${res.body.result.content?.[0]?.text}`);
    }
    return JSON.parse(res.body.result.content[0].text);
  };

  it("emits a frame only after mutating tools, and lists/clears the active session", async () => {
    // Collect every live frame the service publishes for the duration of the run.
    const frames: AuthoringFrame[] = [];
    const sub: Subscription = authoring.liveFrames$().subscribe((f) => frames.push(f));
    const drafts: AuthoringDraftEvent[] = [];
    const subD: Subscription = authoring.sessionEvents$().subscribe((e) => drafts.push(e));

    fixture.setVariant("login");
    const opened = await callTool("open_session", {
      startUrl: fixture.url,
      name: "live preview flow",
      intent: "drive a login and assert frames",
      mode: "interactive",
    });
    const sid: string = opened.sessionId;
    const nodes: Array<{ ref: string; tag: string; name: string }> = opened.nodes;
    const usernameRef = nodes.find((n) => n.tag === "input" && n.name === "username")?.ref;
    const passwordRef = nodes.find((n) => n.tag === "input" && n.name === "password")?.ref;
    const submitRef = nodes.find((n) => n.tag === "button" && /log in/i.test(n.name))?.ref;
    expect(usernameRef && passwordRef && submitRef).toBeTruthy();

    // While the session is open it appears in the authenticated session list.
    const live = await authed(app).get("/authoring/sessions").expect(200);
    expect((live.body as AuthoringSessionSummary[]).some((s) => s.sessionId === sid)).toBe(true);

    // Non-mutating tools (observe/hover/wait) must NOT add a frame.
    await callTool("observe", { sessionId: sid });
    await callTool("hover", { sessionId: sid, ref: submitRef });
    await callTool("wait", { sessionId: sid, kind: "delay", ms: 50 });

    // Mutating tools each DO add a frame.
    await callTool("type", { sessionId: sid, ref: usernameRef, value: "alice", kind: "variable", name: "username" });
    await callTool("type", { sessionId: sid, ref: passwordRef, value: "hunter2" });
    await callTool("click", { sessionId: sid, ref: submitRef });
    await callTool("checkpoint", { sessionId: sid, name: "welcome", mode: "fullpage" });

    // finish tears the session down and must NOT add a frame.
    const finished = await callTool("finish_session", { sessionId: sid, confirm: true });
    sub.unsubscribe();
    subD.unsubscribe();
    // Finishing persists a Draft and emits the hand-off event the web uses to link to review.
    expect(drafts).toContainEqual(expect.objectContaining({ sessionId: sid, testId: finished.testId }));

    const mine = frames.filter((f) => f.sessionId === sid);
    // open(navigate) → type → type → click → checkpoint. observe/hover/wait/finish add none.
    expect(mine.map((f) => f.recorded.type)).toEqual(["navigate", "type", "type", "click", "screenshot"]);
    expect(mine.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(mine.every((f) => f.screenshot.startsWith("data:image/png;base64,"))).toBe(true);

    const lastFrame = mine[mine.length - 1];
    expect(lastFrame.recorded).toMatchObject({ type: "screenshot", checkpoint: "welcome" });
    expect(lastFrame.checkpointCount).toBe(1);

    // After finish, the session no longer appears in the list.
    const after = await authed(app).get("/authoring/sessions").expect(200);
    expect((after.body as AuthoringSessionSummary[]).some((s) => s.sessionId === sid)).toBe(false);
  });

  it("the live-preview endpoints require authentication (unlike /mcp)", async () => {
    await request(app.getHttpServer()).get("/authoring/sessions").expect(401);
    await request(app.getHttpServer()).get("/authoring/sessions/whatever/stream").expect(401);
  });

  /**
   * Slice 16 — the isolation this whole slice exists for. Two real users, two OAuth tokens:
   * a session opened by one must be invisible AND undrivable to the other, and each user's
   * "Claude Code active" indicator must reflect only their own traffic.
   */
  it("scopes sessions, tools and MCP status to the authenticating user", async () => {
    const other: TestIdentity = await mintUser("Other user");

    fixture.setVariant("login");
    const opened = await mcpAuthed(app)
      .post("/mcp")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "open_session",
          arguments: { startUrl: fixture.url, name: "owned by user one", mode: "interactive" },
        },
      })
      .expect(200);
    const sid: string = JSON.parse(opened.body.result.content[0].text).sessionId;

    try {
      // The owner sees it; the other user's list is empty of it.
      const mine = await authed(app).get("/authoring/sessions").expect(200);
      expect((mine.body as AuthoringSessionSummary[]).some((s) => s.sessionId === sid)).toBe(true);
      const theirs = await cookieAuthed(app, other).get("/authoring/sessions").expect(200);
      expect((theirs.body as AuthoringSessionSummary[]).some((s) => s.sessionId === sid)).toBe(false);

      // Streaming someone else's session reads as not-found — no existence leak.
      await cookieAuthed(app, other).get(`/authoring/sessions/${sid}/stream`).expect(404);

      // Snapshot the owner's status BEFORE the other user generates any MCP traffic, so the
      // assertion below is about isolation, not about clock resolution.
      const ownerBefore = await authed(app).get("/authoring/mcp-status").expect(200);
      expect(ownerBefore.body.connected).toBe(true);

      // Driving it over MCP with the other user's token fails at the ownership gate, and
      // the failure is the same "not found" an unknown id would produce.
      const stolen = await mcpAuthed(app, other)
        .post("/mcp")
        .send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "observe", arguments: { sessionId: sid } },
        })
        .expect(200);
      expect(stolen.body.result.isError).toBe(true);
      expect(stolen.body.result.content[0].text).toMatch(/not found/i);

      // That request marked the OTHER user active (auth succeeded; only ownership failed)…
      const otherStatus = await cookieAuthed(app, other).get("/authoring/mcp-status").expect(200);
      expect(otherStatus.body.connected).toBe(true);
      // …and left the owner's own timestamp untouched. Before Slice 16 this was one global
      // flag, so anyone's MCP traffic lit up everyone's indicator.
      const ownerAfter = await authed(app).get("/authoring/mcp-status").expect(200);
      expect(ownerAfter.body.lastSeenAt).toBe(ownerBefore.body.lastSeenAt);
    } finally {
      await mcpAuthed(app)
        .post("/mcp")
        .send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "finish_session", arguments: { sessionId: sid, confirm: true } },
        });
    }
  }, 60_000);

  it("reports MCP activity (the Claude-Code-connected proxy) and guards the endpoint", async () => {
    // The status endpoint is authenticated.
    await request(app.getHttpServer()).get("/authoring/mcp-status").expect(401);
    // Any MCP request marks recent activity — for the user the token belongs to.
    await mcpAuthed(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(200);
    const res = await authed(app).get("/authoring/mcp-status").expect(200);
    expect(res.body.connected).toBe(true);
    expect(typeof res.body.lastSeenAt).toBe("number");
  });
});
