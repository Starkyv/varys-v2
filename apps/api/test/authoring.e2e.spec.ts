import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import request from "supertest";
import { authed, prepareAuth } from "./auth-harness";
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

  const rpc = (method: string, params: unknown, id: number | null = 1) =>
    authed(app).post("/mcp").send({ jsonrpc: "2.0", id, method, params });

  // Call a tool and return its parsed JSON result (failing the test on a tool error).
  const callTool = async (name: string, args: unknown) => {
    const res = await rpc("tools/call", { name, arguments: args }).expect(200);
    expect(res.body.error).toBeUndefined();
    if (res.body.result.isError) {
      throw new Error(`tool ${name} failed: ${res.body.result.content?.[0]?.text}`);
    }
    return JSON.parse(res.body.result.content[0].text);
  };

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

  it("finish on an unknown session is a tool error, not a crash", async () => {
    const res = await rpc("tools/call", {
      name: "finish_session",
      arguments: { sessionId: "00000000-0000-0000-0000-000000000000" },
    }).expect(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/not found/i);
  });
});
