# Issues — Varys v2 Slice 14: Claude/MCP test authoring (PRD 1)

> Tracer-bullet issues for the Claude/MCP authoring slice (`prd/claude-mcp-authoring.md`).
> Five vertical slices that build the *author → draft → review → promote* loop. Each is
> demoable/verifiable on its own; build order = dependency order below.
>
> *Not published to an issue tracker — none configured (no remote / `gh`); the `ready-for-agent`
> label could not be applied. This file is the source of record, consistent with prior slices.*
>
> **Design is locked** by the design interview + [ADR 0001](../docs/adr/0001-mcp-authoring-server-side-shared-core.md)
> (server-side Playwright session; steps built through a DOM-free **shared recorder core**, *not*
> the human event-listener path). Every issue is **AFK** — no open architectural decisions remain.
>
> **Testing posture (per established direction):** unit-test the **shared recorder core** (the
> human↔agent parity guarantee); **one chromium authoring E2E** that drives the MCP tool layer with
> a *deterministic script — no live LLM* — against `packages/fixture-app`; **one chromium-free API
> E2E** for the Draft lifecycle; the review/promote UI is the **manual click-through** gate. Prior
> art: `packages/recorder/src/index.spec.ts`, `apps/api/test/replay.e2e.spec.ts`,
> `apps/api/test/tests.e2e.spec.ts`.
>
> **Hard rules that bite here:**
> - **New top-level API route → add its prefix to the Vite dev proxy** (`apps/web/vite.config.ts`),
>   or the SPA gets `index.html` back and "the API returned HTML" JSON errors. Bites the
>   review-queue / drafts / promote routes (Issues 2, 5).
> - **New NestJS providers need explicit `@Inject(...)`** — esbuild emits no decorator metadata, so
>   the dev server silently fails to boot otherwise (the MCP module, the drafts module).
> - **Schema change → restart dev** after the `tests` `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
>   (Issue 2). This slice's only DDL.
> - **The tsx / `page.evaluate` `__name` gotcha** (functions serialized into the page break under
>   esbuild keepNames → `__name`): Issue 3 serializes `captureFingerprint` in-page — reuse the
>   locator-engine's `new Function` / `__name`-shim harness; don't hand-roll it.
> - Ports: API `:4000`, web `:5200`, Postgres `:5433`. No `Co-Authored-By` trailer in commits.
>
> **Dependency shape:** `1 → 2`, then `2 → 3 → 4`, with `2 → 5` branching off — **Issue 5 runs in
> parallel with Issues 3 & 4** once Issue 2 lands.
>
> | Issue | Type | Status |
> |---|---|---|
> | 1 — Shared recorder core (extract + parity unit tests) | AFK | ✅ Done |
> | 2 — Walking skeleton: navigate-only Draft end-to-end | AFK | ✅ Done |
> | 3 — Interaction authoring: perceive, click, type | AFK | ✅ Done |
> | 4 — Checkpoints | AFK | ✅ Done |
> | 5 — Review & promote (web UI) | AFK + manual click-through | ✅ Done |
>
> **Status: all five shipped** (`@varys/recorder` split into a DOM-free core + `./dom`
> driver; a JSON-RPC MCP server at `/mcp`; `tests.status/origin/intent`; the `/drafts`
> review queue + promote/discard; the web Review-queue view + PromoteDialog). Tests:
> `recorder` unit (23), `authoring.e2e` (4), `drafts.e2e` (3) all green; full monorepo
> build (16 tasks) clean; the review/promote UI verified live end-to-end (seed via MCP →
> promote → active). Pre-existing `review-ui.e2e` failures are unrelated (stale vs the
> Nexus diff-viewer redesign, not this slice).

---

# Issue 1 — Shared recorder core (extract + parity unit tests)

## Parent

`prd/claude-mcp-authoring.md` — Varys v2 Slice 14, PRD 1.

## What to build

Refactor `@varys/recorder` so the step-building logic is a **DOM-free shared core** that two
drivers — the human extension recorder and (in later issues) the MCP agent orchestrator — both call,
so AI-authored and human-authored tests cannot diverge in schema or quality.

Extract pure **step factories**: build-click (from a captured fingerprint); build-type (applying the
password→`{{secret:NAME}}` rule and the declared-kind / `classifyTypedValue` variable-vs-literal
rule, given the field's `type`/`id`/`name`/`value`); build-entry-navigate (volatile auth/redirect
param strip + origin → `{{baseUrl}}`). Extract a **driver-agnostic accumulator** that holds the
step list, shapes checkpoints (element/region/fullpage, masks only when present), derives variables
via `variablesFromSteps` in its `getDefinition`, and reports a step count. `startRecorder` becomes a
thin DOM-listener driver over this core with **unchanged behavior**. The pure exports must contain
**no module-load DOM reference** so the server can import them; they stay in `@varys/recorder` (no
new package — ADR 0001).

## Acceptance criteria

- [ ] Pure step factories + a driver-agnostic accumulator are extracted into `@varys/recorder`; the pure exports are **DOM-free** (importable in a Node/server context; no `document` at module load).
- [ ] `startRecorder` delegates to the core and the **existing human-recording behavior is unchanged** — `packages/recorder/src/index.spec.ts` still passes.
- [ ] build-type tokenizes `type=password` fields to `{{secret:NAME}}` and applies the variable/static policy (declared kind honored; `classifyTypedValue` fallback; data-shaped → `{{variable}}`).
- [ ] build-entry-navigate strips volatile auth/redirect params and rewrites origin → `{{baseUrl}}`.
- [ ] The accumulator's `getDefinition` derives variables via `variablesFromSteps`; checkpoint shaping covers element/region/fullpage with masks recorded only when present.
- [ ] **Parity unit tests:** the same inputs the human driver and the agent driver feed the factories produce **identical `Step` objects** (the divergence guarantee). Prior art: `index.spec.ts`.
- [ ] `pnpm --filter @varys/recorder build` is clean; the extension still records (manual smoke).

## Blocked by

None — can start immediately.

---

# Issue 2 — Walking skeleton: author a navigate-only Draft end-to-end

## Parent

`prd/claude-mcp-authoring.md` — Varys v2 Slice 14, PRD 1.

## What to build

The thinnest complete path through every layer: Claude Code connects to a hosted **MCP server**,
opens an **Authoring Session**, calls `navigate(url)`, calls `finish`, and a **Draft** test row
exists — a single `{{baseUrl}}` entry navigate, marked `draft`/`ai`, retrievable via a review-queue
read-model.

Stand up the MCP server module (MCP over HTTP/SSE; explicit `@Inject` for new providers) and the
session lifecycle: **open** a fresh server-side Playwright context (reusing the runner's
pinned-chromium infra), **hold** it across tool calls, **finish** by assembling the `TestDefinition`
through the shared core's `getDefinition` and persisting it, then **tear down**. `navigate` records
the entry step via the shared core and returns the URL/title (a minimal snapshot stub is fine here —
the rich aria snapshot lands in Issue 3). Add `status` (`'draft' | 'active'`, default `'active'`) and
`origin` (`'human' | 'ai'`, default `'human'`) to `tests`; AI authoring writes `draft`/`ai`, human
recordings are untouched. Add a review-queue endpoint and the `status`/`origin` contract fields.

## Acceptance criteria

- [ ] An MCP server module Claude Code can connect to (HTTP/SSE); new NestJS providers use explicit `@Inject(...)`; the API dev server boots.
- [ ] Authoring Session lifecycle works: open (fresh server-side Playwright context → navigate to the start URL), hold across calls, `finish` (persist + teardown). Reuses the runner's pinned-chromium browser infra.
- [ ] `navigate(url)` records the entry step via the **shared core** (origin → `{{baseUrl}}`, volatile params stripped) and returns URL/title.
- [ ] `tests` gains `status` + `origin` (bootstrap `ALTER TABLE … ADD COLUMN IF NOT EXISTS` — **restart dev after**); existing tests default to `active`/`human` and are unaffected.
- [ ] `finish` persists a **Draft** (`status='draft'`, `origin='ai'`) whose definition is built by the shared core; a navigate-only draft is valid.
- [ ] A **review-queue endpoint** returns drafts newest-first with `origin` + checkpoint count; **its top-level path is added to the Vite dev proxy allowlist**.
- [ ] Verified end-to-end by a **deterministic script** (navigate → finish, no LLM) that creates a retrievable Draft. Prior art: `replay.e2e` against `fixture-app`.
- [ ] Existing `runs.e2e` / `suite-runs.e2e` / `tests.e2e` still pass; `pnpm --filter @varys/web build` is clean.

## Blocked by

- Issue 1 (the shared core — factories + accumulator — must exist).

---

# Issue 3 — Interaction authoring: perceive, click, type

## Parent

`prd/claude-mcp-authoring.md` — Varys v2 Slice 14, PRD 1.

## What to build

Give the session eyes and hands so Claude can log in and click through a flow, producing a Draft
with fingerprinted interaction steps and a tokenized password.

**Perception:** an aria/accessibility snapshot with **stable refs** as the primary channel (reuse
Playwright's built-in aria snapshot), screenshots **on demand** and **automatically after a
navigation**; every action tool returns a fresh compact snapshot + URL/title. **Targeting by ref** →
resolved to a Playwright locator at action time; the **durable fingerprint is captured fresh in-page**
via `page.evaluate(captureFingerprint)`, **reusing the locator-engine `new Function` / `__name`-shim
harness**. `click(ref)` and `type(ref, value, { kind?, name? })` perform the action and append a step
through the shared core. Password-typed fields record as `{{secret:NAME}}` **unconditionally** — the
live value performs the login and is never persisted. `wait(primitive)` exposes the existing `Wait`
kinds. Selector-guard hits are surfaced on the action and Claude's chosen remedy is applied.

## Acceptance criteria

- [ ] `observe`/`snapshot` returns an aria tree with **stable refs** (+ optional screenshot); a screenshot is returned automatically after navigation and on demand.
- [ ] `click(ref)` and `type(ref, value, { kind?, name? })` resolve ref → locator, **capture the fingerprint in-page** (reusing the locator-engine `__name`-shim serialization), perform the action, and append a step via the shared core.
- [ ] `type` on a `type=password` field records `{{secret:NAME}}` regardless of declared kind, and **the literal value is never in the stored definition** (assert it).
- [ ] Declared `variable`/`static` kind is honored; omitted → `classifyTypedValue` fallback; a username records as `{{username}}`.
- [ ] `wait(primitive)` records the existing `Wait` kinds; selector-guard hits are surfaced and the chosen remedy (bind-to-variable or structural) is applied.
- [ ] Each action returns a fresh snapshot + URL/title.
- [ ] **Chromium E2E (deterministic, no LLM):** a scripted session (navigate → type → type → click → type-password → finish) against `fixture-app` yields a Draft with fingerprinted steps, `{{baseUrl}}` entry, a `{{username}}` variable, and a `{{secret:…}}` password. Prior art: `replay.e2e`.
- [ ] The tsx / `page.evaluate` `__name` gotcha is handled via the shared harness; existing E2E still green.

## Blocked by

- Issue 2 (MCP server, session lifecycle, draft persistence).

---

# Issue 4 — Checkpoints

## Parent

`prd/claude-mcp-authoring.md` — Varys v2 Slice 14, PRD 1.

## What to build

Let Claude propose the visual assertions. A `checkpoint(name, { mode, ref?, rect?, masks? })` tool
appends a screenshot step via the shared core: **element** resolves a ref → fingerprint (in-page
capture), **region** carries a rect, **full-page** carries nothing; masks are recorded only when
present (best-effort proposals — the human finalizes them in review). Full-page is the natural
default for "this screen" assertions. `finish` warns when the Draft has **zero checkpoints** (a test
that asserts nothing). Reuses the existing screenshot modes + mask shape; Claude just drives them.

## Acceptance criteria

- [ ] `checkpoint(name, { mode: 'element'|'fullpage'|'region', ref?, rect?, masks? })` appends a screenshot step via the shared core; element mode captures the fingerprint in-page; masks recorded only when present.
- [ ] Full-page is supported as the natural default; element and region modes are supported.
- [ ] Checkpoint names land in the definition as authored (baseline-key meaningful).
- [ ] `finish` surfaces a **zero-checkpoint warning**.
- [ ] **Chromium E2E** (extends Issue 3's script): the authored Draft carries at least one named checkpoint and, where given, masks.
- [ ] Existing E2E still green.

## Blocked by

- Issue 3 (the action-tool + perception + in-page capture infra).

---

# Issue 5 — Review & promote (web UI)

## Parent

`prd/claude-mcp-authoring.md` — Varys v2 Slice 14, PRD 1.

## What to build

The human checkpoint on AI output, **in the web UI**. A **review queue** lists Drafts; a reviewer
opens one in the existing **`TestDetail`** editor (tune waits/thresholds/variables), runs it against
a dev environment to **seed + preview baselines**, corrects Claude's masks / nudges thresholds in the
existing diff viewer, then **Promotes** it (assign folder + tags, flip `active`) or discards it.
Drafts are **excluded from suites and schedules**. **Promote is web-UI-only and is *not* an MCP/agent
tool** (Claude cannot self-promote — a deliberate forcing function, per the PRD Safety section).
Promote is **independent of baseline approval**, which stays the existing per-environment gate.
Reuses `TestDetail`, the run/baseline/diff machinery, and `EnvEditor` (post-promote env wiring).

## Acceptance criteria

- [ ] A **review-queue** view lists Drafts (`origin='ai'`, `status='draft'`), newest-first, marked AI-authored, with checkpoint count + the steering intent; drilling in opens the Draft.
- [ ] A Draft opens in the existing **`TestDetail`** editor and is **individually runnable** to seed/preview baselines against a chosen environment.
- [ ] Drafts are **excluded from suite membership** (the suite editor doesn't list them) and from schedule eligibility.
- [ ] **Promote** assigns a folder + tags and flips `status='active'` (the test joins the normal corpus and becomes suite-eligible); **discard** deletes the Draft (reuse the test-delete path).
- [ ] Promote is reachable **only in the web UI**; there is **no MCP/agent promote tool**.
- [ ] Promote is **independent of baseline approval** — a promoted test's baselines still go through the existing per-env approval gate.
- [ ] Any new top-level API path (drafts / review-queue / promote) is **added to the Vite dev proxy**; new providers use explicit `@Inject`.
- [ ] **Chromium-free API E2E:** a Draft is created `draft`/`ai`, excluded from suite eligibility, **promote** flips it to `active` + assigns folder/tags, and the baseline/run flow is unaffected. Prior art: `tests.e2e`. Review/promote **UX is verified by manual click-through** (no UI/component tests).

## Blocked by

- Issue 2 (the Draft + schema + contract fields). **Runs in parallel with Issues 3 & 4.**
