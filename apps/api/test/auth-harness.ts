import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { getAuth } from "../src/auth/auth";

/**
 * E2E auth harness. The API is deny-by-default (Slice 10 / Issue 2), so every E2E must
 * carry a valid session. `/api/auth/*` isn't mounted in tests (that's `main.ts`), so we
 * mint a real session through better-auth's in-process server API and replay its cookie.
 *
 * Usage per suite:
 *   beforeAll(async () => { …; await app.init(); await prepareAuth(); });
 *   …and use `authed(app)` wherever `request(app.getHttpServer())` was used.
 */
let cachedCookie: string | null = null;
let cachedEmail: string | null = null;

/** Mint a session (idempotent per test process) and cache its cookie. Call in beforeAll
 *  AFTER `app.init()` — `getAuth()` binds the Testcontainers DB lazily on first use. */
export async function prepareAuth(): Promise<void> {
  if (cachedCookie) return;
  const email = `e2e+${Date.now()}.${Math.floor(Math.random() * 1e6)}@varys.test`;
  const res = await getAuth().api.signUpEmail({
    body: { email, password: "e2e-password-1234", name: "E2E" },
    asResponse: true,
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=[^;]+/);
  if (!match) throw new Error(`E2E auth: no session cookie minted (status ${res.status})`);
  cachedCookie = match[0];
  cachedEmail = email;
}

/** The Cookie header value for an authenticated request. Requires `prepareAuth()` first. */
export function authCookie(): string {
  if (!cachedCookie) throw new Error("E2E auth: call prepareAuth() in beforeAll first");
  return cachedCookie;
}

/** The email of the signed-in E2E user — the value audited writes are attributed to. */
export function authEmail(): string {
  if (!cachedEmail) throw new Error("E2E auth: call prepareAuth() in beforeAll first");
  return cachedEmail;
}

type Verb = "get" | "post" | "put" | "delete" | "patch";

/**
 * Drop-in for `request(app.getHttpServer())` that pre-attaches the session cookie, so a
 * guarded route accepts the request. (`@Public()` routes ignore the extra header.)
 */
export function authed(app: INestApplication) {
  const server = app.getHttpServer();
  const make = (verb: Verb) => (url: string) => request(server)[verb](url).set("Cookie", authCookie());
  return {
    get: make("get"),
    post: make("post"),
    put: make("put"),
    delete: make("delete"),
    patch: make("patch"),
  };
}
