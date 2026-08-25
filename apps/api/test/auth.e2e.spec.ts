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
