# Varys v2 — Design Decision Record

> Visual-regression test automation platform: **record → baseline → rerun → compare**, with
> a trace-powered timeline, folder/tag/suite organization, environment-agnostic recordings,
> pluggable storage, and a phase-2 Claude/MCP authoring layer.
>
> This document is the durable output of a full design interview. Every decision below was
> deliberately chosen, with the rejected alternatives and rationale considered at the time.
> Status: **design locked, pre-implementation.** Greenfield — no v1 to migrate from.

---

## 0. Product in one paragraph

A user installs a **Chrome extension** and records a test by interacting with *any* web app
(their own product first, but the tool must work on apps they don't control). The extension
captures a portable, environment-agnostic **test definition** (ordered steps + element
fingerprints + checkpoints). A hosted backend **replays** that test server-side with
Playwright, screenshots designated elements, and **diffs** them against an approved baseline
per environment. Results land in a **test × environment dashboard**; failures are
investigated via a **Playwright-trace timeline** and resolved in a **diff viewer**
(a diff *fails* the run — set the new actual as baseline if the change is intended, else fix the app;
test-runner model, §4 Slice 17). Tests are organized with **folders + tags +
suites** and run **manually or on a schedule**. Later, **Claude (via an MCP server)** can
author tests by driving a live session that Varys records.

**MVP slice:** `record → replay → diff one element`. No timeline polish, folders, multi-env,
or Claude in the first cut — just the core loop proven end-to-end.

---

## 1. Foundation

| Decision | Choice |
|---|---|
| Prior art | **Greenfield** — no v1 to reuse or migrate |
| Deployment | **Hosted, multi-user service** |
| Database | **PostgreSQL + JSONB** (binary artifacts go to object storage, never the DB) |
| Recorder architecture | **Chrome extension (capture) + Playwright (replay)** |
| First slice | **record → replay → diff one element** |

**Why Postgres:** the core data is a relational entity graph (tests → steps, runs → results,
folders + tags + environments + members). The one document-shaped thing — a recorded test as
an ordered step list with flexible per-step config — is handled by **JSONB columns**, giving
document flexibility inside a relational store. Rejected: MongoDB (relational queries
dominate), SQLite (single-writer, wrong for hosted multi-user), time-series DBs (run history
isn't high-frequency telemetry).

---

## 2. Recorder internals

### Element location (the robustness core)
- **Stance:** app-agnostic core, **extensible to any app**, tuned so the datagenie product
  works flawlessly. Must work on apps whose source we don't control.
- **Locator engine:** capture a **multi-signal fingerprint** per element at record time —
  `tag, role, accessible name, text, key attributes, ancestor chain, DOM index, neighbor/label
  text, CSS-module classes, bounding box`. Ship a **simple ranked matcher for the MVP**, evolve
  to **confidence-scored matching later — without re-recording** (the signals are already
  stored). Capturing only a single selector is the one unrecoverable mistake.
- **`data-testid`:** optional *top-weighted* signal when the app is owned; **never required**.
  (The app under test currently has none.)
- **CSS-module classes** (`*.module.scss` → hashed): **weak corroborating signal only**
  (version-fragile, opaque). Weight goes on role/text/structure/neighbors.
- **Self-heal:** below-threshold match → complete but **flag "low-confidence — review"**
  (record which signal won); **no candidate clears the floor → hard-fail + surface for repair.**
  Load-bearing for black-box targets, which have an irreducible flakiness floor.

### Environment model (base URL only)
Governing principle: **everything a test needs is a literal on the test; the only environment-scoped
value is the base URL (`{{baseUrl}}`). There are no variables and no secrets.**

An **environment** is just a run target: `{ name, baseUrl, cookies[], localStorage[] }`. At replay
the resolver substitutes the single `{{baseUrl}}` token (the recorded entry URL's origin) with the
chosen environment's base URL; cookies + localStorage are seeded before the run for auth. Everything
else — typed form values, clicked/typed credentials, selector text — is stored **verbatim on the
test** (versioned with it).

| Tier | Examples | Behavior |
|---|---|---|
| Auto-parameterized | navigation origin → `{{baseUrl}}` | system decides |
| Literal (on the test) | typed input values (incl. passwords), URL path segments, clicks/hovers/scrolls, waits, selectors | system decides |
| Environment-scoped | base URL, cookies, localStorage | picked at run time |

A test "needs an environment" iff it uses `{{baseUrl}}` — the Run/verify picker requires one so the
base URL resolves. Per-environment approved baselines are unchanged (staging and production
legitimately look different).

> Revised from the original variable/secret model (Slices 4 & 6: a static-vs-variable classifier,
> `{{data}}`/`{{secret:…}}` tokens, a per-env values/secrets vault, and a selector guard that bound
> locators to variable values). All of that is removed — typed values are literals, the only token
> is `{{baseUrl}}`, and the environment holds just base URL + cookies + localStorage. Trade-off:
> a typed password is now stored in plain text on the test (accepted for simplicity).

### Wait conditions
Composable **per-step primitives**: `fixed delay (ms)` · `network-idle` ·
`wait-for-request/response matching a URL glob/regex (+ optional status)` ·
`wait-for-selector appear/disappear/settle`. **Smart default before every screenshot:**
auto network-idle + brief visual-stability check, overridable per step.

### Screenshot-target selection
Devtools-style **inspect mode**: activate capture → hover highlights → click to pick. Modes:
**element / full-page / manual region.** Stores fingerprint + bounding box. **Dynamic
sub-regions are masked in the same gesture** (feeds diff masking).

### App-under-test authentication
- **Login recorded as steps**, run **fresh once per run** (session reused across that run's
  steps to avoid lockout/rate-limits). **No MFA** in scope.
- Two options: record the login steps with **literal credentials** (stored on the test), or skip
  login by seeding the environment's **cookies / localStorage** before the run.
- Credentials are stored in plain text (no secret vault) — accepted for simplicity (see the
  Environment model above and Accepted risks).

---

## 3. Step schema (the record ↔ replay ↔ diff ↔ DB contract)

A recorded test is a **versioned JSONB document** (`test_versions.definition`) — authored/edited
atomically, with history. **Single viewport** captured at record time, **chromium-only** for MVP.

```ts
Test {
  id; name; description
  viewport: { width; height; deviceScaleFactor }   // captured at record time
  browser: 'chromium'
  variables: Variable[]                            // declared tokens; values live per-env
  steps: Step[]                                    // ordered
}
Variable { name; kind: 'url' | 'data' | 'secret' }

StepCommon { id; index; waitBefore?: Wait[]; note? }
Navigate   = StepCommon & { type:'navigate'; url:string /* "{{baseUrl}}/dashboard" */ }
Interact   = StepCommon & {
  type:'click'|'hover'|'scroll'|'type'|'select'|'press'
  target: Fingerprint
  value?: string          // literal | "{{dataset}}" | "{{secret:password}}"
}
Screenshot = StepCommon & {
  type:'screenshot'; name: string  // checkpoint name → part of the baseline key
  captureMode:'element'|'fullpage'|'region'
  target?: Fingerprint; rect?: Rect
  masks?: (Fingerprint | Rect)[]; threshold?: number
}

type Wait =
  | { kind:'delay'; ms:number }
  | { kind:'networkIdle'; timeoutMs? }
  | { kind:'request'|'response'; urlPattern:string; status?; timeoutMs? }
  | { kind:'selector'; target:Fingerprint; state:'visible'|'hidden'|'stable'; timeoutMs? }

Fingerprint {
  testId?; role?; accessibleName?; text?; tag
  attributes?; ancestors?: { tag; role? }[]
  domIndex?; neighborText?: string[]; moduleClasses?: string[]; boundingBox?: Rect
}
```

**Postgres tables** (artifacts → storage adapter, everything else relational + JSONB):

| Table | Notes |
|---|---|
| `tests` → `test_versions(definition jsonb)` | versioned test document |
| `environments` | dev / demo / lnrs / cfg / carvana |
| `environment_profiles(values jsonb)` | per-env variable values; secrets encrypted/ref'd |
| `runs` | (test_version, env, status, timing) |
| `run_results` | per-checkpoint: status, diff_score, confidence, healed_selector?, artifact refs |
| `baselines` | keyed `(test, checkpoint_name, env, viewport)` → artifact ref + approval; current only |
| `artifacts` | blob refs only (video, baseline, actual, diff images, traces) |

---

## 4. Baseline lifecycle

**Critical principle: recording ≠ baseline.** The extension captures in the *user's* browser
(their fonts/DPR/AA); replay happens in *server-side Playwright* (headless Linux, bundled
fonts). Those render differently, so **the baseline must be generated by the same engine that
replays.** The recording's screenshot is a *target + preview + mask surface*, not the golden.

```
1. RECORD   (client/extension) → test definition: steps, fingerprints, targets, masks, waits, vars
2. SEED     (server/Playwright) → first replay per environment captures the GOLDEN baselines
3. APPROVE  → human eyeballs seeded baselines once → test goes active
4. RUN      (server/Playwright) → compare actual vs approved baseline
5. ON DIFF  → run FAILS → set the new actual as baseline (if intended) or fix the app & re-run
              (test-runner model — see the Slice 17 note below; no separate "reject")
```

- **First baseline:** auto-seed → stays *pending* → **one-time human approval** → active.
- **Approval authority:** any project member, **audited** (who + when + old→new).
- **History:** **current only** — old baseline **deleted on replacement → no rollback.**
  Approval is therefore irreversible; **the approve action gets a hard confirm** ("permanently
  replaces the baseline — no undo"). *(Accepted risk #1.)*
- **Determinism pinning** (asserted, non-negotiable): pinned runner image — same chromium
  version, same fonts, fixed viewport/DPR, animations frozen (`prefers-reduced-motion` + CSS
  freeze), dynamic regions masked.
- **Per-env baselines** seed independently (data differs across environments).
- The **diff viewer** does double duty: step-3 initial approval *and* step-5 diff resolution.
- **Run outcome — test-runner model (Slice 17).** A derived `RunOutcome` (`deriveRunOutcome`,
  `@varys/review-contract`) refines the stored `status` on every surface, following the **test-runner
  model**: once a baseline exists, a capture that **differs** (or a crash) is **`failed`** (red) — there is
  **no "needs review" wait state and no Reject**; a real bug is left red and fixed in the app. A **first run**
  has no baseline to fail against, so it is **`pending-baseline`** (awaiting approval), not a failure;
  approving it seeds the golden and the run reads **`baseline`**. A run that set/updated the reference reads
  **`baseline`**, a clean match reads **`passed`**. The only action on a failed/pending checkpoint is **"set
  as baseline"** (also available to re-anchor a *passing* capture) — `approve()` now accepts a `passed`
  checkpoint too (same destructive-replace + irreversible confirm). `baseline` and `pending-baseline` runs
  are **excluded from the dashboard pass-rate** (it measures verification only). See
  `prd/run-outcome-baseline-vs-verified.md`.

---

## 5. Organization model

- **Tenancy:** single-org internal, **multi-tenant-ready** (`org_id` on the root so multi-tenant
  is a later flip, not a migration). `Org → Projects → Members`; environments + tests scoped to
  a Project.
- **Grouping:** **folders** (one browsable home per test) + **tags** (many-to-many slicing:
  `release:5.0`, `feature:dashboard`, custom) + **suites** (a saved selection = the run unit).
  Folders = where it lives; tags = how you slice/run it.
- **Two axes:** *what* to run (selection) × *where* to run (environment).
  **customer = environment** (lnrs/cfg/carvana are deployments, not folders).
  A run = `suite × env(s)`.

---

## 6. Playback infrastructure

- **Shape:** API control plane → **Postgres-backed job queue** (pg-boss / `SKIP LOCKED`) →
  horizontally-scalable pool of **pinned-chromium Playwright worker containers**. Each
  **test-job = fresh browser context + fresh login + sequential steps**, with per-step/test
  timeouts.
- **Parallelism:** **test-level fan-out/fan-in** — a suite-run becomes one job per test across
  the pool (concurrency capped by pool size), aggregated into a parent run report. Steps within
  a test stay sequential.
- **Triggers (MVP):** **manual + scheduled (cron).** API/CI webhook is a fast-follow (same rail,
  extra doorway). A schedule = `(suite) × (env(s)) × (when)`.
- **Retries:** **retry errors (default 1×, fresh attempt), never retry diffs** (a diff is a real
  result, not a fluke). Statuses: `passed` / `passed-with-heal-flag` / `diff (needs review)` /
  `error (retrying)` / `failed (errors exhausted)`.

---

## 7. Storage & artifact retention

- **`StorageAdapter`** interface (`put / get / getUrl / delete`). **Local FS for MVP**;
  **Azure Blob + S3** later, chosen by **env var**. `getUrl(key)` → signed blob URL (cloud) or
  authenticated API route (local) — the UI doesn't care. Path-addressed keys:
  `org/project/test/checkpoint/env/viewport/{baseline | run-<id>}/{kind}.png`.
- **Retention: tiered by outcome** — failed/diff artifacts kept ~90d, passing ~7d, baselines
  while current (configurable defaults).
- **Old baseline on approval: deleted immediately → no rollback** (consistent with §4).
- **Video: off by default; recorded only when toggled on per test.** *Checkpoints
  (screenshots + action markers) are always captured regardless* — so the timeline always has
  markers, scrubbable video only when toggled.

---

## 8. Diff / comparison viewer

- **View modes:** all four — **side-by-side, diff-highlight overlay, swipe slider,
  onion-skin/blink — with a switchable control.**
- **Review actions:** per-checkpoint **"set as baseline"** (seed a first baseline, accept a diff, or
  re-anchor a passing capture) **+ bulk "approve all in run"**; every action audited;
  **irreversible-confirm** on the destructive replace. No "reject" — a diff just fails the run until
  the actual is set as baseline or the app is fixed (test-runner model, §4 Slice 17).
- **In-viewer tuning:** **draw masks + nudge per-checkpoint threshold live, re-evaluate
  instantly**; the mask/threshold persists to the test for future runs. (Primary defense against
  false-positive fatigue.)

---

## 9. Timeline UI

- **Powered by Playwright traces** (per-step before/after screenshots, DOM snapshot, network,
  console — timestamped + scrubbable), with **optional video** layered in when toggled on. A
  trace is a richer "what went wrong" record than video.
- **Trace retention:** ~~retain-on-failure + every baseline-seed~~ → **superseded (slice 9
  shipped): per-trigger on demand only** — a "keep trace" toggle on the run/suite-run trigger;
  nothing is kept automatically. Revisit auto-retention only if on-demand proves insufficient.
- **Embed Playwright's Trace Viewer** for the MVP — **self-hosted** at `/trace-viewer` (served
  by the API from the `playwright-core` bundle) so the "Open timeline" link is same-origin as
  the trace artifact. (The hosted `trace.playwright.dev` can't fetch a localhost/loopback
  artifact — browsers block public→local — so self-hosting is required for local dev and works
  deployed too.) Build a custom branded timeline later. Slice 9 also persists a per-step
  **run_steps** timeline (every run) as that custom UI's data skeleton.

---

## 10. Run dashboard

- **Hero view:** **test × environment status matrix** (cell = latest status → drill to run →
  checkpoints → diff viewer), with a runs activity feed alongside.
- **Alerts:** **Slack + in-app inbox** on diffs/failures (no email for MVP).
- **History:** **per-checkpoint trend sparklines** so flaky/newly-broken checkpoints stand out.

---

## 11. Authentication & authorization

- **Authorization:** **flat model** — every authenticated org member can do everything,
  including create/edit environments + their login secrets. **No role gating for MVP.**
  Hedges: keep a `role` column on membership (tighten later = config flip, not migration);
  secrets remain encrypted-at-rest + scrubbed regardless. *(Accepted risk #2 — see below.)*
- **Authentication:** **both** Google SSO (domain-restricted) **and** email/password,
  **OIDC-ready**. Use a **proven auth library/provider, never hand-rolled.**

---

## 12. Tech stack

| Layer | Choice |
|---|---|
| Language | **TypeScript** everywhere |
| Repo | **pnpm + Turborepo monorepo**; shared packages: step-schema types, locator engine, storage adapter |
| API | **NestJS** (guards fit RBAC, interceptors fit audit) |
| Frontend | **React SPA (Vite)** + **TanStack Query** + **CSS Modules** |
| Worker | separate **Playwright** service |
| DB access | **Drizzle** (SQL-first, first-class JSONB) |
| Extension | **WXT** (Vite-powered MV3, shares monorepo types) |
| DB / queue / storage | Postgres / pg-boss / StorageAdapter (per above) |
| Timeline | embed Playwright Trace Viewer |

---

## 13. Claude / MCP automation (phase 2)

- **AI surface:** Varys ships an **MCP server, Claude-Code-driven** — exposes its primitives
  (drive the live browser, take screenshots/checkpoints, create/save a draft test, run a test).
- **Authoring mechanism:** Claude **drives a live session that Varys records** — exactly like a
  human recording, reusing the full recorder pipeline (fingerprints, variables, waits). Claude
  perceives the page via accessibility tree + screenshots the MCP returns. *(Not* direct JSON
  emission — that guesses selectors without touching the real DOM.)
- **Inputs:** **SRS/spec docs + Figma/design + live exploration** of the app.
- **Safety:** **unrestricted, full trust** — no environment limits, no mutation
  detection/gating. *(Accepted risk #2.)*
- **Output workflow:** AI-authored test lands in a **draft** → **human reviews/edits** in the
  recorder/diff UI → **promotes** into a folder + tags. (This is the one human checkpoint on AI
  output.)
- **In-product surface (slice 15 — Author with AI):** the same server-side **Authoring Session**
  is drivable from a chat **inside the Varys web app**, with the model running on the **user's
  own Claude subscription** via a small local **Bridge Helper** (Claude Agent SDK) that relays
  the conversation to the web UI; Varys streams a **live browser preview** server-side. *(A
  third-party app can't spend a user's subscription quota and can't tap a Claude Code session it
  didn't launch — hence the local helper.)* Review/**promote** stay web-UI-only. See
  `prd/author-with-ai.md`.

---

## 14. Editable test definition — locator editor + live verify (Slice 16)

First slice of making **Test Details** a configurable definition editor (not just
waits/thresholds). Scope here is the **locator** only; values/URLs/capture-modes/masks/
checkpoint-rename/step-ordering are later slices. See `prd/locator-editor-live-verify.md`.

### Editing the locator
- **Stance:** a recorded locator that is wrong/brittle must be **fixable in place**, never
  forcing a full re-record. But editing must **not** betray the robustness core (DESIGN §2):
  we never collapse a step to a single selector.
- **Surface:** edit the four high-value fingerprint signals — `role`, `accessibleName`,
  `text`, `testId` — as structured fields, plus a raw **selector override** under Advanced.
  All other captured signals (`ancestors`, `stableClasses`, `domIndex`, `neighborText`,
  `scope`, `boundingBox`) are **preserved untouched** on save.
- **Override semantics:** add an **author-only** `Fingerprint.selectorOverride?: string`,
  distinct from the recorder's `cssPath` (whose last-resort-screenshot-only role is
  unchanged). The scored matcher gains a **top-priority override branch**: try
  `selectorOverride` first; if it resolves to exactly one element, win with
  `matchedSignal:"override"`; else fall through to the scored bundle. So the override is
  "used as-is when set" yet still **self-heals** to the bundle if it goes stale.
- **Write path:** rides the existing config-save seam (`PUT /tests/:id/config`). The patch
  gains `step.target?: FingerprintPatch`; `saveConfig` merges it, re-validates via Zod, and
  writes a new audited `test_version` under the same optimistic lock. **No new tables.**
- **Baseline safety:** a locator edit never changes `screenshot.name`, so the
  `(test, checkpoint, env, viewport)` baseline key is stable — no orphaning, no re-seed.
  (This is why locator editing precedes checkpoint rename.)

### Live verify
- **Goal:** answer "does this locator resolve at this step in env X?" **before** a Run,
  using the **real** matcher — so "verified here" ⇒ "resolves at Run time".
- **Mechanism:** `POST /tests/:id/config/verify` runs a **transient, artifact-free partial
  replay** — launch a short-lived headless Chromium (Authoring-Session launch args), resolve
  tokens via `@varys/variable-resolver` for the chosen environment, **drive steps
  `[0..stepIndex)`**, then resolve the *candidate* (unsaved, merged) fingerprint at
  `stepIndex` via `@varys/locator-engine`. No run row, no `run_results`, no baselines, no
  artifacts, no enqueue.
- **Shared drive core:** factor the step-driving loop out of the runner's `processRun` into a
  reusable "drive to step N" in `@varys/runner`; Run and Verify both call it (the probe
  substitutes the candidate target at the final step). Guarantees identical drive semantics.
- **Verdict:** `resolved | ambiguous | not-found`, the **matched signal**, a **healed** flag
  (leaned on a weaker signal), and — when the drive itself failed earlier — the failed step,
  so "wrong locator" is distinguishable from "broken path to the step".
- **Env contract:** mirrors the Run pre-flight — a test with variables needs a satisfying
  environment; a no-variable test verifies env-less ("default").
- **Accepted limitation:** Verify is a *real* partial replay, so preceding mutating steps
  execute (same posture as accepted risk #2). It is not a side-effect-free dry run.

---

## ⚠️ Accepted risks (chosen knowingly)

1. **Irreversible baseline approval** — old baselines are deleted on replace; a mistaken approval
   is unrecoverable. Mitigation: hard confirm dialog on approve.
2. **Unrestricted AI on live/customer-prod environments** — Claude may perform mutating actions
   (submit/delete/pay) anywhere while authoring, and recorded mutations **replay unattended on
   every scheduled run**, including customer production. No mutation flagging or gating.

## 🔭 Explicitly deferred (post-MVP)

Responsive multi-viewport · cross-browser (webkit/firefox) · API/CI webhook trigger ·
per-project retention config · RBAC role-gating · multi-tenant isolation · custom timeline UI ·
email notifications · "existing tests as examples" for AI.


| #  | Slice                                 | Scope (one line)                                                                 | Depends on         |
|----|---------------------------------------|----------------------------------------------------------------------------------|--------------------|
| 1  | MVP ✅                                | Record → replay → diff one element (1 test, 1 env, manual, API review)          | —                  |
| 2  | Visual review UI ✅                   | Diff viewer (side-by-side + highlight) + in-browser approve/reject + irreversible confirm | 1          |
| 3  | Multi-checkpoint + capture modes ✅   | Many checkpoints/test, full-page & region modes, recorder/in-viewer masking     | 1                  |
| 4  | Full multi-environment + variable UX ✅ | Env management, per-env profiles, inline variable confirm, env-agnostic guarantees | 1               |
| 5  | Organization ✅                       | Folders + tags + suites (saved selection = run unit)                            | —                  |
| 6  | Suite runs + parallelism 🟡           | Fan-out/fan-in, suite × env(s), aggregated run reports ✅ — worker parallelism deliberately deferred (children drain sequentially; more worker processes = parallel today) | 4, 5               |
| 7  | Dashboard ✅                          | Test × env matrix, runs activity feed, per-checkpoint trend sparklines          | 6                  |
| 8  | Scheduling + notifications            | Cron triggers + Slack/in-app alerts on diffs/failures                           | 6                  |
| 9  | Timeline + traces ✅                  | On-demand Playwright trace capture + embedded Trace Viewer; per-step run_steps timeline (retention = per-trigger toggle, not auto) | 1 |
| 10 | Auth & multi-user ✅                  | Google SSO + email/password + OIDC, flat authz, audit surfacing (better-auth; live Google OAuth smoke pending) | —                  |
| 11 | Cloud storage + retention enforcement | Azure Blob + S3 adapters + tiered cleanup job                                   | —                  |
| 12 | CI/webhook triggers                   | Pipeline-driven runs                                                            | 6                  |
| 13 | Scored-locator upgrade ✅             | Replace ranked matcher with confidence scoring (no re-record)                   | 1                  |
| 14 | Claude/MCP authoring (Phase 2) ✅     | MCP server → live-session authoring → draft → promote (Claude Code + MCP)       | Most of the above  |
| 15 | Author with AI (in-product)           | In-Varys chat + live browser preview; model runs on the user's own Claude subscription via a local Bridge Helper relayed to the web UI | 14 |
| 16 | Locator editor + live verify          | Edit a step's locator (role/name/text/testId + raw override) in Test Details; verify it against an env via a real, artifact-free partial replay (the matcher Runs use) — §14 | 13 |
| 17 | Run outcome — test-runner status model | Derived `RunOutcome` (Pending baseline / Baseline / Passed / Failed): a diff or crash is Failed, a first run is Pending baseline (awaiting approval), no Reject; set any actual (incl. a passing one) as baseline; baseline + pending runs excluded from pass-rate — §4 (`prd/run-outcome-baseline-vs-verified.md`) | 1–3, 7 |
