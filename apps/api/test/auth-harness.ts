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
 *
 * `/mcp` is the exception (Slice 16): it takes an OAuth BEARER token, not a cookie, so
 * drive it with `mcpAuthed(app)`. `mintUser()` builds a second, fully independent identity
 * for the cross-user isolation tests.
 */

/** One E2E identity: a cookie for the web API and a bearer token for `/mcp`. */
export interface TestIdentity {
  userId: string;
  email: string;
  /** `Cookie` header value — the better-auth session. */
  cookie: string;
  /** OAuth access token for `/mcp` (`Authorization: Bearer …`). */
  bearer: string;
}
let cachedCookie: string | null = null;
let cachedEmail: string | null = null;
let cachedUserId: string | null = null;
let cachedBearer: string | null = null;

/** Mint a session (idempotent per test process) and cache its cookie. Call in beforeAll
 *  AFTER `app.init()` — `getAuth()` binds the Testcontainers DB lazily on first use. */
export async function prepareAuth(): Promise<void> {
  if (cachedCookie) return;
  const identity = await mintUser("E2E");
  cachedCookie = identity.cookie;
  cachedEmail = identity.email;
  cachedUserId = identity.userId;
  cachedBearer = identity.bearer;
}

/**
 * Sign up a brand-new user and give it BOTH credentials: a session cookie and an OAuth
 * access token for `/mcp`. Each call is a distinct person — which is what the per-user
 * isolation tests need (one user must not see the other's authoring sessions).
 *
 * The token is written straight into the tables better-auth's `mcp` plugin owns, rather
 * than driving the full authorize/token dance: the browser legs (DCR → PKCE → code) need a
 * real browser, and the thing under test here is the SERVER's use of the token. `/mcp`
 * still validates it for real, via the same `getMcpSession` lookup production uses.
 */
export async function mintUser(name = "E2E"): Promise<TestIdentity> {
  const email = `e2e+${Date.now()}.${Math.floor(Math.random() * 1e6)}@varys.test`;
  const res = await getAuth().api.signUpEmail({
    body: { email, password: "e2e-password-1234", name },
    asResponse: true,
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=[^;]+/);
  if (!match) throw new Error(`E2E auth: no session cookie minted (status ${res.status})`);
  const body = (await res.json().catch(() => null)) as { user?: { id?: string } } | null;
  const userId = body?.user?.id;
  if (!userId) throw new Error("E2E auth: sign-up returned no user id");

  const bearer = await mintMcpToken(userId);
  return { userId, email, cookie: match[0], bearer };
}

/** Register an MCP client for this user (as Claude Code's DCR would) and issue it a token. */
async function mintMcpToken(userId: string): Promise<string> {
  const { adapter } = await getAuth().$context;
  const suffix = `${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
  const clientId = `e2e-client-${suffix}`;
  const now = new Date();
  await adapter.create({
    model: "oauthApplication",
    data: {
      name: "E2E Claude Code",
      clientId,
      clientSecret: null,
      redirectUrls: "http://127.0.0.1:9999/callback",
      type: "public",
      disabled: false,
      userId,
      createdAt: now,
      updatedAt: now,
    },
  });
  const accessToken = `e2e-access-${suffix}`;
  await adapter.create({
    model: "oauthAccessToken",
    data: {
      accessToken,
      refreshToken: `e2e-refresh-${suffix}`,
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      clientId,
      userId,
      scopes: "openid profile email",
      createdAt: now,
      updatedAt: now,
    },
  });
  return accessToken;
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

/** The better-auth id of the signed-in E2E user — for tests that owner-scope by user id. */
export function authUserId(): string {
  if (!cachedUserId) throw new Error("E2E auth: call prepareAuth() in beforeAll first (no user id)");
  return cachedUserId;
}

/** The E2E user's OAuth access token — what `/mcp` authenticates with (Slice 16). */
export function mcpToken(): string {
  if (!cachedBearer) throw new Error("E2E auth: call prepareAuth() in beforeAll first");
  return cachedBearer;
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

/** The `/mcp` counterpart of `authed`: a bearer token instead of a cookie. Pass a
 *  `TestIdentity` to act as a specific user (the isolation tests need two). */
export function mcpAuthed(app: INestApplication, identity?: TestIdentity) {
  const token = identity ? identity.bearer : mcpToken();
  const server = app.getHttpServer();
  const make = (verb: Verb) => (url: string) =>
    request(server)[verb](url).set("Authorization", `Bearer ${token}`);
  return { get: make("get"), post: make("post") };
}

/** `authed` for a specific identity (the second user in isolation tests). */
export function cookieAuthed(app: INestApplication, identity: TestIdentity) {
  const server = app.getHttpServer();
  const make = (verb: Verb) => (url: string) => request(server)[verb](url).set("Cookie", identity.cookie);
  return { get: make("get"), post: make("post") };
}
