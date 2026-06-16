/**
 * Env-driven sign-in domain policy (Slice 10 / Issue 3). Pure + unit-tested — the
 * authoritative allow/deny rule the better-auth hooks call, so the policy can be
 * verified without a live Google flow.
 *
 *  - `VARYS_AUTH_ALLOWED_DOMAINS` — comma list of permitted email domains
 *    (default `datagenie.ai`; empty = no restriction).
 *  - `VARYS_AUTH_DOMAIN_SCOPE` — `google` (default; restrict only SSO) | `all`
 *    (restrict every sign-up, email/password included).
 */
export type DomainScope = "google" | "all";

export interface DomainPolicy {
  allowedDomains: string[];
  scope: DomainScope;
}

export function parseDomainPolicy(env: NodeJS.ProcessEnv = process.env): DomainPolicy {
  const allowedDomains = (env.VARYS_AUTH_ALLOWED_DOMAINS ?? "datagenie.ai")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const scope: DomainScope = env.VARYS_AUTH_DOMAIN_SCOPE === "all" ? "all" : "google";
  return { allowedDomains, scope };
}

/** The lowercased domain part of an email (`""` if malformed). */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/**
 * Is this sign-in allowed under the policy?
 *  - No allowed domains configured → always allowed (unrestricted).
 *  - `provider !== "google"` and `scope === "google"` → allowed (email/password is not
 *    restricted in the default "only SSO" scope).
 *  - otherwise → the email's domain must be in the allow-list.
 */
export function isSignInAllowed(
  email: string,
  provider: "google" | "credential" | (string & {}),
  policy: DomainPolicy,
): boolean {
  if (policy.allowedDomains.length === 0) return true;
  if (provider !== "google" && policy.scope === "google") return true;
  return policy.allowedDomains.includes(emailDomain(email));
}
