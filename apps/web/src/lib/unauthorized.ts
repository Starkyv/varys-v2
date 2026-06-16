/**
 * Session-expiry handling. The API is deny-by-default (Slice 10 / Issue 2): once a
 * session expires or is missing, guarded calls return 401. We intercept fetch once at
 * startup and broadcast `varys:unauthorized` on any 401 — <SessionGate> listens, re-checks
 * the session, and flips the app back to the Login screen.
 *
 * `/api/auth/*` is skipped: a failed sign-in legitimately returns 401 and is the Login
 * screen's own concern, not a session-expiry redirect.
 */
export const UNAUTHORIZED_EVENT = "varys:unauthorized";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function installUnauthorizedRedirect() {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    if (res.status === 401 && !urlOf(input).includes("/api/auth")) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    return res;
  };
}
