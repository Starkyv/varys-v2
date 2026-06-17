import { createAuthClient } from "better-auth/react";

/**
 * better-auth browser client for Varys's OWN user authentication (who can use Varys),
 * distinct from the per-environment app-under-test login vault.
 *
 * Same-origin: the SPA and the API share an origin (the Vite dev proxy forwards
 * `/api/auth` → :4000 locally; one ingress in prod), so the httpOnly session cookie
 * rides along automatically — no `baseURL` needed, and the cookie is never read from JS.
 */
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;

/** Which sign-in methods the server has enabled (driven by `VARYS_AUTH_METHODS`). */
export interface AuthMethods {
  emailPassword: boolean;
  google: boolean;
}

/** Read the enabled methods so the login screen renders only what the server accepts.
 *  Cached after the first successful read — it's static per deploy, so Login remounts
 *  (and StrictMode's double-invoke) don't re-hit it. Falls back to email/password (the
 *  safe default) if the config can't be read. */
let authMethodsCache: AuthMethods | null = null;
export async function fetchAuthMethods(): Promise<AuthMethods> {
  if (authMethodsCache) return authMethodsCache;
  try {
    const res = await fetch("/auth-config");
    if (!res.ok) return { emailPassword: true, google: false };
    authMethodsCache = (await res.json()) as AuthMethods;
    return authMethodsCache;
  } catch {
    return { emailPassword: true, google: false };
  }
}
