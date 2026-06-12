# Varys v2

Visual-regression test automation: **record → replay → diff**. Record a flow with a Chrome
extension, replay it server-side with Playwright, and diff element screenshots against an
approved baseline per environment.

- Full design: [`DESIGN.md`](./DESIGN.md)
- MVP spec + issues: [`prd/mvp.md`](./prd/mvp.md), [`issues/mvp.md`](./issues/mvp.md)
- Visual Review UI slice: [`prd/visual-review-ui.md`](./prd/visual-review-ui.md), [`issues/visual-review-ui.md`](./issues/visual-review-ui.md)

> **Status:** the MVP **backend** (record-format → replay → baseline/diff → approve/reject →
> fingerprint locators → environments/variables/secrets → waits/masking/determinism) is complete
> and test-driven; the **recorder extension** is built; and the **Visual Review UI** (`apps/web` —
> a diff viewer with side-by-side ↔ diff-highlight modes, in-browser approve/reject behind an
> irreversible-confirm gate, and a "needs review" list) is complete and test-driven (MSW component
> tests + a Playwright browser E2E over the real stack). What's **not** wired yet is a one-command
> way to run the long-running services as a live app — so today you exercise Varys via its **test
> suites** (which drive the full stack, UI included) and the recorder **extension**.

## Prerequisites

- **Node ≥ 22** and **pnpm 10** (`packageManager` is pinned)
- **Docker** running — the integration tests spin up real Postgres via testcontainers
- A one-time Chromium download for Playwright

```bash
pnpm install
pnpm --filter @varys/runner exec playwright install chromium   # one-time
```

## See the engine work: run the tests

The test suites are the end-to-end demo — they record a definition, replay it in real headless
Chromium against an in-repo fixture app, diff against a baseline, and assert the result (real
Postgres via testcontainers, artifacts on the local-FS storage adapter).

```bash
# Type-check everything
pnpm -r typecheck

# The full backend lifecycle (seed → approve → diff → approve-replace / reject → masking → waits → login/secrets)
pnpm --filter @varys/api test

# The Visual Review UI: component tests at the HTTP boundary (MSW) + a browser E2E
# (Playwright drives the real built SPA against the real API/worker/Postgres/local-FS)
pnpm --filter @varys/web test                               # MSW component tests (jsdom)
pnpm --filter @varys/api exec vitest run test/review-ui.e2e.spec.ts  # browser E2E

# Pure-core unit suites
pnpm --filter @varys/diff-engine     test   # pixel diff + masking
pnpm --filter @varys/locator-engine  test   # ranked fingerprint matcher
pnpm --filter @varys/capture         test   # DOM element → fingerprint
pnpm --filter @varys/variable-resolver test # {{baseUrl}} / {{secret:…}} resolution
pnpm --filter @varys/recorder        test   # interactions → step definition
```

> Note: each API spec runs in its own process (`apps/api` test script) to keep heavy
> browser+container suites isolated. Running the *entire* workspace's browser tests at once
> (`pnpm -r test`) can flake under resource contention — prefer per-package as above.

## Try the recorder extension

```bash
pnpm --filter @varys/extension build
```

Then in Chrome: **`chrome://extensions` → enable Developer mode → Load unpacked →
`apps/extension/.output/chrome-mv3`**. Click the toolbar icon:

1. **Start recording** — interact with any page (clicks + typed values are captured; the origin
   becomes `{{baseUrl}}`, password fields become `{{secret:…}}`).
2. **Pick checkpoint** — click an element to designate it as a screenshot target.
3. **Save** — POSTs the recorded definition to the API (`http://localhost:3000/tests`).

Recording and picking work standalone; **Save** needs the API running (see below).

## Running the services locally (work in progress)

There is no single-command dev flow yet, and the long-running services aren't wired for `node`
execution (workspace packages currently expose TypeScript source, which the test runner handles
directly but a plain Node process does not). Standing up the API + worker for real local use —
plus a `docker compose` for Postgres and a `pnpm dev` orchestration — is a tracked follow-up.
Until then, the **test suites above are the way to exercise the full engine.**

## Project layout

```
apps/
  api/         NestJS API — tests, runs, environments, artifacts, approve/reject, needs-review
  worker/      Playwright replay worker (consumes the pg-boss queue)
  extension/   WXT MV3 recorder extension
  web/         React SPA — diff viewer (side-by-side / overlay), approve/reject, needs-review list
packages/
  review-contract/  shared typed read-model the API and web SPA agree on (pure types)
  step-schema/      versioned test-definition contract (zod)
  capture/          DOM element → multi-signal fingerprint
  recorder/         page interactions → step definition
  locator-engine/   ranked fingerprint → live-page locator (resolve / heal / not-found)
  diff-engine/      pixelmatch diff + region masking
  variable-resolver/ {{baseUrl}} / {{var}} / {{secret:…}} substitution
  storage-adapter/  artifact storage (local FS; Azure/S3 later)
  db/               Drizzle schema + DDL (Postgres)
  queue/            pg-boss helpers
  fixture-app/      deterministic in-repo target app for tests
```
