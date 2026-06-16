# Varys v2

Visual-regression test automation: **record → replay → diff**. Record a flow with a Chrome
extension, replay it server-side with Playwright, and diff element screenshots against an
approved baseline per environment.

- Full design: [`DESIGN.md`](./DESIGN.md)
- MVP spec + issues: [`prd/mvp.md`](./prd/mvp.md), [`issues/mvp.md`](./issues/mvp.md)
- Visual Review UI: [`prd/visual-review-ui.md`](./prd/visual-review-ui.md), [`issues/visual-review-ui.md`](./issues/visual-review-ui.md)

## Prerequisites

- **Node ≥ 22** and **pnpm 10** (`packageManager` is pinned)
- **Docker** running (Postgres comes up via `docker compose`)

```bash
pnpm install
pnpm --filter @varys/runner exec playwright install chromium   # one-time, for the worker
```

## Run the app

Two terminals — or just two commands.

**1. Start Postgres** (runs on host port **5433**, to avoid clashing with a local Postgres):

```bash
pnpm db:up        # docker compose up -d --wait  (blocks until the DB is healthy)
```

**2. Start the services** — API + worker + web, one command:

```bash
pnpm dev
```

| Service | URL | What it is |
|---|---|---|
| Web (review UI) | http://localhost:5200 | React SPA — diff viewer + approve/reject + needs-review list |
| API | http://localhost:4000 | NestJS — tests, runs, environments, artifacts, decisions |
| Worker | — | Playwright replay worker, consumes the run queue |

The schema is applied automatically on API startup. The web dev server proxies API calls to
`:4000`, so it's all same-origin (no CORS).

> If port 5200 is taken, Vite picks the next free port and prints the actual URL — use that.

**3. Open** http://localhost:5200 — **sign in** (the first time, create an account with email +
password) and you land on the **Dashboard**.

**Stop:** `Ctrl-C` the `pnpm dev` terminal; `pnpm db:down` stops Postgres.

> **Overrides** (defaults shown): `DATABASE_URL=postgres://varys:varys@localhost:5433/varys`,
> `VARYS_STORAGE_DIR=../../.varys-artifacts` (shared by API + worker), API `PORT=4000`.
>
> **Auth** (Varys's own user login — better-auth, Slice 10): `BETTER_AUTH_SECRET` (session signing
> key — a dev fallback is used locally; **set a real one in any shared/deployed env**),
> `BETTER_AUTH_URL=http://localhost:5200` (the public origin the browser reaches `/api/auth` at).
> `VARYS_AUTH_METHODS=password` (comma list — `password`, `google`, or `password,google`) selects which
> sign-in methods are enabled. Google SSO (Slice 10 / Issue 3) adds `GOOGLE_CLIENT_ID` /
> `GOOGLE_CLIENT_SECRET`, plus an env-driven domain restriction: `VARYS_AUTH_ALLOWED_DOMAINS`
> (default `datagenie.ai`) and `VARYS_AUTH_DOMAIN_SCOPE` (`google` | `all`).

## Create and review a test

1. **Build + load the recorder extension:**

   ```bash
   pnpm --filter @varys/extension build
   ```

   Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** →
   `apps/extension/.output/chrome-mv3`.

2. **Record:** click the **Varys toolbar icon** — a small panel appears *in the page* and stays put
   while you work (it's an overlay, not a popup, so clicking the page won't dismiss it). Then:
   - **Start recording** — now every click and typed value on the page is captured automatically
     (origin → `{{baseUrl}}`, password fields → `{{secret:…}}`); the panel shows a live action count.
   - **📷 Capture screenshot** — press it, then click the element you want to snapshot. Do this
     whenever you want, as many times as you want, in between normal interactions (Esc cancels).
   - **Save test** — posts the recorded definition to the API; the panel shows the new test id.

3. **Run it:** open http://localhost:5200 → **Tests** tab → your recording is listed → click
   **Run**. (Saving only stores the recording; a run is what produces something to review.)

4. **Review:** the checkpoint appears under **Needs review** (the queue auto-refreshes as the run
   finishes) → open it → compare baseline / actual / diff → **Approve** (first approval, or replace
   the baseline — behind an irreversible-confirm) or **Reject**.

## Run the tests

The suites drive the whole stack (real Postgres via testcontainers, real headless Chromium,
local-FS storage) — no live services needed.

```bash
pnpm -r typecheck

# Backend lifecycle: seed → approve → diff → reject → masking → waits → login/secrets → needs-review
pnpm --filter @varys/api test

# Visual Review UI: component tests (MSW) + a browser E2E driving the real built SPA
pnpm --filter @varys/web test
pnpm --filter @varys/api exec vitest run test/review-ui.e2e.spec.ts

# Pure-core unit suites
pnpm --filter @varys/diff-engine      test   # pixel diff + masking
pnpm --filter @varys/locator-engine   test   # ranked fingerprint matcher
pnpm --filter @varys/capture          test   # DOM element → fingerprint
pnpm --filter @varys/variable-resolver test   # {{baseUrl}} / {{secret:…}} resolution
pnpm --filter @varys/recorder         test   # interactions → step definition
```

> Each API spec runs in its own process. Running the whole workspace's browser tests at once
> (`pnpm -r test`) can flake under resource contention — prefer per-package as above.

## Project layout

```
apps/
  api/         NestJS API — tests, runs, environments, artifacts, approve/reject, needs-review
  worker/      Playwright replay worker (consumes the pg-boss queue)
  web/         React SPA — tests list + run, diff viewer (side-by-side / overlay), approve/reject, needs-review list
  extension/   WXT MV3 recorder extension
packages/
  review-contract/   shared typed read-model the API and web SPA agree on (pure types)
  step-schema/       versioned test-definition contract (zod)
  capture/           DOM element → multi-signal fingerprint
  recorder/          page interactions → step definition
  locator-engine/    ranked fingerprint → live-page locator (resolve / heal / not-found)
  diff-engine/       pixelmatch diff + region masking
  variable-resolver/ {{baseUrl}} / {{var}} / {{secret:…}} substitution
  storage-adapter/   artifact storage (local FS; Azure/S3 later)
  db/                Drizzle schema + DDL (Postgres)
  queue/             pg-boss helpers
  fixture-app/       deterministic in-repo target app for tests
```

## Known gaps

- Runs are triggered manually (the **Run** button); no scheduling/CI trigger yet.
- Single trusted operator; auth/RBAC is a later slice.
- Secret values are plaintext in the DB for local/single-tenant use — never returned by the API,
  resolved only transiently in the worker. At-rest encryption is deferred to the hosted reality.
