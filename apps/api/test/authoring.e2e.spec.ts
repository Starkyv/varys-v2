import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import request from "supertest";
import { authed, authEmail, mcpAuthed, prepareAuth } from "./auth-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 14 (Issue 2) — the authoring walking skeleton, end to end. Drives the MCP tool
 * layer with a deterministic JSON-RPC script (NO live LLM) against the fixture app and
 * asserts the persisted Draft. This is the issue's specified test seam: the MCP surface
 * is scriptable, so the authoring engine is verifiable without a model.
 */
describe("Authoring → MCP → Draft", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  // `/mcp` authenticates with an OAuth bearer token, not the web session cookie (Slice 16).
  const rpc = (method: string, params: unknown, id: number | null = 1) =>
    mcpAuthed(app).post("/mcp").send({ jsonrpc: "2.0", id, method, params });

  // Call a tool and return its parsed JSON result (failing the test on a tool error).
  const callTool = async (name: string, args: unknown) => {
    const res = await rpc("tools/call", { name, arguments: args }).expect(200);
    expect(res.body.error).toBeUndefined();
    if (res.body.result.isError) {
      throw new Error(`tool ${name} failed: ${res.body.result.content?.[0]?.text}`);
    }
    return JSON.parse(res.body.result.content[0].text);
  };

  it("authors a checkpoint's COMPARISON, not just its capture (pixel vs context judge)", async () => {
    fixture.setVariant("default");
    const opened = await callTool("open_session", {
      startUrl: fixture.url,
      name: "compare modes",
      mode: "batch",
    });
    const sid: string = opened.sessionId;

    // Default: an exact pixel diff, with a tolerance for minor rendering wobble.
    await callTool("checkpoint", { sessionId: sid, name: "chrome", mode: "fullpage", threshold: 0.01 });
    // Generated content can't be pixel-compared — the judge gets an instruction instead.
    await callTool("checkpoint", {
      sessionId: sid,
      name: "generated summary",
      mode: "fullpage",
      compareMode: "context",
      prompt: "Both are AI-generated summaries; ignore wording and figures. Fail only if the current one is empty, truncated, or an error.",
    });
    // Pixel-only knobs on a context checkpoint are refused rather than silently dropped at run time.
    const bad = await rpc("tools/call", {
      name: "checkpoint",
      arguments: { sessionId: sid, name: "confused", mode: "fullpage", compareMode: "context", threshold: 0.02 },
    }).expect(200);
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toMatch(/pixel-mode knobs/i);

    const finished = await callTool("finish_session", { sessionId: sid });
    const test = await authed(app).get(`/tests/${finished.testId}`).expect(200);
    const shots = (test.body.definition as {
      steps: Array<{ type: string; name?: string; compareMode?: string; prompt?: string; threshold?: number }>;
    }).steps.filter((st) => st.type === "screenshot");

    expect(shots.find((st) => st.name === "chrome")).toMatchObject({
      compareMode: "pixel",
      threshold: 0.01,
    });
    const judged = shots.find((st) => st.name === "generated summary");
    expect(judged).toMatchObject({ compareMode: "context" });
    expect(judged?.prompt).toMatch(/ignore wording and figures/i);
    // The judge ignores masks/threshold, so they are never written onto a context checkpoint.
    expect(judged).not.toHaveProperty("threshold");
  }, 60_000);

  it("authors a streamIdle wait and settles on it live", async () => {
    fixture.setVariant("streaming");
    const opened = await callTool("open_session", {
      startUrl: fixture.url,
      name: "streamed answer",
      mode: "batch",
    });
    const sid: string = opened.sessionId;

    // The answer streams in, and the "Copy answer" action only appears once it has finished —
    // so right after load it is absent.
    const hasCopy = (nodes: Array<{ name: string }>) => nodes.some((n) => /copy answer/i.test(n.name));
    expect(hasCopy(opened.nodes)).toBe(false);

    const waited = await callTool("wait", { sessionId: sid, kind: "streamIdle", quietMs: 300, timeoutMs: 15_000 });
    // A wait is not a step — it attaches to whatever is recorded next.
    expect(waited.recorded).toMatchObject({ type: "wait", wait: "streamIdle" });

    // Having settled live, the model perceives the FINISHED state. A naive "quiet for 300ms"
    // would have returned during the pre-stream calm and missed this.
    expect(hasCopy(waited.snapshot.nodes)).toBe(true);

    // The wait rides on the next recorded step, so replay settles the same way.
    await callTool("checkpoint", { sessionId: sid, name: "answer", mode: "fullpage" });
    const finished = await callTool("finish_session", { sessionId: sid });
    const test = await authed(app).get(`/tests/${finished.testId}`).expect(200);
    const shot = (test.body.definition as {
      steps: Array<{ type: string; waitBefore?: Array<{ kind: string; quietMs?: number }> }>;
    }).steps.find((st) => st.type === "screenshot");
    expect(shot?.waitBefore).toEqual([{ kind: "streamIdle", quietMs: 300, timeoutMs: 15_000 }]);
  }, 60_000);

  it("discards a session without persisting a draft, and demands confirmation first", async () => {
    fixture.setVariant("default");
    const opened = await callTool("open_session", {
      startUrl: fixture.url,
      name: "wrong turn",
      mode: "batch",
    });
    const sid: string = opened.sessionId;
    await callTool("checkpoint", { sessionId: sid, name: "junk", mode: "fullpage" });

    const draftsBefore = (await authed(app).get("/drafts").expect(200)).body as Array<{ id: string }>;

    // Unconfirmed discard is refused — it destroys work irreversibly.
    const unconfirmed = await rpc("tools/call", {
      name: "discard_session",
      arguments: { sessionId: sid },
    }).expect(200);
    expect(unconfirmed.body.result.isError).toBe(true);
    expect(unconfirmed.body.result.content[0].text).toMatch(/confirm: true/);

    const discarded = await callTool("discard_session", { sessionId: sid, confirm: true });
    expect(discarded).toMatchObject({ ok: true, discarded: sid });

    // No draft was created, and the session is gone.
    const draftsAfter = (await authed(app).get("/drafts").expect(200)).body as Array<{ id: string }>;
    expect(draftsAfter.length).toBe(draftsBefore.length);
    const sessions = (await authed(app).get("/authoring/sessions").expect(200)).body as Array<{ sessionId: string }>;
    expect(sessions.some((x) => x.sessionId === sid)).toBe(false);
    // Further tools on it read as not-found.
    const after = await rpc("tools/call", { name: "observe", arguments: { sessionId: sid } }).expect(200);
    expect(after.body.result.isError).toBe(true);
  }, 60_000);

  it("speaks MCP: initialize + tools/list expose the authoring tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} }).expect(200);
    expect(init.body.result.serverInfo.name).toBe("varys-authoring");
    expect(init.body.result.capabilities.tools).toBeDefined();

    const list = await rpc("tools/list", {}).expect(200);
    const names = (list.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["open_session", "finish_session"]));

    // A notification (no id) gets 202 Accepted with no JSON-RPC response body.
    await rpc("notifications/initialized", {}, null).expect(202);
  });

  it("a navigate-only session produces a retrievable Draft (origin ai, 0 checkpoints)", async () => {
    const opened = await callTool("open_session", {
      startUrl: fixture.url,
      name: "smoke test",
      intent: "verify the page loads",
      mode: "interactive",
    });
    expect(opened.sessionId).toEqual(expect.any(String));
    expect(typeof opened.url).toBe("string");

    const finished = await callTool("finish_session", { sessionId: opened.sessionId, confirm: true });
    expect(finished.testId).toEqual(expect.any(String));
    expect(finished.checkpointCount).toBe(0);
    expect(finished.warning).toMatch(/no checkpoints/i);

    // The draft is in the review queue: AI-authored, zero checkpoints, with the intent.
    const drafts = await authed(app).get("/drafts").expect(200);
    const draft = (drafts.body as Array<{ id: string }>).find((d) => d.id === finished.testId);
    expect(draft).toMatchObject({
      origin: "ai",
      checkpointCount: 0,
      intent: "verify the page loads",
    });

    // ...and it is NOT in the active Tests list (drafts are held out of suites/schedules).
    const tests = await authed(app).get("/tests").expect(200);
    expect((tests.body as Array<{ id: string }>).find((t) => t.id === finished.testId)).toBeUndefined();

    // Slice 16 — the draft is attributed to the user whose Claude Code authored it (not the
    // bare string "ai"). `createdBy` only surfaces once the draft is promoted into /tests.
    await authed(app).post(`/drafts/${finished.testId}/promote`).send({}).expect(201);
    const active = await authed(app).get("/tests").expect(200);
    expect(
      (active.body as Array<{ id: string; createdBy: string | null }>).find(
        (t) => t.id === finished.testId,
      ),
    ).toMatchObject({ createdBy: authEmail() });
  });

  it("records a login flow: fingerprinted click/type with literal values, only {{baseUrl}} parameterized", async () => {
    fixture.setVariant("login");
    const opened = await callTool("open_session", {
      startUrl: fixture.url,
      name: "login flow",
      intent: "log in and reach the welcome state",
      mode: "interactive",
    });
    const sid: string = opened.sessionId;
    const nodes: Array<{ ref: string; tag: string; name: string; role: string }> = opened.nodes;

    // Targets are picked from the perception snapshot by ref (no CSS guessing).
    const usernameRef = nodes.find((n) => n.tag === "input" && n.name === "username")?.ref;
    const passwordRef = nodes.find((n) => n.tag === "input" && n.name === "password")?.ref;
    const submitRef = nodes.find((n) => n.tag === "button" && /log in/i.test(n.name))?.ref;
    expect(usernameRef).toBeTruthy();
    expect(passwordRef).toBeTruthy();
    expect(submitRef).toBeTruthy();

    // Typed values are recorded literally — no variables/secrets, even for a password field.
    await callTool("type", { sessionId: sid, ref: usernameRef, value: "Q3 sales report" });
    const typed = await callTool("type", { sessionId: sid, ref: passwordRef, value: "hunter2" });
    expect(typed.recorded.value).toBe("hunter2"); // stored literally
    await callTool("click", { sessionId: sid, ref: submitRef });

    // A full-page checkpoint — the visual assertion. With one present, finish doesn't warn.
    const cp = await callTool("checkpoint", { sessionId: sid, name: "welcome", mode: "fullpage" });
    expect(cp.recorded).toMatchObject({ type: "screenshot", checkpoint: "welcome" });

    const finished = await callTool("finish_session", { sessionId: sid, confirm: true });
    expect(finished.checkpointCount).toBe(1);
    expect(finished.warning).toBeNull();

    // Inspect the persisted draft definition: env-agnostic + correctly tokenized.
    const test = await authed(app).get(`/tests/${finished.testId}`).expect(200);
    const def = test.body.definition as {
      steps: Array<{ type: string; url?: string; value?: string; name?: string; captureMode?: string }>;
      variables: Array<{ name: string; kind: string }>;
    };
    expect(def.steps[0].type).toBe("navigate");
    expect(def.steps[0].url?.startsWith("{{baseUrl}}")).toBe(true);
    const typeValues = def.steps.filter((s) => s.type === "type").map((s) => s.value);
    // Typed values are literal — no tokens.
    expect(typeValues).toContain("Q3 sales report");
    expect(typeValues).toContain("hunter2");
    expect(def.steps.some((s) => s.type === "click")).toBe(true);
    // The checkpoint persisted as a full-page screenshot step.
    const shot = def.steps.find((s) => s.type === "screenshot");
    expect(shot).toMatchObject({ name: "welcome", captureMode: "fullpage" });
    // Only the entry URL's origin is parameterized.
    expect(def.variables).toEqual([{ name: "baseUrl", kind: "url" }]);
    // (The authoring preview captured at the "welcome" checkpoint is asserted via the
    // read-model in drafts.e2e — those reads are auth-guarded, so they live there with the
    // service-level setup rather than behind a live browser session here.)
  });

  it("surfaces the signals replay locates by: identity, duplicates, and a matcher dry run", async () => {
    fixture.setVariant("twins");
    const opened = await callTool("open_session", {
      startUrl: fixture.url,
      name: "locator signals",
      mode: "batch",
    });
    const sid: string = opened.sessionId;
    type Node = {
      ref: string;
      role: string;
      name: string;
      tag: string;
      testId?: string;
      id?: string;
      duplicate?: boolean;
    };
    const { nodes } = (await callTool("observe", { sessionId: sid })) as { nodes: Node[] };

    // An author-stable id is surfaced, so the agent can tell a durable target from a guess.
    const newReport = nodes.find((n) => n.name === "New report");
    expect(newReport?.id).toBe("new-report");
    expect(newReport?.duplicate).toBeUndefined();

    // The two identical "Edit" buttons are flagged BEFORE either is acted on — on replay they
    // score as a tie and the matcher refuses to guess.
    const edits = nodes.filter((n) => n.name === "Edit");
    expect(edits).toHaveLength(2);
    for (const e of edits) expect(e.duplicate).toBe(true);

    // The unlabelled icon buttons are a different failure — nothing to be ambiguous WITH,
    // simply nothing to match on. They are surfaced with a blank name, not flagged as twins.
    const blank = nodes.filter((n) => n.tag === "button" && n.name === "");
    expect(blank.length).toBeGreaterThanOrEqual(2);
    for (const b of blank) expect(b.duplicate).toBeUndefined();

    // The probe runs the REAL matcher. An "Edit" button inside a row is findable — but only via
    // the row's text, which the verdict says out loud so the agent can judge whether that text
    // is stable data.
    const editProbe = await callTool("verify_locator", { sessionId: sid, ref: edits[0].ref });
    expect(editProbe.status).toBe("resolved");
    expect(editProbe.verdict).toBe("row-scoped");
    expect(editProbe.recorded.scope.text).toMatch(/Acme|Globex/);

    // A stable id resolves on its own identity — the only verdict that is safe to record blind.
    const okProbe = await callTool("verify_locator", { sessionId: sid, ref: newReport?.ref });
    expect(okProbe.status).toBe("resolved");
    expect(okProbe.matchedSignal).toBe("id");
    expect(okProbe.verdict).toBe("deterministic");

    // An unlabelled tile RESOLVES — on its class and its size, separated from its twin only by
    // sibling position. That is the trap `status` alone would wave through: the verdict calls it
    // fragile, because the first inserted tile silently moves the click.
    // Two tiles then two wrapped cards, in document order.
    const clickableDivs = nodes.filter((n) => n.tag === "div" && n.role === "button" && n.name === "");
    expect(clickableDivs).toHaveLength(4);
    const tileProbe = await callTool("verify_locator", { sessionId: sid, ref: clickableDivs[0].ref });
    expect(tileProbe.status).toBe("resolved");
    expect(tileProbe.verdict).toBe("fragile");
    expect(tileProbe.advice).toMatch(/do not record/i);

    // Two identical unlabelled cards, each in its own wrapper — not even position tells them
    // apart. The matcher hard-fails as ambiguous rather than clicking one at random, which is
    // exactly the failure the probe exists to move from run time to authoring time.
    const cardProbe = await callTool("verify_locator", { sessionId: sid, ref: clickableDivs[2].ref });
    expect(cardProbe.status).toBe("ambiguous");
    expect(cardProbe.verdict).toBe("ambiguous");
    expect(cardProbe.advice).toMatch(/do not record/i);

    // The probe records nothing: the session is still empty apart from the entry navigate.
    const finished = await callTool("finish_session", { sessionId: sid, confirm: true });
    expect(finished.checkpointCount).toBe(0);
  }, 60_000);

  it("finish on an unknown session is a tool error, not a crash", async () => {
    const res = await rpc("tools/call", {
      name: "finish_session",
      arguments: { sessionId: "00000000-0000-0000-0000-000000000000" },
    }).expect(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/not found/i);
  });
});
