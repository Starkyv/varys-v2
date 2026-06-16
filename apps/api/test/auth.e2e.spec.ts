import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { getAuth } from "../src/auth/auth";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 10 / Issue 2 — the global auth gate. Pins the externally observable behaviour:
 * deny-by-default on guarded routes, accept with a valid session, reject again after
 * sign-out, and the `@Public()` allowlist (`/health`, `/mcp`). `/api/auth/*` isn't
 * mounted in tests (that's `main.ts`), so sessions are minted via the server API.
 */
describe("Auth guard", () => {
  let app: INestApplication;
  let db: TestDb;
  let cookie: string;

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

  it("leaves /mcp public — JSON-RPC reachable without a session", async () => {
    const res = await request(app.getHttpServer())
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "ping" })
      .expect(200);
    expect(res.body).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("serves /auth-config publicly with the enabled methods (default: password only)", async () => {
    const res = await request(app.getHttpServer()).get("/auth-config").expect(200);
    expect(res.body).toEqual({ emailPassword: true, google: false });
  });
});
