# PRD — Varys v2 MVP: Record → Replay → Diff One Element

> **Scope:** the thin vertical slice that proves the core loop. Everything else in the platform
> design is deferred (see `DESIGN.md` and the Out of Scope section).
> **Status:** ready for implementation. *(Not published to an issue tracker — none configured;
> the `ready-for-agent` triage label could not be applied. Living here until a tracker is wired up.)*
> **Source of truth for the full platform:** `DESIGN.md`.

## Problem Statement

I maintain a web product that I deploy to several customer environments (dev, demo, and named
customer deployments) from one codebase. UI regressions slip into these environments and I only
find out when a customer notices. I have no reliable, repeatable way to capture "this screen
should look like this" and automatically detect when it visually changes — and I can't add test
hooks to every app I'd want to check, including apps I don't control. Writing and maintaining
scripted UI tests by hand is slow and brittle, and a recorded test that hard-codes one
environment's data is useless across the others.

## Solution

A Chrome extension lets me **record** a flow on a live app — clicking, typing, logging in,
scrolling — and designate a single element to visually check. The recording is captured as a
portable, environment-agnostic **test definition** (ordered steps + a multi-signal **fingerprint**
for each element + one **checkpoint**), with no changes to the app under test. A hosted backend
**replays** that definition server-side in a pinned, deterministic browser, takes the checkpoint
screenshot, and **diffs** it against an approved **baseline** for the chosen environment. The first
run seeds a baseline I approve once; later runs flag any visual change as a diff to review. The
result — pass, diff, healed, or error — and the baseline/actual/diff images are available through
the API.

This MVP delivers the full loop end-to-end on one element, against one environment, triggered
manually — proving the recording→replay→diff machinery the rest of the platform builds on.

## User Stories

**Recording & capture**
1. As a QA engineer, I want to install a Chrome extension and start a recording session on any web app, so that I can capture a test without modifying the app.
2. As a QA engineer, I want my clicks, typing, navigation, hovers, and scrolls captured as ordered steps, so that the test reproduces my exact flow.
3. As a QA engineer, I want each interacted element captured as a multi-signal fingerprint (role, accessible name, text, attributes, ancestor chain, DOM position, neighbor text, bounding box), so that replay can re-find it even though the app has no test IDs.
4. As a QA engineer, I want to enter an inspect mode, hover to highlight elements, and click one to designate it as the screenshot checkpoint, so that I control exactly what is visually compared.
5. As a QA engineer, I want to name the checkpoint, so that its baseline stays identifiable and stable across edits to the test.
6. As a QA engineer, I want to mark dynamic sub-regions of the checkpoint to mask, so that volatile content (timestamps, random data) doesn't cause false diffs.
7. As a QA engineer, I want to attach wait conditions to a step (fixed delay, network-idle, wait-for-selector), so that screenshots are taken only after the UI has settled.
8. As a QA engineer, I want a smart default that waits for network-idle plus brief visual stability before each screenshot, so that I don't have to configure waits for the common case.
9. As a QA engineer, I want to record a login flow as ordinary steps, so that tests can reach authenticated screens.
10. As a QA engineer, I want password fields automatically treated as secrets and never stored in plaintext, so that credentials stay protected.
11. As a QA engineer, I want the app's origin automatically parameterized as `{{baseUrl}}`, so that the same test can target different environment URLs.
12. As a QA engineer, I want values I type flagged inline as variable-or-static with a sensible default, so that environment-specific data isn't hard-coded into the test.
13. As a QA engineer, I want to save the recording as a versioned test definition, so that I can re-run it later and keep edit history.

**Environments & variables**
14. As a tester, I want to define an environment with a base URL and the secret values for its login, so that a test can run against it.
15. As a tester, I want variable tokens resolved from the chosen environment's profile at run time, so that one test definition runs against any configured environment.
16. As a tester, I want secrets resolved from an encrypted vault only inside the runner, so that they never appear in the UI, logs, or stored artifacts.

**Replay**
17. As a tester, I want to trigger a run of a saved test against a chosen environment, so that I can execute the recorded flow on demand.
18. As a tester, I want replay to happen server-side in a pinned headless browser, so that screenshots are deterministic and reproducible.
19. As a tester, I want each run to start in a fresh browser context and log in fresh, so that runs are isolated and repeatable.
20. As a tester, I want replay to execute steps in recorded order, honoring each step's wait conditions, so that the run matches what I recorded.
21. As a tester, I want the locator to try the fingerprint's strongest signals first, so that minor DOM changes don't break the test.
22. As a tester, I want a step that matched on a weaker fallback signal to be flagged "healed — review", so that I can see selector drift before it becomes a hard failure.
23. As a tester, I want a step that matches nothing to fail clearly and identify which step to repair, so that I know exactly what broke.
24. As a tester, I want animations frozen and masked regions ignored during capture, so that diffs aren't polluted by motion or known-dynamic content.

**Baseline**
25. As a tester, I want the first replay in an environment to capture the checkpoint as a *pending* baseline, so that I have a golden to compare against.
26. As a tester, I want to approve a pending baseline once before the test is considered active, so that a broken first render doesn't silently become the source of truth.
27. As a tester, I want a clear, irreversible-approval confirmation, so that I don't accidentally and permanently overwrite a good baseline.
28. As a tester, I want baselines keyed per environment, so that each environment's data differences have their own golden.
29. As an auditor, I want each baseline approval recorded with who and when, so that there is an audit trail.

**Diff & status**
30. As a tester, I want subsequent runs to pixel-diff the checkpoint against the approved baseline within a threshold, so that visual regressions are detected.
31. As a tester, I want a diff image highlighting changed pixels generated and stored, so that I can see what changed.
32. As a tester, I want a run to report a clear status — passed / passed-with-heal-flag / diff-needs-review / error / failed — so that I can tell a real change from an infra hiccup.
33. As a tester, I want a transient error (timeout, navigation/login failure, element-not-found) retried once with a fresh attempt, so that flaky infrastructure doesn't create false failures.
34. As a tester, I want a detected visual diff to never be retried, so that real regressions always surface.
35. As a tester, I want to approve a run's actual as the new baseline (intended change) or leave it rejected (regression) — for the MVP via an API action — so that I can resolve a diff.

**Artifacts, results & operability**
36. As a tester, I want the baseline, actual, and diff images stored via a storage backend, so that they persist beyond the run.
37. As a tester, I want artifacts stored on local disk behind a storage interface, so that we can switch to Azure/S3 later without code changes.
38. As a tester, I want to retrieve a run's result and artifact URLs through the API, so that I can inspect the outcome.
39. As an operator, I want runs executed as queued jobs picked up by a worker, so that the API stays responsive and runs are durable across restarts.
40. As an operator, I want run metadata, results, baselines, and artifact references persisted in Postgres, so that state and history are queryable.

## Implementation Decisions

**Monorepo (pnpm + Turborepo), TypeScript throughout.** The record↔replay↔diff↔DB contract is
shared as packages so the extension, worker, and API agree on it.

**Modules to build:**

- **`step-schema` (shared package).** Canonical types + runtime validation for the *versioned test
  definition*: `Test` (with viewport, declared variables, ordered steps), the `Step` union
  (`Navigate` / `Interact` / `Screenshot`), `Wait` primitives, and the `Fingerprint` bundle. This
  is the single contract every other module depends on. The exact type shape is fixed in
  `DESIGN.md` §3 and should be lifted verbatim.
- **`locator-engine` (shared package).** Pure resolution of a `Fingerprint` against a live page,
  returning one of: *resolved* (with which signal matched), *healed* (matched a lower-priority
  signal — carries a review flag), or *not-found*. MVP uses a **ranked matcher** (testid → role+name
  → scoped CSS → relative XPath); it must be replaceable by a confidence-scored matcher later
  **without changing the stored fingerprint**.
- **`variable-resolver` (shared package).** Pure function: `(test definition, environment profile) →
  concrete steps`, substituting `{{baseUrl}}` / data tokens and resolving `{{secret:…}}` references
  through a vault interface (never inlining secret values into the resolved steps).
- **`diff-engine` (shared package).** Pure function: `(baseline, actual, masks, threshold) →
  { verdict, score, diffImage }`, wrapping pixelmatch and honoring masked regions.
- **`storage-adapter` (shared package).** Interface `put / get / getUrl / delete`, path-addressed
  keys, `getUrl` returning a signed/authenticated URL. **Local-filesystem implementation only** for
  MVP; the interface is the seam for Azure Blob / S3 later.
- **`extension` (WXT, Manifest V3).** Content-script capture (interactions → steps + fingerprints),
  devtools-style inspect-mode element picker, inline variable confirm, password→secret detection,
  mask drawing, and a session UI. Emits a `step-schema` test definition to the API.
- **`api` (NestJS).** REST surface; persistence via **Drizzle** on Postgres; enqueues run jobs;
  serves artifact URLs; enforces audit on baseline approval. Varys-app authentication is minimal for
  MVP (single trusted operator) — SSO/RBAC deferred.
- **`worker` (Playwright).** Consumes run jobs from a **Postgres-backed queue (pg-boss)**; runs a
  **pinned chromium** image (fixed fonts, fixed viewport/DPR, frozen animations); fresh context +
  fresh login per run; executes steps via `locator-engine` honoring `Wait` primitives; takes the
  checkpoint screenshot; seeds-or-diffs against the baseline; writes artifacts via `storage-adapter`
  and results to Postgres.

**Architectural decisions:**

- **Recording ≠ baseline.** The extension's screenshot is a target/preview only; the *golden*
  baseline is always produced by the worker, so baseline and actual render in the identical
  environment. This is a correctness requirement, not an optimization.
- **Determinism pinning** (pinned browser version, fonts, viewport/DPR, frozen animations, masks) is
  mandatory; without it even worker-vs-worker diffs are noisy.
- **Baseline lifecycle:** seed (pending) → one-time approval → active → diff on later runs → approve
  (replace) or reject. Baselines are **current-only**; an approved baseline **replaces and deletes**
  the previous one — **no rollback** (so approval is irreversible and requires a hard client confirm).
- **Retries:** errors retried once with a fresh attempt; diffs never retried.
- **Queue granularity:** one job per run (single test). Suite fan-out/fan-in is out of scope.
- **Secrets:** encrypted at rest, decrypted only in the worker, scrubbed from logs and artifacts,
  redacted in any capture.

**API contracts (shape, not paths):**

- *Create/update test* — accepts a `step-schema` definition; returns test id + version.
- *Get/list test*.
- *Create environment + profile* — base URL + secret values (secrets written to the vault; the
  profile stores references).
- *Trigger run* — `{ testVersion, environment }` → enqueues a job, returns a run id.
- *Get run* — status + per-checkpoint result (status, diff score, confidence, healed flag) +
  artifact URLs (baseline / actual / diff).
- *Approve baseline* — `{ run or checkpoint }` → promotes a pending baseline to active, or replaces
  the active baseline with the run's actual; records approver + timestamp.

**Schema (MVP subset; relational + JSONB, artifacts external):** `tests` → `test_versions(definition
jsonb)`; `environments`; `environment_profiles(values jsonb, secret refs)`; `runs(test_version,
environment, status, timing)`; `run_results(run, checkpoint_name, status, diff_score, confidence,
healed_selector, baseline_ref, actual_ref, diff_ref)`; `baselines(test, checkpoint_name, environment,
viewport, artifact_ref, approved_by, approved_at)`; `artifacts(key, kind, size)`; an encrypted secret
store.

## Testing Decisions

**What makes a good test here:** it asserts *external behavior* — HTTP responses, persisted state,
emitted artifacts, and returned verdicts — never internal implementation details. It is
deterministic, and it runs against an **in-repo fixture app** and committed image fixtures rather
than the real product or the live network.

**Seams and the modules tested at each:**

- **Primary behavioral seam — `fixture-app` + HTTP API.** Exercise the whole loop through the
  NestJS API against a deterministic in-repo static **fixture app**, with a real Postgres
  (testcontainers) and local-FS storage: create a test → trigger a run → seed a pending baseline →
  approve → re-run → assert pass; then mutate the fixture and assert a diff with a stored diff image.
  This is the highest seam for end-to-end behavior. *New seam introduced: a shared `fixture-app`
  package*, reused by extension and worker tests.
- **`locator-engine`** — fingerprint resolved against DOM fixtures: asserts correct resolution,
  *healing* when the top signal is removed, and *not-found* when nothing matches.
- **`diff-engine`** — image-pair fixtures: asserts pass/diff verdicts and scores, and that masked
  regions are ignored.
- **`variable-resolver`** — asserts token substitution from a profile and that `{{secret:…}}` is
  resolved from the vault and never present in the resolved steps.
- **`storage-adapter`** — a single **contract suite** run against every implementation (local FS now;
  the same suite will guard Azure/S3 later).
- **`extension` capture** — drive the content-script against the fixture app via Playwright; assert
  the emitted step-definition JSON matches the interactions performed.

**Prior art:** none — this is a greenfield repo. These tests establish the conventions:
testcontainers-backed Postgres for API/integration tests, the shared `fixture-app` package as the
controlled target, committed image fixtures for diff cases, and Playwright for extension/worker
browser tests.

## Out of Scope

Deferred to later PRDs/issues (all designed in `DESIGN.md`): the polished diff viewer (four view
modes, in-viewer mask drawing, live threshold tuning); the dashboard (test × environment matrix,
trends, activity feed); the timeline UI and Playwright Trace Viewer integration; folders, tags,
suites, multi-test suite runs, and fan-out/fan-in parallelism; scheduling (cron) and API/CI webhook
triggers; Slack and in-app notifications; Varys-app SSO/RBAC and multi-tenancy; Azure Blob / S3
storage adapters; Claude/MCP test authoring; cross-browser and responsive multi-viewport testing;
advanced variable heuristics and Figma/SRS inputs; baseline history/rollback (none by design).

## Further Notes

- Full platform design, rationale, and rejected alternatives live in **`DESIGN.md`**; this PRD is
  the first buildable slice of it.
- **Make-or-break correctness concerns** for this slice: *recording ≠ baseline* and *determinism
  pinning*. If either is wrong, every run produces noise diffs. Build and test these first.
- **Security-critical even at MVP:** the secret vault and the scrubbing of credentials from logs,
  artifacts, and video/network capture.
- **Accepted risk carried into MVP:** baseline approval is irreversible (no rollback) — the only
  guard is the hard confirm dialog.
- Suggested build order for the slice: monorepo scaffold → `step-schema` → `fixture-app` →
  `locator-engine` + `diff-engine` + `variable-resolver` (pure cores, fully unit-tested) →
  `storage-adapter` (local) → `worker` replay against the fixture → `api` + queue → `extension`
  capture last. Each pure core is independently testable before any browser is involved.
