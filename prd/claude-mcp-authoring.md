# PRD — Varys v2 Slice 14: Claude/MCP test authoring (PRD 1 — author → draft → promote)

> Claude authors a Varys test the way a human records one — by driving a **live browser
> session** and interacting with the app — except the browser is server-side Playwright and
> the "hands + eyes" are an **MCP server** that Claude Code connects to. Claude perceives the
> page (accessibility snapshot + screenshots), performs actions, and proposes checkpoints; each
> action is captured into the **exact same step/fingerprint/variable artifacts** a human
> recording produces. The result lands as a **Draft** — a first-class but un-promoted test — that
> a human reviews and tunes in the existing `TestDetail` editor, runs to seed baselines, and then
> **promotes** into a folder + tags. Slice 14 of `DESIGN.md` §13 (Claude/MCP automation, phase 2).
>
> **Architecture is governed by [ADR 0001](../docs/adr/0001-mcp-authoring-server-side-shared-core.md):**
> server-side Playwright session; steps built through a DOM-free **shared recorder core** (the A1
> "explicit perform-then-capture" path), **not** by loading the real extension and replaying the
> human event-listener path.
>
> **Build posture:** maximal reuse. The replay browser infra (runner), the locator-engine's
> in-page injection harness, the fingerprint/variable/secret/wait logic (recorder), the test +
> baseline + diff machinery, and the `TestDetail` config editor (waits/thresholds/variables, just
> shipped) all already exist. The genuinely net-new pieces are: the **MCP server + session
> lifecycle**, the **perception layer** (aria snapshot + refs), and the **Draft** flag + review
> queue + promote.
>
> **Testing posture (per established direction):** unit-test the **shared recorder core** (the
> human↔agent parity guarantee); **one chromium authoring E2E** that drives the MCP tool layer with
> a deterministic script (no live LLM) against `fixture-app`; **one chromium-free API E2E** for the
> Draft lifecycle (create → exclude from suites → promote). The review/promote UI is the **manual
> click-through** gate. Prior art: `packages/recorder/src/index.spec.ts`, `apps/api/test/replay.e2e.spec.ts`,
> `apps/api/test/tests.e2e.spec.ts`.
>
> **Tracker note:** no issue tracker is configured (no git remote / no `gh`); this PRD lives in
> `prd/` and the `ready-for-agent` label cannot be applied — consistent with prior slices.

---

## Problem Statement

Authoring a Varys test today requires a human to install the Chrome extension, open the app,
manually click and type through the flow, and hand-pick every checkpoint. That is the only way a
test enters the system. For a team with many flows across many apps, this is the bottleneck: every
test is gated on a person's time at a keyboard, and the knowledge of "what's worth asserting" lives
only in that person's head during the recording. There is no way to say "here's the app, here's how
to log in, go author tests for the dashboard" and have the work happen — the recorder is purely
reactive to a human's hands, and nothing else can drive it.

## Solution

A **Claude/MCP authoring layer**: Claude Code connects to a Varys **MCP server**, which opens a
live server-side browser session against an app the user names. The user provides — in the prompt —
a start URL, login credentials, and steering instructions ("author tests for the dashboard and the
results filters"). Claude logs in, explores, and drives the session: it perceives each page via an
accessibility snapshot (with screenshots on demand), performs actions, and proposes checkpoints for
the states worth asserting. Every action is funneled through the **same** capture/fingerprint/
variable/secret/wait logic a human recording uses, so the output is indistinguishable in shape and
quality from a hand-recorded test — env-agnostic (`{{baseUrl}}`, `{{secret:…}}`) by construction.

The session's output is a **Draft**: a real test (full definition, individually runnable for
preview) that is held out of suites and schedules and surfaced in a **review queue**. A human opens
the draft in the existing `TestDetail` editor, tunes waits/thresholds/variables and corrects
checkpoints/masks, runs it against a dev environment to seed baselines, and then **promotes** it —
assigning a folder + tags and flipping it active. That review is the one human checkpoint on AI
output; baseline approval remains its own per-environment gate, unchanged.

## User Stories

1. As a Claude Code user, I want to point Claude at my app with a URL and credentials in the prompt, so that it can log in and start authoring without me touching a browser.
2. As a Claude Code user, I want to give steering instructions ("test the dashboard and the results filters"), so that Claude authors the flows I care about rather than wandering.
3. As a Claude Code user, I want Claude to also be able to decide what's worth testing on its own when I don't specify, so that I can get coverage without enumerating every flow.
4. As a Claude Code user, I want Claude to connect to a hosted Varys MCP server, so that the browser, secrets handling, and persistence stay server-side and I don't run browser infra locally.
5. As Claude, I want to perceive each page as an accessibility snapshot with stable refs, so that I can decide the next action and name a target precisely without guessing CSS selectors.
6. As Claude, I want to request a screenshot on demand (and get one automatically after a navigation), so that I can disambiguate visually and judge what's worth a checkpoint.
7. As Claude, I want to navigate to a URL, so that the session starts at the right page and the recorded entry navigate is parameterized to `{{baseUrl}}`.
8. As Claude, I want to click a target by its snapshot ref, so that the action happens and a durable fingerprint of that element is captured into a click step.
9. As Claude, I want to type a value into a field by ref and declare whether it is a variable, static, or secret, so that the recorded step is tokenized correctly using my semantic judgment.
10. As Claude, I want the system to tokenize password fields to `{{secret:…}}` automatically regardless of what I declare, so that a real credential is never persisted into the test.
11. As Claude, I want to add an explicit wait when I observe a slow or async load, so that replay is stable at that point.
12. As Claude, I want to propose a checkpoint (full-page, element, or region) with a meaningful name, so that the test has visual assertions at the states that matter.
13. As Claude, I want to default to full-page captures when I'm asserting "this screen," so that I don't have to over-specify element targets.
14. As Claude, I want to propose masks over regions that look volatile, so that the human has a starting point for diff stability — understanding the human will finalize them.
15. As Claude, when a selector guard fires (the locator depends on env-specific visible text), I want to choose the remedy (bind to a variable or drop to a structural locator), so that the test stays portable across environments.
16. As Claude, I want each action to return a fresh compact snapshot and the new URL/title, so that I can decide the next step without a separate observe call.
17. As Claude, I want to be warned if I'm about to finish a session with zero checkpoints, so that I don't save a test that asserts nothing.
18. As Claude, I want to finish the session and have the assembled definition saved as a draft, so that a human can review it.
19. As a reviewer, I want AI-authored drafts to appear in a dedicated review queue, so that I can find what's waiting for my judgment.
20. As a reviewer, I want a draft to be clearly marked as AI-authored (origin) and un-promoted (status), so that I never confuse it with an active test.
21. As a reviewer, I want drafts excluded from suites and schedules, so that an unreviewed AI test can never run in production by accident.
22. As a reviewer, I want to open a draft in the existing `TestDetail` editor, so that I can tune per-step waits, thresholds, and variables without re-recording.
23. As a reviewer, I want to run a draft against a dev environment to seed and preview its baselines, so that I can see what it actually captures before promoting.
24. As a reviewer, I want to correct or remove Claude's proposed masks and adjust thresholds in the existing diff viewer, so that I can tame false positives before the test goes active.
25. As a reviewer, I want to rename checkpoints on a draft, so that the baseline keys are meaningful and stable once promoted.
26. As a reviewer, I want to promote a draft by assigning it a folder and tags and making it active, so that it joins the normal test corpus and becomes suite/schedule-eligible.
27. As a reviewer, I want promotion to be separate from baseline approval, so that filing the test and approving its golden images stay distinct decisions.
28. As a reviewer, I want to discard a draft I don't want, so that the queue reflects only real candidates.
29. As a reviewer, I want to see the steering instructions / intent that produced a draft, so that I can judge whether it did what was asked.
30. As an operator, I want each authoring session to spin up a fresh server-side browser context and tear it down on finish, so that sessions are isolated and resources are reclaimed.
31. As an operator, I want the credential supplied in the prompt to be used only for the live login and never written to the database or logs, so that the persisted artifact is safe even though authoring is convenience-first.
32. As a developer, I want the human recorder and the agent orchestrator to call one shared step-building core, so that AI-authored and human-authored tests cannot diverge in schema or quality.
33. As a developer, I want the agent path to reuse the locator-engine's in-page injection harness for fingerprint capture, so that the `__name` serialization pitfall is solved in one place.
34. As a developer, I want the MCP tool layer to be drivable by a deterministic test script, so that I can verify authoring against the fixture app without a live LLM.

## Implementation Decisions

**MCP server & session (net-new).**
- A hosted **MCP server** co-located with the Varys backend, speaking MCP over HTTP/SSE; Claude Code connects to it. (ADR 0001.)
- It drives a **server-side Playwright session** reusing the runner's pinned-chromium browser infrastructure. Session lifecycle: **open** (launch a fresh context, navigate to the prompt-supplied start URL), **hold** across Claude's turns, **finish** (assemble the `TestDefinition`, persist as a draft, tear down).
- **Recording uses the A1 path** (explicit perform-then-capture). The event-listener extension path is explicitly rejected (ADR 0001).

**Perception & targeting (net-new).**
- Primary perception channel is an **aria/accessibility snapshot with stable refs** (reuse Playwright's built-in aria snapshot; do not invent one). **Screenshots on demand**, plus automatically after a navigation. Every action tool returns a fresh compact snapshot + URL/title.
- Targeting is **by ref** from the latest snapshot; the MCP resolves ref → Playwright locator at action time. The ref is transient plumbing; the **durable fingerprint is captured fresh** at action time, so a mutated DOM never corrupts the artifact.

**MCP action tools (the authoring-session interface — also the test seam).**
- `observe`/`snapshot` (a11y tree + optional screenshot), `navigate(url)`, `click(ref)`, `type(ref, value, { kind?: 'variable'|'static'|'secret', name? })`, `wait(primitive)`, `checkpoint(name, { mode: 'element'|'fullpage'|'region', ref?, rect?, masks? })`, and a `finish` that persists the draft.
- The agent surface **deliberately excludes `promote`** (and any test-activation action): Claude can author and `finish` a draft, but **cannot promote it**. Promotion is a human action in the web UI — see Safety.
- `type` honors Claude's declared `kind` (the agent analog of the human inline one-tap confirm), falling back to `classifyTypedValue` when omitted. **Password-typed fields tokenize to `{{secret:NAME}}` unconditionally** — the live value is used only to perform the login, never persisted.
- Selector-guard hits are surfaced on the action so Claude can choose a remedy via the existing `applySelectorRemedy`.

**Shared recorder core (refactor of `@varys/recorder`).**
- Extract **DOM-free pure factories** — build-click, build-type (encapsulating the password→secret and classify→variable rules), build-entry-navigate (origin → `{{baseUrl}}` + volatile-param sanitize) — and a **driver-agnostic accumulator** (push, checkpoint shaping, `getDefinition` → `variablesFromSteps`, step count).
- `startRecorder` becomes a **thin DOM-listener driver** over that core; the human recording behavior is unchanged. The MCP orchestrator is the second driver over the same core.
- The pure exports must stay **DOM-free** so the server can import them; they remain in `@varys/recorder` (no new package — ADR 0001).
- Fingerprint capture in the agent path runs `captureFingerprint` **in-page via `page.evaluate`**, reusing the locator-engine's `new Function` / `__name`-shim serialization harness.

**Draft model & lifecycle (schema change).**
- Add two columns to `tests`: **`status`** (`'draft' | 'active'`, default `'active'`) and **`origin`** (`'human' | 'ai'`, default `'human'`), via the existing bootstrap `ALTER TABLE … ADD COLUMN IF NOT EXISTS` pattern. No new table.
- AI authoring creates tests with `status='draft'`, `origin='ai'`. **Human recordings are unaffected** — they remain `active`/`human` on create; the draft gate is AI-only.
- A draft is **individually runnable** (for baseline preview during review) but **excluded from suite membership and (future) schedules**, and surfaced in a **review queue** read-model.
- **Promote** = assign folder + tags + set `status='active'`. **Baseline approval stays the orthogonal per-environment gate** (existing flow, unchanged). Discard deletes the draft (reuse the existing test-delete path).
- A draft with **zero checkpoints** is flagged (at `finish` and in the review queue).

**Inputs, environment binding, and login.**
- Start URL + credentials + steering instructions arrive **through the prompt**. Authoring binds to **no stored environment**; the draft is env-agnostic by construction (`{{baseUrl}}` entry navigate, `{{secret:…}}` password). The real environment + secret are wired later via the existing `EnvEditor` for replay.
- **No document/Figma/SRS ingestion** — those ride Claude Code's existing context if used at all.

**Contract additions (`@varys/review-contract`).**
- `status` + `origin` on the test summary; a **review-queue** read-model (drafts, newest first, with checkpoint-count and intent); a **promote** request body (folderId, tags).

**Safety.**
- **Permissive / unrestricted**, consistent with `DESIGN.md` accepted risk #2: no mutation detection or gating. The **human review is the only gate**. Recorded mutations replay on every future run — flagged as a conscious risk, surfaced in review, not blocked. The credential transiting the prompt/conversation is a conscious MVP convenience risk.
- **Review and promote happen only in the web UI — never in Claude Code — and `promote` is never an agent tool.** This is a deliberate **forcing function**, not a missing feature: the diff viewer (where baselines, masks, and thresholds are actually *visible*) is the only surface a human can promote from, which structurally guarantees a human *looked at* the AI's output before activating it. If `promote` were agent-callable, Claude could author-and-promote in one session and the human checkpoint would silently evaporate. The one handoff back through Claude Code is *kicking the baseline-seed run* ("seeded — open the review queue"); the judgment itself stays visual.

## Testing Decisions

A good test here asserts **external behavior** — the produced test *definition*, the *lifecycle transitions*, and the *parity* between human and agent output — never implementation details (not "`captureFingerprint` was called", not internal call order). It must not depend on a live LLM: the model's *judgment* is out of scope to test; the *machinery* it drives is in scope.

- **Shared recorder core — unit tests** (`@varys/recorder`; prior art: `packages/recorder/src/index.spec.ts`). The central guarantee: feeding the build-step factories the inputs the **human driver** produces and the inputs the **agent driver** produces yields **identical steps**. Cover: password → `{{secret:NAME}}`; declared-kind and heuristic-fallback variable tokenization; entry-URL sanitize + `{{baseUrl}}`; checkpoint shaping for all three modes; `getDefinition` variable derivation.
- **Authoring session — chromium E2E** (prior art: `apps/api/test/replay.e2e.spec.ts` drives the runner against `fixture-app`). Drive the **MCP tool layer with a deterministic, hand-written sequence** of `navigate/click/type/checkpoint/finish` calls (no LLM) against `fixture-app`; assert the persisted draft definition: tokenized password, `{{baseUrl}}` entry, at least one checkpoint, derived variables, `status='draft'`/`origin='ai'`.
- **Draft lifecycle — chromium-free API E2E** (prior art: `apps/api/test/tests.e2e.spec.ts`). A draft is created as `draft`/`ai`; it is **excluded from suite eligibility**; **promote** flips it to `active` and assigns folder + tags; the existing baseline/run flow is unaffected (additive — `runs.e2e` / `suite-runs.e2e` still pass).
- **Review/promote UI — manual click-through** (reuses `TestDetail`; consistent with the dashboard slice). No UI/component tests.
- **Explicitly not tested:** Claude's reasoning/coverage quality; masking accuracy (human-finalized); screenshot pixel fidelity.

## Out of Scope

- **Vault-integrated authoring login.** MVP uses prompt-supplied credentials only; secrets are not read from an environment vault during authoring.
- **Document / Figma / SRS ingestion** and **"existing tests as examples"** — deferred (`DESIGN.md` deferred list); they ride Claude Code's existing context if at all.
- **Mutation detection / gating.** No flagging of destructive steps in this PRD (a soft review-time heuristic is a candidate for the follow-up PRD).
- **Structural step editing** (reorder / insert / re-target a fingerprint) in review — fixes are made by re-authoring; at most a delete-step affordance.
- **Auto-mask intelligence** beyond Claude's best-effort proposals.
- **In-product embedded AI button** (`DESIGN.md` deferred list) — authoring is via Claude Code + MCP only.
- **Review or promote from Claude Code.** Stages 6–7 (review, mask/threshold tuning, promote) are **web-UI only**; `promote` is not exposed as an MCP/agent tool and Claude cannot self-promote (see Safety). A future human-typed "promote it" CLI convenience is out of scope here, and even then would remain a human act, never an authoring step.
- **Scheduling drafts** (drafts are schedule-ineligible by definition) and **cross-browser / multi-viewport authoring**.

## Further Notes

- This is **PRD 1** of the Claude/MCP slice (`DESIGN.md` §13 anticipated "likely 2 PRDs"). It delivers the end-to-end loop: *author → draft → review → promote*. **PRD 2** would cover richer authoring inputs (Figma/SRS, examples) and review-time mutation flagging.
- **Natural issue split (for `/to-issues`):** (1) the shared-core refactor of `@varys/recorder` (pure, behind unit tests, human path unchanged); (2) the MCP server + session lifecycle + perception + action tools + in-page capture (the authoring engine, behind the deterministic fixture-app E2E); (3) the Draft schema + persistence + review queue + promote (behind the lifecycle API E2E + manual review click-through). Issue 1 unblocks 2; 3 is independent of 2 and can run in parallel once the contract fields exist.
- **Reuse map:** runner browser infra + secret-resolution pattern; locator-engine in-page injection harness (`__name` shim); recorder fingerprint/variable/secret/wait logic; test + baseline + diff machinery; `TestDetail` config editor; `EnvEditor` for post-promote environment wiring.
- **Glossary:** introduces **Authoring Session**, **Draft**, and **Promote** (see `CONTEXT.md`). "Promote" is deliberately distinct from "approve" (reserved for baseline/checkpoint approval).
- **Accepted risks (conscious):** credential transits the prompt during authoring; unrestricted recorded mutations replay on every future run (`DESIGN.md` risk #2).
