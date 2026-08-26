import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AgentCredentialSummary, CreatedAgentCredential } from "@varys/review-contract";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, mcpToken, prepareAuth } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * The Repair Agent credential — a SECOND ISSUER on `/mcp`, not an exemption (Slice 19, slice 02 /
 * ADR-0005).
 *
 * What is pinned here is the identity and the REFUSALS, because those are the safeguard: the
 * credential's scope is what makes a long-lived machine secret acceptable. So this asserts the
 * agent can authenticate, sees only the repair toolset, and is refused for opening an Authoring
 * Session, for touching any test it holds no claim on, and for approving a baseline — plus that
 * expiry and revocation bite, that an unknown agent token is indistinguishable from an unknown
 * OAuth one, and that the human OAuth path is untouched.
 *
 * No browser here on purpose: every refusal lands before a session would ever launch, and the
 * live repair drive is slices 03/04.
 */
describe("Repair Agent credential — a second issuer on /mcp", () => {
  let app: INestApplication;
  let db: TestDb;
  let agentToken: string;
  let credential: AgentCredentialSummary;
  let testId: string;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.connectionString;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    const created = await authed(app)
      .post("/settings/agent-credentials")
      .send({ label: "nightly-drainer", expiresInDays: 7 })
      .expect(201);
    const body = created.body as CreatedAgentCredential;
    agentToken = body.token;
    credential = body.credential;

    // A real test row, so "refused for reading or editing any test" is refused on a test that
    // genuinely exists rather than passing by accident on a not-found.
    const test = await authed(app)
      .post("/tests")
      .send({
        name: "agent-scope target",
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        steps: [{ type: "navigate", url: "http://fixture.local/" }],
      })
      .expect(201);
    testId = test.body.id as string;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
  });

  /** JSON-RPC on `/mcp` as whoever holds `token`. */
  const rpc = (token: string, method: string, params: unknown, id: number | null = 1) =>
    request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id, method, params });

  /** Call a tool as the agent and hand back the raw MCP result (errors included — most of the
   *  assertions here are ABOUT the error). */
  const agentCall = async (name: string, args: unknown) => {
    const res = await rpc(agentToken, "tools/call", { name, arguments: args }).expect(200);
    expect(res.body.error).toBeUndefined();
    return res.body.result as { isError?: boolean; content: { text: string }[] };
  };

  const toolNames = async (token: string): Promise<string[]> => {
    const res = await rpc(token, "tools/list", {}).expect(200);
    return (res.body.result.tools as { name: string }[]).map((t) => t.name);
  };

  it("provisions a named credential with an expiry, and lists it", async () => {
    expect(credential).toMatchObject({ label: "nightly-drainer", status: "active" });
    expect(agentToken).toMatch(/^varys_agent_/);
    expect(credential.tokenHint).toBe(agentToken.slice(-4));
    expect(Date.parse(credential.expiresAt)).toBeGreaterThan(Date.now());

    const listed = await authed(app).get("/settings/agent-credentials").expect(200);
    const rows = listed.body as AgentCredentialSummary[];
    const mine = rows.find((r) => r.id === credential.id);
    expect(mine).toMatchObject({ label: "nightly-drainer", status: "active" });
    // The secret is never readable again — the list carries a hint, not a token.
    expect(JSON.stringify(rows)).not.toContain(agentToken);
  });

  it("resolves on /mcp to a service principal with a stable id and the agent's label", async () => {
    // `initialize` proves authentication succeeded; the principal itself is observed through the
    // refusal messages below, which quote the agent's label rather than any human's name.
    const init = await rpc(agentToken, "initialize", { protocolVersion: "2024-11-05" }).expect(200);
    expect(init.body.result.serverInfo).toBeDefined();

    const refused = await agentCall("read_test", { testId });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Repair Agent "nightly-drainer"');
  });

  it("sees the repair toolset and nothing else — no authoring, no cross-test browsing", async () => {
    const agentTools = await toolNames(agentToken);
    expect(agentTools).toContain("open_repair_session");
    expect(agentTools).toContain("apply_fix");
    // Authoring a NEW test is a human act; browsing every test's failures is out of scope.
    for (const forbidden of ["open_session", "checkpoint", "finish_session", "discard_session", "failed_runs"]) {
      expect(agentTools).not.toContain(forbidden);
    }
  });

  it("is refused for opening an Authoring Session", async () => {
    const res = await agentCall("open_session", {
      startUrl: "http://fixture.local/",
      mode: "batch",
      name: "should never exist",
    });
    expect(res.isError).toBe(true);
    // Reported as an unknown tool — the same answer another user's session id gets, so the
    // surface can't be probed for what it is hiding.
    expect(res.content[0].text).toContain("Unknown tool");
  });

  it("is refused for reading or editing any test while it holds no claim", async () => {
    for (const [name, args] of [
      ["read_test", { testId }],
      ["edit_test", { testId, name: "renamed by an unclaimed agent" }],
      ["open_repair_session", { testId }],
    ] as const) {
      const res = await agentCall(name, args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("no claimed repair job");
    }

    // …and the refusal is real: the test is untouched.
    const after = await authed(app).get(`/tests/${testId}`).expect(200);
    expect(after.body.name).toBe("agent-scope target");
  });

  it("is refused for approving a baseline — permanently, not pending a claim", async () => {
    // Baseline approval is not on the MCP surface at all…
    const agentTools = await toolNames(agentToken);
    expect(agentTools.some((t) => /approve|baseline|promote/.test(t))).toBe(false);

    // …and the credential cannot authenticate the web API that does it, claim or no claim.
    const runId = "00000000-0000-0000-0000-000000000000";
    await request(app.getHttpServer())
      .post(`/runs/${runId}/approve-all`)
      .set("Authorization", `Bearer ${agentToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`/runs/${runId}/checkpoints/hero/approve`)
      .set("Authorization", `Bearer ${agentToken}`)
      .expect(401);
  });

  it("cannot mint or extend its own credential", async () => {
    await request(app.getHttpServer())
      .get("/settings/agent-credentials")
      .set("Authorization", `Bearer ${agentToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .post("/settings/agent-credentials")
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ label: "self-issued" })
      .expect(401);
  });

  it("updates last_used_at on use, and shows it in the management surface", async () => {
    const before = await authed(app).get("/settings/agent-credentials").expect(200);
    const seen = (before.body as AgentCredentialSummary[]).find((r) => r.id === credential.id);
    // The tests above already presented the token, so it has been used by now.
    expect(seen?.lastUsedAt).toBeTruthy();
    const first = Date.parse(seen?.lastUsedAt ?? "");

    await new Promise((r) => setTimeout(r, 25));
    await rpc(agentToken, "ping", {}).expect(200);

    const after = await authed(app).get("/settings/agent-credentials").expect(200);
    const again = (after.body as AgentCredentialSummary[]).find((r) => r.id === credential.id);
    expect(Date.parse(again?.lastUsedAt ?? "")).toBeGreaterThan(first);
  });

  it("answers an unknown or malformed agent token exactly as it answers an unknown OAuth token", async () => {
    const unknownOauth = await rpc("not-a-real-oauth-token", "tools/list", {});
    const unknownAgent = await rpc("varys_agent_totally-made-up", "tools/list", {});
    const malformedAgent = await rpc("varys_agent_", "tools/list", {});

    for (const res of [unknownAgent, malformedAgent]) {
      expect(res.status).toBe(unknownOauth.status);
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBe(unknownOauth.headers["www-authenticate"]);
      expect(res.body).toEqual(unknownOauth.body);
    }
  });

  it("refuses an expired credential and, immediately, a revoked one", async () => {
    const expired = await authed(app)
      .post("/settings/agent-credentials")
      .send({ label: "already-stale", expiresInDays: 1 })
      .expect(201);
    const expiredBody = expired.body as CreatedAgentCredential;
    // Backdate its expiry rather than waiting a day — the check is `expires_at <= now`.
    const pool = new Pool({ connectionString: db.connectionString });
    await pool.query("UPDATE agent_credentials SET expires_at = now() - interval '1 hour' WHERE id = $1", [
      expiredBody.credential.id,
    ]);
    await pool.end();
    await rpc(expiredBody.token, "tools/list", {}).expect(401);
    const listedExpired = await authed(app).get("/settings/agent-credentials").expect(200);
    expect(
      (listedExpired.body as AgentCredentialSummary[]).find((r) => r.id === expiredBody.credential.id)?.status,
    ).toBe("expired");

    const live = await authed(app)
      .post("/settings/agent-credentials")
      .send({ label: "to-be-revoked" })
      .expect(201);
    const liveBody = live.body as CreatedAgentCredential;
    await rpc(liveBody.token, "ping", {}).expect(200); // works right up to the revocation

    const revoked = await authed(app)
      .post(`/settings/agent-credentials/${liveBody.credential.id}/revoke`)
      .expect(200);
    expect(revoked.body).toMatchObject({ status: "revoked" });
    // No cache to wait out: the very next request is refused.
    await rpc(liveBody.token, "ping", {}).expect(401);
  });

  it("leaves the human OAuth path untouched — a user still sees the full toolset", async () => {
    const userTools = await toolNames(mcpToken());
    expect(userTools).toContain("open_session");
    expect(userTools).toContain("checkpoint");
    expect(userTools).toContain("failed_runs");
    expect(userTools.length).toBeGreaterThan((await toolNames(agentToken)).length);
  });
});
