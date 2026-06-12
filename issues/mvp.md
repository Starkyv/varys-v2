# Issues — Varys v2 MVP slice

> Tracer-bullet issues for the MVP slice (`prd/mvp.md`). Each is a thin vertical cut through
> every layer (schema → API → queue → worker → extension → tests), demoable on its own.
> *Not published to an issue tracker — none configured; the `ready-for-agent` label could not be
> applied. Build order = dependency order below.*
>
> **Dependency shape:** `1 → {2, 3} → 4`, and `{2, 3} → 5`.

---

# Issue 1 — Walking skeleton: replay a trivial test, store a screenshot

**Type:** AFK

## What to build

The thinnest possible end-to-end path, plus the scaffolding it rides on. Stand up the monorepo
(API service, worker service, in-repo fixture app, Postgres, local-filesystem storage). The API
accepts a trivial test definition (navigate to the fixture URL + one element screenshot located by
a simple hardcoded selector) and persists it as a versioned definition. Triggering a run enqueues a
job on the Postgres-backed queue; the worker consumes it, launches pinned headless chromium,
navigates the fixture app, screenshots the designated element, stores the image via the storage
adapter, and writes a run record referencing the artifact. No baseline, diff, fingerprint, or
extension yet — this exists to prove every integration layer is wired together.

## Acceptance criteria

- [ ] The monorepo builds and runs the API, worker, and fixture app locally with a single command.
- [ ] Creating a test via the API persists a versioned test definition in Postgres.
- [ ] Triggering a run enqueues a job that the worker consumes from the Postgres-backed queue.
- [ ] The worker replays against the fixture app in pinned headless chromium and captures the designated element screenshot.
- [ ] The screenshot is stored via the local-FS storage adapter and referenced from a persisted run record.
- [ ] The run status and artifact URL are retrievable through the API.
- [ ] An API/integration test drives create → run → fetch against the fixture app with a real Postgres (testcontainers) and asserts the stored artifact and run row.

## Blocked by

None - can start immediately.

---

# Issue 2 — Baseline seed → approve → diff verdict

**Type:** AFK

## What to build

The baseline lifecycle and visual comparison. The first run for a `(test, checkpoint, environment)`
with no baseline stores the captured screenshot as a *pending* baseline; the test is not active
until a human approves it (recording approver + timestamp; the client enforces an
irreversible-confirm because approval is destructive). Subsequent runs diff the actual against the
active baseline within a per-checkpoint threshold, ignoring masked regions, producing a verdict, a
stored diff image, and a run status from the taxonomy: `passed / passed-with-heal-flag / diff /
error / failed`. Transient errors are retried once with a fresh attempt; a detected diff is never
retried. Approving a diff replaces — and deletes — the previous baseline (no rollback).

## Acceptance criteria

- [ ] A first run with no baseline stores a pending baseline; the test is not "active" until approved.
- [ ] Approving a pending baseline activates the test and records approver + timestamp.
- [ ] A later run compares actual vs active baseline and reports `passed` when within threshold.
- [ ] A visual change beyond threshold yields a `diff` status and a stored diff image highlighting changed pixels.
- [ ] Approving a diff replaces the active baseline with the run's actual and deletes the previous baseline image.
- [ ] An error (e.g., timeout) is retried once with a fresh attempt; a diff is never retried.
- [ ] The full status taxonomy is recorded per checkpoint.
- [ ] Integration tests cover seed → approve → pass, and seed → approve → mutate fixture → diff.

## Blocked by

- Issue 1 — Walking skeleton

---

# Issue 3 — Real fingerprint capture + locator resolution

**Type:** AFK

## What to build

Replace the hardcoded selector with the real record→replay path. The browser extension records a
click and a designated checkpoint on the fixture app and emits a step definition carrying a
multi-signal **fingerprint** per element (role, accessible name, text, key attributes, ancestor
chain, DOM index, neighbor text, bounding box), conforming to the shared step-schema. The worker's
locator-engine resolves a fingerprint against the live page using a **ranked matcher**
(testid → role+name → scoped CSS → relative XPath), returning one of: *resolved* (which signal
matched), *healed* (a lower-priority signal matched — carries a review flag), or *not-found*. The
engine must be replaceable by a confidence-scored matcher later without changing the stored
fingerprint.

## Acceptance criteria

- [ ] The extension records click + checkpoint interactions on the fixture app and emits a valid step-schema definition with a fingerprint per element.
- [ ] A recorded test, saved via the API, replays and re-finds the element by fingerprint.
- [ ] When the top-priority signal is removed from the page, the locator resolves via a lower-tier signal and the step is flagged "healed".
- [ ] When no signal matches, the step is `not-found` and the run hard-fails, identifying the step to repair.
- [ ] locator-engine has direct unit tests over DOM fixtures covering resolve / heal+flag / not-found.
- [ ] An extension-capture test (Playwright against the fixture app) asserts the emitted definition matches the interactions performed.

## Blocked by

- Issue 1 — Walking skeleton *(parallelizable with Issue 2)*

---

# Issue 4 — Environments, variables, login & secrets

**Type:** HITL — the secret-vault encryption approach (KMS provider vs library, envelope
encryption) is a security decision that needs human sign-off before merge.

## What to build

Multi-environment execution with variables and secure login. An environment carries a profile
(baseUrl + secret values). The recorder auto-parameterizes the navigation origin as `{{baseUrl}}`,
detects password fields as secrets, and offers inline variable/static confirmation for typed values.
The variable-resolver substitutes tokens from the chosen profile at run time, resolving
`{{secret:…}}` references from an **encrypted vault inside the worker only** — never inlining secret
values into resolved steps. Login is recorded as ordinary steps and executed fresh once per run
(session reused across that run). Secrets are scrubbed from logs and stored artifacts; password
input is redacted in any capture.

## Acceptance criteria

- [ ] The vault encryption design is documented and signed off (HITL gate) before implementation merges.
- [ ] An environment with baseUrl + secret can be created; secret values are written to the encrypted vault and only referenced from the profile.
- [ ] A single test definition runs against the environment with `{{baseUrl}}` and `{{secret:password}}` resolved at run time.
- [ ] The recorder auto-parameterizes the origin and detects password fields as secrets.
- [ ] Typed values can be confirmed inline as variable or static.
- [ ] Login steps execute fresh once per run; the authenticated session is reused across that run.
- [ ] No secret value appears in logs, stored artifacts, or run records (asserted by test).
- [ ] variable-resolver has direct unit tests for substitution and vault-resolution (secret never inlined).

## Blocked by

- Issue 3 — Real fingerprint capture + locator resolution

---

# Issue 5 — Waits, masking & determinism hardening

**Type:** AFK

## What to build

Make runs reliable and screenshots reproducible. Add per-step **wait primitives** (fixed delay,
network-idle, wait-for-request/response by URL pattern + optional status, wait-for-selector state)
plus a smart default of network-idle + brief visual-stability before every screenshot. **Mask
regions** designated in the recorder are excluded from the diff. Apply **determinism pinning** in
the worker: fixed viewport/DPR, pinned fonts, and frozen animations (`prefers-reduced-motion` + CSS
freeze).

## Acceptance criteria

- [ ] Each step can carry wait primitives; the default applies network-idle + stability before every screenshot.
- [ ] A fixture page with an in-flight request/animation reaches a stable state before the screenshot is taken.
- [ ] Masked regions are ignored by the diff — a region that changes every run does not produce a diff.
- [ ] Replays use a fixed viewport/DPR, pinned fonts, and frozen animations, producing byte-stable screenshots across repeated runs of an unchanged page.
- [ ] A fixture that flakes without hardening passes reliably across repeated consecutive runs with waits + masks + determinism enabled.
- [ ] Tests cover wait behavior, mask-honoring diffs, and screenshot stability.

## Blocked by

- Issue 2 — Baseline seed → approve → diff verdict
- Issue 3 — Real fingerprint capture + locator resolution
