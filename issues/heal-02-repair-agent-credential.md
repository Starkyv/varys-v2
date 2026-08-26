# Slice 02 — Repair Agent credential: a second issuer on `/mcp`

**Type:** AFK · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** none

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

An unattended process can authenticate to `/mcp` without a browser. Per
[ADR-0005](../docs/adr/0005-scoped-repair-agent-credential.md), this is a **second way to produce
a principal, not an exemption from producing one** — so every downstream ownership check,
`created_by` write, and audit record keeps working untouched.

An admin provisions a named credential; presenting it resolves to a service principal
(`agent:…`) at the single existing auth choke point. Tool availability is gated on the
principal's kind: an agent principal may reach the repair/triage toolset and nothing else.

The safeguard is **scope, not secrecy**. An agent credential must be refused for opening an
Authoring Session, for any test outside a job it has claimed, and — permanently, per DESIGN.md §4
— for approving a baseline. Claiming lands in slice 03; this slice establishes the identity and
the refusals.

Management surface: label, expiry, `last_used_at`, one-click revocation.

Attended per-user OAuth ([ADR-0002](../docs/adr/0002-mcp-oauth-per-user.md)) must be entirely
unaffected — adding machine access must not disturb humans.

## Acceptance criteria

- [x] An admin can provision a named credential with an expiry, and see it listed
- [x] Presenting it on `/mcp` resolves to a service principal with a stable id and label
- [x] The credential is **refused** for opening an Authoring Session
- [x] The credential is **refused** for reading or editing any test (no job claimed yet)
- [x] The credential is **refused** for approving a baseline
- [x] An expired credential is refused; a revoked credential is refused immediately
- [x] `last_used_at` updates on use and is visible in the management surface
- [x] An unknown or malformed agent token returns the same response as an unknown OAuth token — agent tokens cannot be probed for
- [ ] Existing per-user OAuth `/mcp` behaviour is unchanged, proven by the existing auth E2E still passing untouched
- [ ] Repaired-version attribution reads the agent's label, not a human's name (asserted once wiring exists in slice 04)

## Blocked by

None - can start immediately. Parallel with slice 01.

## What was built

- `agent_credentials` table (`packages/db`): label, SHA-256 of the token only, a 4-char hint,
  mandatory `expires_at`, `revoked_at`, `last_used_at`, `created_by`.
- `apps/api/src/agent-credentials/` — provision (returns the token exactly once), list, revoke,
  and `resolve()`, which is what `/mcp` calls per request and which writes `last_used_at`.
- `McpAuthService` gained the second issuer: a bearer token prefixed `varys_agent_` routes to the
  credential store and yields `{ id: 'agent:<credId>', kind: 'agent', name/email: 'Repair Agent
  "<label>"' }`. The OAuth branch is entered only when the prefix does not match, so the human
  path is byte-for-byte the code it was.
- `McpController`: `AGENT_TOOLS` filters `tools/list` **and** `tools/call` from one place, so a
  tool an agent cannot list is a tool it cannot call (and reads as "Unknown tool", not as a
  refusal that confirms it exists). `AGENT_TEST_SCOPE` declares which arguments name a test, and
  `assertAgentScope` refuses any test not covered by a claim the agent holds.
- `RepairJobsService.hasClaimOn` / `testIdForRun` — the real claim query, not a stub. Nothing
  writes `claimed_by` until slice 03, so it answers `false` today, which IS this slice's refusal.
- Configurations page: a "Repair Agent credentials" card — provision (label + days), the
  show-once token callout, and a list with status, expiry, last-used and one-click revoke.
- `apps/api/test/agent-credential.e2e.spec.ts` covers every criterion above.
- DESIGN.md §11 gained the machine-authentication bullet pointing at ADR-0005.

## Flags raised

- **The two unticked criteria.** (1) The auth E2E is genuinely untouched and the OAuth branch is
  only reachable when the agent prefix does not match — but per this repo's standing instruction
  the suites were not run, so "proven by the existing auth E2E still passing" is unverified.
  Please run `apps/api` E2E (`auth.e2e`, `authoring*.e2e`, `agent-credential.e2e`) before
  accepting. (2) Attribution is *wired* — the agent principal's `email`/`name` are
  `Repair Agent "<label>"`, which is what `created_by` receives — but there is nothing to assert
  it against until slice 04 writes a repaired version, so the box stays open by the ticket's own
  wording.
- **"Admin" is any signed-in user.** DESIGN §11 is a flat authz model with no roles, so
  provisioning sits behind the ordinary session guard like every other setting. If provisioning
  machine access should be narrower than "anyone who can log in", that is a role decision this
  slice deliberately did not invent.
- **`failed_runs` is excluded from the agent toolset** — a judgement call, not a spec line. It is
  a cross-test read of every test's recent failures, and a drainer is handed its work by the job
  it claimed. If slice 03's drainer turns out to need it to find its own run, put it back *behind*
  the claim check rather than in front of it.
- **Mounted at `/settings/agent-credentials`, not a new top-level prefix** — deliberately, so no
  Vite dev-proxy / ingress entry is needed (the CLAUDE.md trap). It also reads correctly: it is a
  settings screen.
- **An agent still receives the human authoring `instructions` on `initialize`.** Harmless (they
  describe tools it cannot call) but noisy for the model. Worth a repair-specific prompt when
  slice 04 gives the agent something to actually do.
- **Frontend-literate eyes wanted on the token callout.** The token is held in component state and
  lost on reload, by design. The copy says so, but whether that reads as a warning or as a bug is
  a design call.

## Promotion candidates

None. The credentials card is one feature-specific form on the Configurations page with a single
caller, and it speaks feature vocabulary (Repair Agent, claim, revoke) throughout.
