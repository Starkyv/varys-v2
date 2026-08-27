# Per-user MCP auth: OAuth 2.1 on `/mcp`, sessions owned by the authenticating user

The authoring MCP server authenticates every request with an **OAuth 2.1 bearer token**
(dynamic client registration + PKCE, issued by better-auth's `mcp` plugin, which makes the
Varys API its own authorization server). The token resolves to a real Varys user, and that
identity — never a tool argument — owns the Authoring Session it opens. Sessions, the
live-preview stream, the "Claude Code connected" indicator, and draft attribution are all
scoped to it.

## Context

`/mcp` was `@Public()` and entirely unauthenticated, with a single process-global
`lastSeenAt` for activity and a single unkeyed session map. Consequences: anyone's Claude
Code traffic lit up *every* user's connected indicator, every user could list — and stream
the live browser of — every other user's session, any client could drive a session it did
not open, and drafts were attributed to the literal string `"ai"` with no idea who asked
for them. On a shared deployment that is a cross-tenant leak, not just a cosmetic bug.

## Considered options

- **(Chosen) OAuth 2.1 via better-auth's `mcp` plugin.** The protocol MCP clients already
  implement: Claude Code discovers the authorization server from a 401's
  `WWW-Authenticate` + the root `.well-known` documents, self-registers via DCR, runs the
  PKCE flow in the user's browser, and sends a bearer token thereafter. Zero-configuration
  for the user (no tokens to copy), reuses the same better-auth user table as the web
  session, and the browser leg *is* the identity proof. Costs three plugin-owned tables and
  a login-handoff route in the SPA.
- **(Rejected) Per-user static API tokens.** A token minted in the web UI and pasted into
  `.mcp.json`. Simpler server-side, but every user hand-copies a long-lived
  secret into a config file that tends to get committed, there is no expiry or revocation
  story, and it is strictly worse than a flow the client already speaks.
- **(Rejected) Keep `/mcp` anonymous, scope by a client-supplied user id.** Cheapest to
  build and the isolation would *look* right in the UI, but the "identity" is an
  unauthenticated string the model or any HTTP client can set to anyone's id — it
  reorganizes the leak rather than closing it.

## Consequences

- `/mcp` is no longer reachable without a token. An existing
  `claude mcp add --transport http varys …` entry keeps working but re-authenticates once,
  in the browser. Point it at the **web origin**, not the API port, so the token's issuer
  and resource match the origin the user signs in on.
- Ownership is enforced at one choke point: every tool except `open_session` addresses a
  session by id, so `callTool` verifies ownership once for all of them. Cross-user access
  returns the *same* not-found as an unknown id, so session ids can't be probed for.
- `McpStatusService` is keyed by user id, and the live-preview routes take the signed-in
  user. The MCP bearer token and the web cookie resolve to the same better-auth user, which
  is what lets a human watch the session their own Claude Code opened.
- Drafts authored over MCP carry the user's email in `created_by` (was `"ai"`).
- The web app grows one non-navigable route (`/oauth/authorize`) that exists only to bounce
  the post-login browser back to the authorize endpoint with its OAuth query intact.

## Amendment (ADR-0005)

The rejection of static tokens above holds for **interactive human clients**, which is what
this ADR is about. It does not cover **unattended machine access**: a drainer on a cron has no
browser and cannot complete the authorization-code + PKCE leg that this decision rests on.
ADR-0005 adds a scoped, revocable, expiring **Repair Agent** credential as a second issuer in
`McpAuthService.principal()` for that case. It is a second way to produce an `McpPrincipal`,
not an exemption from producing one, so every isolation and attribution consequence listed
above still applies.
