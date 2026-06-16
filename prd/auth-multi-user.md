# PRD — Varys v2 Slice 10: Auth & multi-user

> Slice 10 of the roadmap in `DESIGN.md` §14 (§11 Authentication & authorization). Varys is a
> **hosted multi-user service** but ships today with **no auth at all** — every API route is world-
> open and entities are flat/global. This slice puts a real identity in front of the product:
> **email/password + Google SSO (domain-restricted)**, httpOnly cookie sessions, a global auth gate,
> and **real user identity wired into the existing audit fields**. **Depends on:** nothing (an
> independent slice; touches every app but adds no behaviour to the record→run→diff loop).
>
> **Scope is deliberately bounded by four locked decisions (design interview, this slice):**
> 1. **Both** auth methods ship: **email/password + Google SSO**, domain-restricted to `datagenie.ai`.
> 2. **Library = `better-auth`** — a proven, TS-native, framework-agnostic library that owns its own
>    tables (no hand-rolled crypto/sessions; OIDC-ready), per DESIGN §11 "never hand-rolled".
> 3. **Tenancy = bare minimum** — `users` + `sessions` + the auth gate only. **No `org_id`/`project_id`
>    stamping, no Org/Project/Member entities, no `role` column.** Entities stay flat/global (a single
>    implicit org). Multi-tenant isolation and RBAC role-gating remain **deferred** (DESIGN §11).
> 4. **Non-browser clients reuse the browser session cookie** — the Chrome extension piggybacks on the
>    logged-in web session; **the `/mcp` authoring endpoint stays unauthenticated this slice** (Claude
>    Code is a separate process with no browser cookie, and per-client tokens were declined — see
>    Out of Scope and the accepted risk below).
>
> **Testing posture (per established direction):** **one compact chromium-free API E2E** (`auth.e2e`)
> pins the externally observable gate (unauth → 401, signed-in → 200, sign-out → 401, exempt routes
> reachable) and the audit-attribution write; **zero UI/component tests** — the login screen,
> 401-redirect, user menu, and the live Google round-trip are the **manual click-through gate**. Prior
> art: `apps/api/test/tests.e2e.spec.ts`, `runs.e2e.spec.ts` (supertest + Testcontainers Postgres).

---

## Problem Statement

Varys is designed as a hosted, multi-user service, but right now it has **no authentication and no
users**. Every route on the API (`/tests`, `/runs`, `/environments`, `/dashboard`, …) is reachable by
anyone who can reach the server; environment **login secrets for the apps under test** are creatable
and editable by anybody; and every audit field that should say *who did this* — who approved a
baseline (an explicitly **irreversible** action, DESIGN accepted-risk #1), who edited a test version —
stores a free-text placeholder (`"system"` / null) because there is no identity to record. The
product cannot be deployed anywhere network-reachable, two people cannot tell each other's actions
apart, and the one human gate on the system (baseline approval) is unattributable. Before anything
else ships to a shared environment, Varys needs a real front door and a real notion of "who".

## Solution

A real identity layer, scoped to exactly what a single-org internal tool needs:

- **Sign in two ways** — email/password, and **Google SSO restricted to the `datagenie.ai` domain**
  (a Google account outside the domain is rejected). Both run through **`better-auth`**; no
  hand-rolled password hashing, session management, or OAuth.
- **httpOnly cookie sessions** — the session lives in a secure, httpOnly cookie the SPA never reads
  from JS. The web app and API are same-origin (Vite proxy in dev, one ingress in prod), so the
  cookie rides along on every fetch with no token plumbing.
- **A global auth gate** — the API flips to **deny-by-default**: every route requires a valid session,
  with a small, explicit allowlist (the auth routes themselves, the self-hosted `/trace-viewer`
  assets, and — this slice only — `/mcp`). The SPA redirects to a **login screen** on a 401 and shows
  **who you're signed in as** (with sign-out) in the app shell.
- **The recorder extension keeps working** — already signed into the web app in the same browser, the
  extension reuses that **session cookie** to save recordings; no separate extension login.
- **Audit becomes real** — the signed-in user is wired into the existing audit fields
  (`baselines.approvedBy`, `test_versions.createdBy`), so "who approved this baseline / edited this
  test" is a real person instead of `"system"`.

Everything stays **flat and single-org**: no `org_id` stamping, no projects, no roles. Those are a
later flip (DESIGN §5/§11), and this slice deliberately doesn't pay for them.

## User Stories

1. As an org member, I want to sign in with an email and password, so that I can access Varys with a personal account.
2. As an org member, I want to sign in with my Google (`datagenie.ai`) account, so that I don't have to manage a separate Varys password.
3. As an admin, I want Google sign-in **restricted to the `datagenie.ai` domain**, so that anyone with any Google account can't get in.
4. As a security-conscious user, I want my session held in an **httpOnly** cookie, so that my session token is never exposed to page JavaScript.
5. As a user, I want to **sign out**, so that I can end my session on a shared machine.
6. As a user, I want every API route to **reject unauthenticated requests**, so that Varys data and the app-under-test login secrets aren't world-readable.
7. As a user, I want to be **redirected to a login screen** when my session is missing or expired, so that I always know I need to sign in rather than seeing a broken page.
8. As a user already signed into the web app, I want the **recorder extension to save recordings without a separate login**, so that recording stays a single step.
9. As a reviewer, I want a **baseline approval to record who approved it** (my real identity, not `"system"`), so that the irreversible-approval audit trail is meaningful.
10. As an editor, I want a **saved test-config edit to record who made it**, so that version history attributes changes to a person.
11. As a user, I want the app shell to **show who I'm signed in as** and where to sign out, so that I can confirm my identity at a glance.
12. As a developer, I want auth handled by a **proven library** (`better-auth`), not hand-rolled, so that password/session/OAuth security isn't my own bug surface.
13. As an operator, I want the auth **tables added via the existing bootstrap DDL** and the secrets configured via **env vars**, so that the local stack still comes up with one command and no secret is committed.
14. As a Claude/MCP user, I want the `/mcp` authoring endpoint to **stay reachable from Claude Code** this slice, so that AI authoring keeps working while per-client tokens are out of scope (an accepted, documented gap).
15. As a developer, I want the existing API E2Es to keep passing once the gate is on, so that turning on auth doesn't silently break the test suite (the harness establishes a session like a real client).

## Implementation Decisions

### Library, session model & schema

- **`better-auth`** is the auth library (DESIGN §11 "proven library, never hand-rolled; OIDC-ready").
  It owns its own tables, provides email/password + social (Google) + session management, and exposes
  a framework-agnostic **request handler** we mount on the existing `NestExpressApplication`.
- **Sessions are httpOnly cookies**, not JWT-in-localStorage. The SPA and API are same-origin (Vite
  proxy `:5200 → :4000` in dev; one ingress in prod), so the cookie is sent automatically by the
  browser on every same-origin fetch — no `Authorization` header plumbing in the web app.
- **Schema via the bootstrap DDL.** This repo applies a raw `DDL` string at API boot (`main.ts` →
  `@varys/db`'s `DDL`), not drizzle-kit migrations. better-auth's tables (`user`, `session`,
  `account`, `verification`) are generated **once** with better-auth's schema-generate CLI and the
  resulting `CREATE TABLE … IF NOT EXISTS` statements **pasted into the bootstrap `DDL`** (additive,
  idempotent) — matching the repo's walking-skeleton convention. **Restart `pnpm dev` after** this DDL
  lands (the slice's only schema change). better-auth is pointed at the same Postgres pool.

### Routing & the Vite-proxy gotcha

- **The API has no global prefix** (routes are top-level: `/tests`, `/runs`, …), so better-auth's
  handler mounts cleanly at **`/api/auth/*`** without colliding with existing controllers.
- **Add `/api/auth` to the Vite dev proxy allowlist** (`apps/web/vite.config.ts`) — this is the
  CLAUDE.md gotcha: a top-level path not in the allowlist falls through to the SPA and returns
  `index.html` ("the API returned HTML"). The login round-trip dies silently otherwise.
- Env config (never committed): `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (the public origin),
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Documented in the README run guide + `docker-compose`.

### The global gate & allowlist

- A **global auth guard** (Nest `APP_GUARD`) resolves the better-auth **session from the request
  cookie** on every request, attaches the resolved `user` to the request object, and returns **401**
  when there is no valid session. The API is **deny-by-default**.
- **Allowlist (the only unauthenticated routes):**
  - `/api/auth/*` — the auth handler itself (sign-in/up/out, OAuth callback, session).
  - `/trace-viewer/*` — the self-hosted Playwright trace-viewer static assets (the same-origin "Open
    timeline" link; static bundle, no data).
  - `/mcp` — **this slice only**, per the locked decision (Claude Code has no browser cookie; tokens
    declined). Documented as an accepted risk.
  - A tiny public **`GET /health`** is added for liveness (there is no health route today) and exempted.
- The decorator/metadata gotcha applies: any new provider (the guard, the auth service/config
  provider) uses **explicit `@Inject(...)`** — esbuild emits no decorator metadata in this repo, so
  implicit DI silently fails to boot the dev server even when tests are green.

### Web wiring

- A **login screen** (a public route the 401-redirect lands on): email/password form **+ a "Sign in
  with Google" button**. Built on `@varys/ui` (Nexus) to match the shell.
- **Session bootstrap**: a `useSession()` hook (better-auth's client, or a `whoami` query) gates the
  app — while unknown, show a splash; if unauthenticated, render the login screen; if authenticated,
  render the app.
- **401 → redirect**: the TanStack Query/fetch layer treats a 401 as "session gone" → route to login
  (no toast spam, no half-rendered data).
- **User menu + sign-out** in the existing app shell **`TopBar`** — shows the signed-in email/name and
  a sign-out action that clears the session and returns to login.
- Web fetches stay **same-origin** (`API_BASE=""`), so the cookie is sent automatically; **no change
  to existing fetch call sites** beyond the 401 handling.

### Configurable sign-in methods (env-driven)

- **`VARYS_AUTH_METHODS`** — a comma list of enabled methods (`password`, `google`, or
  `password,google`; default `password`). The **server is the source of truth**: `auth.ts` configures
  better-auth from it, and the SPA renders only the enabled methods (read from a public
  `GET /auth-config`). A **lockout guard** keeps email/password on if the config would otherwise leave
  no usable method. *(Scaffolded in Issue 1; the `google` branch goes live in Issue 3.)*

### Google SSO — env-driven domain restriction

- Configure better-auth's **Google social provider**, gated on `VARYS_AUTH_METHODS` including `google`
  + `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` present. A first valid sign-in **auto-provisions** the
  user (no invite flow this slice).
- The **domain restriction is itself configurable** (per user direction), not hardcoded to one domain:
  - **`VARYS_AUTH_ALLOWED_DOMAINS`** — comma list of permitted email domains (default `datagenie.ai`;
    empty = unrestricted). A sign-in whose email domain (or Google `hd` claim) isn't listed is rejected.
  - **`VARYS_AUTH_DOMAIN_SCOPE`** — `google` (default; restrict only SSO, per DESIGN §11) or `all`
    (restrict every sign-up, email/password included).
  - The allow/deny rule is a **pure predicate** (unit-tested without a live Google flow).

### Extension auth — the chosen cookie-reuse path **and its known risk**

- The extension keeps its hardcoded API base and adds **`credentials: 'include'`** to its
  `POST /tests` (and any other API) calls so the session cookie is sent. The API enables **CORS with
  `credentials: true` for the extension origin** (`chrome-extension://<id>`) — `*` is not allowed with
  credentials.
- **Known risk (flagged, chosen knowingly):** the extension is **cross-origin** to the API
  (`chrome-extension://…` → the API origin), so the session cookie must be **SameSite=None; Secure** to
  be sent on the extension's cross-site request — which means HTTPS, and is awkward over `http://
  localhost` in dev. **Build must verify the cookie actually reaches the API from the extension**, and
  if SameSite blocks it, the **fallback is `chrome.cookies` with a host permission**: the extension
  reads the session cookie for the API origin and attaches it explicitly. This is the one genuinely
  fiddly integration point of the slice and is called out so the build can adapt without re-scoping.

### Audit surfacing

- Replace the free-text placeholders with the **resolved signed-in user** (id and/or email):
  - `baselines.approvedBy` / `approvedAt` — set from the approving user on baseline approval (today
    these are written by the approve path; point them at `request.user`).
  - `test_versions.createdBy` — set from the editing user when a new version is written (today `"system"`
    for in-viewer mask/threshold persists, null for the original recording).
- **Surface it** where it already shows: the approve/confirm dialog's audit line and the run/version
  history read-model carry the real identity instead of `"system"`. No new audit *table* this slice —
  this is wiring identity into the fields that already exist.

### Constraints / environment facts

- **No `role` column, no `org_id`/`project_id`, no Org/Project/Member tables** (locked: bare minimum).
  Entities stay flat/global; a single implicit org.
- **`/mcp` stays unauthenticated** this slice (accepted risk).
- Additive DDL only (`IF NOT EXISTS`); **restart `pnpm dev`** after the auth tables land.
- Ports unchanged: API `:4000`, web `:5200`, Postgres `:5433`.
- Repo rules: no `Co-Authored-By` trailer in commits; commit to `main` only when asked.

## Testing Decisions

- **What a good test pins here:** the externally observable **gate** and **attribution**, through the
  HTTP API against a real Postgres — never better-auth's internals (no asserting on hash formats,
  cookie crypto, or internal call order).
- **One chromium-free API E2E** (`apps/api/test/auth.e2e.spec.ts`; supertest + Testcontainers, prior
  art `tests.e2e` / `runs.e2e`) asserts:
  1. **Deny-by-default** — a request to a representative gated route (`GET /tests`) **without** a
     session → **401**.
  2. **Round-trip** — sign-up + sign-in via `/api/auth/*` yields a session cookie; the same gated
     route **with** the cookie → **200**; sign-out → the route is **401** again.
  3. **Allowlist** — `/health` and `/mcp` are reachable **without** a session (and `/api/auth/*`
     works unauthenticated, as it must).
  4. **Audit attribution** — after an authenticated approve, `baselines.approvedBy` holds the **real
     user** (not `"system"`); a `test_versions` write carries the user in `createdBy`.
- **Domain restriction is unit-tested**, not E2E'd: the "is this email/`hd` in `datagenie.ai`?" predicate
  is exercised directly (allowed domain accepts, other domain rejects). The **live Google OAuth
  round-trip is manual** (a real Google flow can't be E2E'd here).
- **Existing E2Es must keep passing with the gate on.** Turning the API deny-by-default means every
  existing E2E now hits a gated route — the **shared test harness signs in once and reuses the session
  cookie** (exercising the real auth path), rather than a test-only guard bypass. Updating that harness
  is part of this slice's work and is the main regression surface.
- **No UI/component tests** (house posture): the login screen, the 401-redirect, the user menu /
  sign-out, the Google button, and the extension save-while-logged-in are the **manual click-through
  gate**.

## Out of Scope

- **RBAC / role-gating** — flat authz; **no `role` column** this slice (DESIGN §11 defers role-gating;
  the bare-minimum decision drops even the future-proofing seam — re-add later as a one-liner).
- **Multi-tenant isolation + `org_id`/`project_id` stamping + Org/Project/Member entities** — entities
  stay flat/global (DESIGN §5 keeps this a later flip). No tenant scoping of any read/write path.
- **Personal/API tokens** (declined) and therefore **`/mcp` authentication** — `/mcp` stays open this
  slice; the extension uses the browser cookie, not a token.
- **Email verification, password reset emails, MFA, account invitations/management UI** — DESIGN scopes
  out MFA explicitly; the rest are deferred (auto-provision on first valid sign-in is enough here).
- **OIDC providers beyond Google** — better-auth is OIDC-ready, but only Google is configured.
- **App-under-test login** — the *recorded login steps* + per-environment encrypted secret vault that
  log into the apps Varys *tests* are a **separate, existing** concern (DESIGN §2) and are untouched;
  this slice is about Varys's **own** user authentication.
- **A dedicated audit-log table / audit-viewer UI** — this slice wires identity into the **existing**
  audit fields; a first-class audit log is a later enhancement.

## Further Notes

- **Two different "auth" must not be conflated.** *This slice* = who can use **Varys**. The
  pre-existing per-environment secret vault + recorded login steps = how Varys logs into the **apps it
  tests**. They are unrelated; the vault is out of scope here.
- **The extension cookie-reuse is the slice's known risk** (cross-origin SameSite). The PRD commits to
  *verifying the cookie reaches the API during build* and to the **`chrome.cookies` host-permission
  fallback** if it doesn't — rather than discovering it at the end.
- **better-auth schema lands in the bootstrap DDL** to match the repo's "raw DDL stand-in for
  migrations" convention; use better-auth's generate CLI to get the exact DDL, then paste. When the
  schema settles (DESIGN §3 note), the whole DDL string can graduate to drizzle-kit migrations together.
- **The gate is a blast radius.** Flipping deny-by-default touches every client at once: the web app
  (needs the login screen + 401-redirect *before* the guard, or the app is unusable), the extension
  (cookie), the E2E harness (session), and `/mcp` (exempted). The issue ordering builds the login
  round-trip *first* and flips the guard *second* so the app is never left gated-without-a-door.
- **Issue-tracker note:** no tracker is configured in this repo (no remote / `gh`), so the
  `ready-for-agent` label could not be applied — consistent with prior slices. This PRD lives at
  `prd/auth-multi-user.md`; its tracer-bullet issues are in `issues/auth-multi-user.md`.
