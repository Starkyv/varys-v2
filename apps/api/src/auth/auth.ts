import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { Pool } from "pg";
import { isSignInAllowed, parseDomainPolicy } from "./domain-policy";

/**
 * The better-auth instance — Varys's OWN user authentication (who can use Varys).
 * Distinct from the per-environment app-under-test login vault (how Varys logs into
 * the apps it tests, DESIGN §2) — that is unrelated and untouched.
 *
 * better-auth owns its tables (`user`, `session`, `account`, `verification`) in the
 * same Postgres; sessions are httpOnly cookies. The handler is mounted at
 * `/api/auth/*` in `main.ts` (before body parsing — it needs the raw request).
 *
 * Slice 10 (Auth & multi-user):
 *  - Issue 1: email + password, httpOnly cookie sessions.
 *  - Issue 2: a global guard that enforces a session on every other route.
 *  - Issue 3 (this): Google SSO with an env-driven domain restriction.
 */

/**
 * Which sign-in methods are enabled, controlled by `VARYS_AUTH_METHODS` — a comma list
 * of `password` and/or `google` (default `password`). The server is the source of
 * truth: it configures better-auth from this, and the SPA renders only the enabled
 * methods (it reads them from `GET /auth-config`).
 *
 * Google additionally needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (it resolves to
 * off if requested without them). The domain restriction is itself env-driven (see
 * `./domain-policy`): `VARYS_AUTH_ALLOWED_DOMAINS` (comma list; default `datagenie.ai`)
 * and `VARYS_AUTH_DOMAIN_SCOPE` (`google` = restrict only SSO | `all` = restrict every
 * sign-up).
 */
function resolveAuthMethods(): { emailPassword: boolean; google: boolean } {
  const requested = (process.env.VARYS_AUTH_METHODS ?? "password")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);

  const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  let emailPassword = requested.includes("password");
  const google = requested.includes("google") && googleConfigured;

  if (requested.includes("google") && !googleConfigured) {
    console.warn(
      "[auth] VARYS_AUTH_METHODS requests 'google' but GOOGLE_CLIENT_ID/SECRET are unset.",
    );
  }
  // Never lock everyone out: if the config would leave no usable method, keep email/password.
  if (!emailPassword && !google) {
    console.warn(
      "[auth] VARYS_AUTH_METHODS left no usable sign-in method — falling back to email/password.",
    );
    emailPassword = true;
  }
  return { emailPassword, google };
}

export const authMethods = resolveAuthMethods();

function createAuth() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // pg requires an idle-client error listener, or a dropped connection (the DB going
  // away on test teardown, or a transient network blip) escalates to an unhandled
  // process error. Log and carry on — the pool reconnects on the next query.
  pool.on("error", (err) => {
    console.warn("[auth] idle pg client error:", err.message);
  });

  const policy = parseDomainPolicy();
  return betterAuth({
    database: pool,
    // Google SSO, configured only when enabled (VARYS_AUTH_METHODS includes `google`
    // + creds present). The domain restriction is enforced HERE for Google (the
    // provider is certain — no detection needed): mapProfileToUser runs on the Google
    // profile and throws if its email domain isn't allowed, aborting the sign-in.
    ...(authMethods.google
      ? {
          socialProviders: {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID ?? "",
              clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
              mapProfileToUser: (profile: {
                email?: string;
                name?: string;
                picture?: string;
                email_verified?: boolean;
              }) => {
                const email = profile.email ?? "";
                if (!isSignInAllowed(email, "google", policy)) {
                  throw new APIError("FORBIDDEN", {
                    message: `Google sign-in is restricted to: ${policy.allowedDomains.join(", ")}`,
                  });
                }
                return {
                  email,
                  name: profile.name ?? email,
                  image: profile.picture,
                  emailVerified: profile.email_verified ?? false,
                };
              },
            },
          },
        }
      : {}),
    // The `all` scope additionally restricts every NEW account (incl. email/password) to
    // the allow-list. Google is already gated above, so this hook treats creation as the
    // non-Google ("credential") gate — a no-op under the default `google` scope.
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isSignInAllowed(user.email, "credential", policy)) {
              throw new APIError("FORBIDDEN", {
                message: `Sign-up is restricted to: ${policy.allowedDomains.join(", ")}`,
              });
            }
          },
        },
      },
    },
    // The public origin the browser reaches better-auth at. In dev the SPA is served at
    // :5200 and proxies `/api/auth` → :4000, so the session cookie (and any later OAuth
    // redirect) is scoped to :5200. In prod the web + API share one ingress origin —
    // set BETTER_AUTH_URL to it.
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:5200",
    basePath: "/api/auth",
    // Dev-only fallback so the local stack boots with one command. This is the session
    // signing key — it MUST be set via env in any shared/deployed environment.
    secret: process.env.BETTER_AUTH_SECRET ?? "varys-dev-insecure-secret-change-me",
    emailAndPassword: {
      // Toggled by VARYS_AUTH_METHODS (see resolveAuthMethods above).
      enabled: authMethods.emailPassword,
      // No email-verification mail flow is in scope (DESIGN §11) — accounts are usable
      // immediately on sign-up.
      requireEmailVerification: false,
    },
    // Browser origins permitted to call the auth endpoints (CSRF origin check). The web
    // dev origin + the API's own origin.
    trustedOrigins: (
      process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "http://localhost:5200,http://localhost:4000"
    )
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  });
}

let _auth: ReturnType<typeof createAuth> | null = null;

/**
 * The better-auth instance, built lazily on first use.
 *
 * Lazy is load-bearing: the instance binds a Postgres pool from
 * `process.env.DATABASE_URL`, which the E2E harness sets *after* importing this module
 * (Testcontainers spins the DB up in `beforeAll`). Eager construction would bind the
 * wrong DB and every guarded request in tests would fail to resolve its session.
 * `main.ts` sets `DATABASE_URL` before first use too, so lazy is correct everywhere.
 */
export function getAuth() {
  _auth ??= createAuth();
  return _auth;
}
