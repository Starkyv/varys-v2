import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { getAuth } from "../src/auth/auth";
import { mintUser, type TestIdentity } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 10 / Issue 2 — the global auth gate. Pins the externally observable behaviour:
 * deny-by-default on guarded routes, accept with a valid session, reject again after
 * sign-out, and the `@Public()` allowlist (`/health`, `/mcp`). `/api/auth/*` isn't
 * mounted in tests (that's `main.ts`), so sessions are minted via the server API.
 *
 * Slice 16 amends the `/mcp` expectation: it is exempt from the COOKIE guard (Claude Code
 * has no browser cookie) but requires an OAuth bearer token, so an anonymous request now
 * gets a 401 carrying the challenge that bootstraps the OAuth flow.
 */
describe("Auth guard", () => {
  let app: INestApplication;
  let db: TestDb;
  let cookie: string;
  /** A live identity with both credentials — used to prove a cookie is not an MCP key. */
  let identity: TestIdentity;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.connectionString;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const res = await getAuth().api.signUpEmail({
      body: { email: `guard+${Date.now()}@varys.test`, password: "e2e-password-1234", name: "Guard" },
      asResponse: true,
    });
    cookie = (res.headers.get("set-cookie") ?? "").match(/better-auth\.session_token=[^;]+/)?.[0] ?? "";
    expect(cookie).toBeTruthy();
    identity = await mintUser("MCP Guard");
  });

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
  });

  it("rejects an unauthenticated request to a guarded route (401)", async () => {
    await request(app.getHttpServer()).get("/tests").expect(401);
  });

  it("accepts the guarded route with a valid session cookie (200)", async () => {
    await request(app.getHttpServer()).get("/tests").set("Cookie", cookie).expect(200);
  });

  it("rejects again once the session is signed out (401)", async () => {
    await getAuth().api.signOut({ headers: new Headers({ cookie }) });
    await request(app.getHttpServer()).get("/tests").set("Cookie", cookie).expect(401);
  });

  it("leaves /health public — reachable without a session", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });

  it("exempts /mcp from the COOKIE guard but still demands an OAuth bearer token", async () => {
    // 401 + WWW-Authenticate is what makes Claude Code start the OAuth flow, so the
    // challenge header — pointing at the protected-resource metadata — is load-bearing.
    const res = await request(app.getHttpServer())
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "ping" })
      .expect(401);
    expect(res.headers["www-authenticate"]).toContain("resource_metadata=");
    expect(res.body.error.message).toMatch(/unauthorized/i);
    // A VALID web session cookie is still not an MCP credential — the token is the only key.
    await request(app.getHttpServer())
      .post("/mcp")
      .set("Cookie", identity.cookie)
      .send({ jsonrpc: "2.0", id: 1, method: "ping" })
      .expect(401);

    // The bearer token is.
    const ok = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", `Bearer ${identity.bearer}`)
      .send({ jsonrpc: "2.0", id: 1, method: "ping" })
      .expect(200);
    expect(ok.body).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("has exactly ONE issuer: a bearer that is not a user's OAuth token gets no second chance", async () => {
    // ADR-0008. `/mcp` once accepted a provisioned Repair Agent credential as well, chosen by a
    // token prefix before either issuer ran. There is no such fork now, so what is pinned here is
    // the ABSENCE: a token shaped like the old credential is refused exactly as any other unknown
    // string is, with the same status, the same challenge and the same message. If a second
    // issuer were ever reintroduced by accident, the prefixed token would stop matching the
    // unprefixed one and this fails.
    const unknown = await request(app.getHttpServer())
      .post("/mcp")
      .set("Authorization", "Bearer not-a-token-anybody-issued")
      .send({ jsonrpc: "2.0", id: 1, method: "ping" })
      .expect(401);

    for (const impostor of ["varys_agent_deadbeefdeadbeefdeadbeefdeadbeef", "vk_live_0123456789abcdef"]) {
      const res = await request(app.getHttpServer())
        .post("/mcp")
        .set("Authorization", `Bearer ${impostor}`)
        .send({ jsonrpc: "2.0", id: 1, method: "ping" })
        .expect(401);
      expect(res.headers["www-authenticate"]).toBe(unknown.headers["www-authenticate"]);
      expect(res.body.error.message).toBe(unknown.body.error.message);
    }
  });

  it("serves ONE tool list, the same for everybody", async () => {
    // The other half of ADR-0008's "one issuer": with no second kind of principal there is no
    // per-principal filtering left, so the list a caller gets is a property of the server rather
    // than of who is asking. Two different users see the same list, byte for byte.
    const second = await mintUser("Second Caller");
    const listFor = async (bearer: string): Promise<string[]> => {
      const res = await request(app.getHttpServer())
        .post("/mcp")
        .set("Authorization", `Bearer ${bearer}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
        .expect(200);
      return (res.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    };
    const mine = await listFor(identity.bearer);
    expect(mine.length).toBeGreaterThan(0);
    expect(await listFor(second.bearer)).toEqual(mine);
  });

  it("serves the OAuth discovery documents MCP clients probe at the origin root", async () => {
    const meta = await request(app.getHttpServer())
      .get("/.well-known/oauth-authorization-server")
      .expect(200);
    expect(meta.body.authorization_endpoint).toContain("/api/auth/mcp/authorize");
    expect(meta.body.registration_endpoint).toContain("/api/auth/mcp/register");
    expect(meta.body.code_challenge_methods_supported).toContain("S256");

    const resource = await request(app.getHttpServer())
      .get("/.well-known/oauth-protected-resource")
      .expect(200);
    expect(resource.body.authorization_servers.length).toBeGreaterThan(0);
    // The resource-suffixed form newer clients try first.
    await request(app.getHttpServer()).get("/.well-known/oauth-protected-resource/mcp").expect(200);
  });

  it("serves /auth-config publicly with the enabled methods (default: password only)", async () => {
    const res = await request(app.getHttpServer()).get("/auth-config").expect(200);
    expect(res.body).toEqual({ emailPassword: true, google: false });
  });
});
