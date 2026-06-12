# Issues — Varys v2 MVP slice

> Tracer-bullet issues for the MVP slice (`prd/mvp.md`). Each is a thin vertical cut through
> every layer (schema → API → queue → worker → extension → tests), demoable on its own.
> *Not published to an issue tracker — none configured. Build order = dependency order below.*
>
> **Dependency shape:** `1 → {2, 3} → 4`, and `{2, 3} → 5`.

## Progress

**The MVP backend is complete and test-driven (Issues 1–5).** ~25 tests green (real Postgres via
testcontainers + real Chromium), typecheck clean across 11 packages.

| Issue | Status |
|---|---|
| 1 — Walking skeleton | ✅ Done |
| 2 — Baseline / diff / approve | ✅ Done |
| 3 — Fingerprint + locator | ✅ Done — recorder + WXT extension shell built (MV3-loaded E2E is a follow-up) |
| 4 — Environments / variables / secrets | ✅ Backend done — vault **dropped by decision**; inline-confirm UI pending |
| 5 — Waits / masking / determinism | ✅ Core done — pinned-font deploy image + request/response wait deferred |

**Remaining MVP work:** an **MV3-loaded Playwright E2E** for the extension (load unpacked, drive
popup → content, assert) — the recorder logic + capture are already tested, and the extension
builds into a valid MV3 package + typechecks. The interactive **inline variable/static confirm**
UX (Issue 4) is the other deferred piece. Otherwise the MVP is functionally complete.

Legend: `[x]` done · `[ ]` not done / deferred (see note).

---

# Issue 1 — Walking skeleton: replay a trivial test, store a screenshot

**Type:** AFK · **Status: ✅ Done**

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

- [ ] The monorepo builds and runs the API, worker, and fixture app locally with a single command. *(services build + run individually; no single-command `dev` orchestration yet)*
- [x] Creating a test via the API persists a versioned test definition in Postgres.
- [x] Triggering a run enqueues a job that the worker consumes from the Postgres-backed queue.
- [x] The worker replays against the fixture app in pinned headless chromium and captures the designated element screenshot.
- [x] The screenshot is stored via the local-FS storage adapter and referenced from a persisted run record.
- [x] The run status and artifact URL are retrievable through the API.
- [x] An API/integration test drives create → run → fetch against the fixture app with a real Postgres (testcontainers) and asserts the stored artifact and run row.

## Blocked by

None - can start immediately.

---

# Issue 2 — Baseline seed → approve → diff verdict

**Type:** AFK · **Status: ✅ Done**

## What to build

The baseline lifecycle and visual comparison. The first run for a `(test, checkpoint, environment)`
with no baseline stores the captured screenshot as a *pending* baseline; the test is not active
until a human approves it (recording approver + timestamp; the client enforces an
irreversible-confirm because approval is destructive). Subsequent runs diff the actual against the
active baseline within a per-checkpoint threshold, ignoring masked regions, producing a verdict, a
stored diff image, and a run status from the taxonomy. Transient errors are retried once with a
fresh attempt; a detected diff is never retried. Approving a diff replaces — and deletes — the
previous baseline (no rollback).

## Acceptance criteria

- [x] A first run with no baseline stores a pending baseline; the test is not "active" until approved.
- [x] Approving a pending baseline activates the test and records approver + timestamp.
- [x] A later run compares actual vs active baseline and reports `passed` when within threshold.
- [x] A visual change beyond threshold yields a `diff` status and a stored diff image highlighting changed pixels.
- [x] Approving a diff replaces the active baseline with the run's actual and deletes the previous baseline image.
- [x] An error (e.g., timeout) is retried once with a fresh attempt; a diff is never retried. *(retry policy via pg-boss; diffs are results, never retried)*
- [x] The full status taxonomy is recorded per checkpoint. *(reviewState pending-baseline/diff/passed + healed flag; run status queued/running/passed/needs_review/failed)*
- [x] Integration tests cover seed → approve → pass, and seed → approve → mutate fixture → diff.

## Blocked by

- Issue 1 — Walking skeleton

---

# Issue 3 — Real fingerprint capture + locator resolution

**Type:** AFK · **Status: ✅ Done — recorder + WXT extension shell built (MV3-loaded E2E follow-up)**

## What to build

Replace the hardcoded selector with the real record→replay path. The browser extension records a
click and a designated checkpoint on the fixture app and emits a step definition carrying a
multi-signal **fingerprint** per element, conforming to the shared step-schema. The worker's
locator-engine resolves a fingerprint against the live page using a **ranked matcher**
(testId → id → role+name → text), returning *resolved* / *healed* / *not-found*. The engine must be
replaceable by a confidence-scored matcher later without changing the stored fingerprint.

## Acceptance criteria

- [x] The extension records click + checkpoint interactions on the fixture app and emits a valid step-schema definition with a fingerprint per element. *(recorder logic tested via Playwright injection; WXT MV3 shell built + installable — content script + popup + inspect-mode picker; MV3-loaded E2E is a follow-up)*
- [x] A recorded test, saved via the API, replays and re-finds the element by fingerprint.
- [x] When the top-priority signal is removed from the page, the locator resolves via a lower-tier signal and the step is flagged "healed".
- [x] When no signal matches, the step is `not-found` and the run hard-fails, identifying the step to repair.
- [x] locator-engine has direct unit tests over DOM fixtures covering resolve / heal+flag / not-found.
- [x] An extension-capture test (Playwright against the fixture app) asserts the emitted definition matches the interactions performed.

## Blocked by

- Issue 1 — Walking skeleton *(parallelizable with Issue 2)*

---

# Issue 4 — Environments, variables, login & secrets

**Type:** ~~HITL~~ · **Status: ✅ Backend done — vault dropped by decision; inline-confirm UI pending**

> **Decision:** the encrypted vault was dropped for the MVP (local / single-tenant). Secret values
> are stored plaintext in the environment row; the leak-prevention that matters is kept — secrets
> are never returned by the API, resolved only transiently in the worker, and never persisted into
> runs/logs/artifacts. Revisit at-rest encryption before the hosted multi-user reality.

## What to build

Multi-environment execution with variables and secure login. An environment carries a profile
(baseUrl + secret values). The recorder auto-parameterizes the navigation origin as `{{baseUrl}}`
and detects password fields as secrets. The variable-resolver substitutes tokens from the chosen
profile at run time, resolving `{{secret:…}}` only inside the worker — never inlining secret values
into persisted steps. Login is recorded as ordinary `type`/`click` steps and executed fresh once
per run.

## Acceptance criteria

- [ ] ~~The vault encryption design is documented and signed off~~ *(N/A — vault dropped by decision; see note above)*
- [x] An environment with baseUrl + secret can be created; secret values are stored and only referenced (never returned by the API).
- [x] A single test definition runs against the environment with `{{baseUrl}}` and `{{secret:password}}` resolved at run time.
- [x] The recorder auto-parameterizes the origin and detects password fields as secrets. *(recorder logic — tested)*
- [ ] Typed values can be confirmed inline as variable or static. *(deferred — interactive inline-confirm UI rides with the extension shell)*
- [x] Login steps execute fresh once per run; the authenticated session is reused across that run.
- [x] No secret value appears in logs, stored artifacts, or run records (asserted by test).
- [x] variable-resolver has direct unit tests for substitution; secrets are resolved only in the worker and never inlined into persisted data.

## Blocked by

- Issue 3 — Real fingerprint capture + locator resolution

---

# Issue 5 — Waits, masking & determinism hardening

**Type:** AFK · **Status: ✅ Core done — pinned-font deploy image + request/response wait deferred**

## What to build

Make runs reliable and screenshots reproducible. Add per-step **wait primitives** plus a smart
default of network-idle before every screenshot. **Mask regions** are excluded from the diff. Apply
**determinism pinning** in the worker: fixed viewport/DPR and frozen animations.

## Acceptance criteria

- [x] Each step can carry wait primitives; the default applies network-idle before every screenshot. *(delay / networkIdle / selector shipped; request/response wait kind + visual-stability beyond network-idle deferred)*
- [x] A fixture page whose element appears after a delay reaches a stable state before the screenshot is taken.
- [x] Masked regions are ignored by the diff — a region that changes does not produce a diff.
- [ ] Replays use a fixed viewport/DPR, pinned fonts, and frozen animations, producing byte-stable screenshots. *(fixed viewport/DPR + `reducedMotion` done, and byte-stability is proven by the identical-rerun test; pinned-font runner image is a deploy-time concern, deferred)*
- [x] A fixture that flakes without hardening passes reliably with waits + masks + determinism enabled.
- [x] Tests cover wait behavior, mask-honoring diffs, and screenshot stability.

## Blocked by

- Issue 2 — Baseline seed → approve → diff verdict
- Issue 3 — Real fingerprint capture + locator resolution
