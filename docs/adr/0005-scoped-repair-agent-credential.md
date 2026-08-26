# A scoped Repair Agent credential for unattended `/mcp` access

`McpAuthService.principal()` gains a **second issuer**: alongside the OAuth bearer tokens
ADR-0002 issues to humans, an admin may provision a long-lived, revocable, expiring **Repair
Agent** token that resolves to a service principal (`id: 'agent:…'`). It is restricted to the
repair/triage toolset and to tests covered by a job it has claimed. It is not an exemption —
it produces a real `McpPrincipal`, so every downstream ownership check, attribution write and
claim record works unchanged.

## Context

ADR-0002 explicitly **rejected** per-user static API tokens, so a reader who finds this one
will assume it is a regression. It is not: ADR-0002's three objections were aimed at humans
configuring their own Claude Code, and none of them survive contact with an unattended drainer.

- *"Every user hand-copies a long-lived secret into a config file that tends to get
  committed."* One admin provisions one agent. There is no per-user workflow to degrade.
- *"There is no expiry or revocation story."* That was a critique of the proposal as specced,
  not of the mechanism. This credential has expiry, revocation and `last_used_at`, surfaced in
  Settings.
- *"Strictly worse than a flow the client already speaks."* Backwards here. The drainer cannot
  speak that flow: better-auth's `mcp` plugin requires an authorization-code + PKCE leg through
  a browser, and the whole premise of ADR-0002 is that the browser leg *is* the identity proof.
  A cron container has no browser and no human to click authorize.

So this fills a gap ADR-0002 did not consider — machine access — rather than reversing it.

An **exception** was considered and rejected outright. Nothing in an HTTP request proves "I am
Claude Code": a `User-Agent` is a string anyone can send, and the DCR `clientId` only exists
after authentication. An exception keyed on "it's Claude Code" is an exception keyed on nothing,
which is exactly the unauthenticated `/mcp` that ADR-0002 was written to close. It would also
break three decisions that depend on a real identity: per-user isolation, `created_by` on the
repaired version, and the record of who claimed a job.

## Considered options

- **(Chosen) Scoped service credential, second issuer.** Keeps the live Repair Session — so
  multi-step repairs (a new confirmation dialog, a changed flow) remain possible — at the cost
  of a long-lived secret that can reach the MCP surface.
- **(Rejected, but close) Stateless repair bundle.** Varys drives to the failure in its own
  pinned browser and offers Claude a set of candidate elements with fingerprints already
  extracted; Claude answers "which one". Two narrow endpoints instead of all of `/mcp`, no
  OAuth, no lease, and a leaked token could only read snapshots and propose a fingerprint —
  never drive a browser through authenticated staging. Rejected because it cannot handle
  repairs where the *flow* changed rather than an element moving. Worth revisiting if the real
  failure distribution turns out to be dominated by simple element moves.
- **(Rejected) Rely on `offline_access` + rotating refresh.** No new attack surface at all: a
  human clicks authorize once on the drainer box, and better-auth rotates a fresh 7-day refresh
  window on every use, which any polling drainer clears easily. Rejected as the primary
  mechanism because it depends on an unverified fact — whether Claude Code requests the
  `offline_access` scope. Without it the access token dies after one hour with no refresh path
  (`better-auth@1.6.19` mcp plugin: `accessTokenExpiresIn: 3600`, `defaultScope: "openid"`,
  and the refresh grant hard-rejects tokens lacking `offline_access`).

## Consequences

- The credential's **scope is the safeguard**, not its secrecy. It must be unable to
  `open_session`, edit tests outside a claimed job, or approve a baseline — the last of which
  is non-negotiable, since DESIGN.md §4 deletes the previous baseline with no rollback.
- Blast radius is honestly larger than the alternative: a leaked agent token can drive a
  browser through the customer's authenticated staging environment. Short expiry, visible
  `last_used_at`, and one-click revocation are load-bearing, not nice-to-have.
- Attribution reads `repaired by Repair Agent "<label>"`, which is more truthful than borrowing
  a human's identity.
- ADR-0002 stands; this amends its scope. Its rejection of static tokens remains correct for
  interactive human clients, which is what it was about.
