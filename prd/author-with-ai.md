# PRD — Varys "Author with AI": in-product authoring on the user's own Claude subscription

> **Status:** ready-for-agent (conceptual — see tracker note). **Slice 15** of `DESIGN.md` §13
> (Claude / MCP automation).
>
> **Tracker note:** no issue tracker is configured for this repo (no git remote / `gh`); PRDs
> live in `prd/` and the `ready-for-agent` label is conceptual — consistent with every prior
> slice (see `prd/claude-mcp-authoring.md`).
>
> **Lineage.** This picks up the item explicitly deferred in `prd/claude-mcp-authoring.md`
> (Out of Scope #6: *"In-product embedded AI button — authoring is via Claude Code + MCP
> only"*). It delivers that in-product experience **without** Varys paying for inference, by
> keeping the model running on **each user's own Claude Code subscription** via a small local
> **Bridge Helper**. The today-flow (a user connects their own Claude Code directly to the
> public `/mcp`) remains supported and unchanged; this is an additional, richer surface.
>
> **Governed by [ADR 0001](../docs/adr/0001-mcp-authoring-server-side-shared-core.md):**
> server-side Playwright **Authoring Session**, steps built through the shared `@varys/recorder`
> core (A1 perform-then-capture). The Bridge changes *who drives the MCP tools* (the user's
> Claude Code, via the helper, instead of via their own terminal) — it does **not** change the
> Authoring Session, the recorder core, the Draft model, or Promote.

---

## Problem Statement

A user who wants AI to author a Varys test today has to leave Varys entirely: open Claude Code
in a separate terminal or app, wire up the Varys MCP server, type their prompt there, and watch
a wall of tool-call text — with no live view of the browser. The conversation lives in one
place (Claude Code), the live browser lives nowhere they can see, and the review/promote step
lives in Varys. It feels like operating three disconnected tools to author one test.

The user wants to do it all in Varys: open a chat, say *"go to this page, log in, click the
Reports tab, screenshot it,"* and **watch the browser act live as they talk**, with the test
building up in front of them — then review and promote it where they already are.

But there's a hard constraint they (reasonably) expected to work and doesn't: a Varys-hosted
chat would mean **Varys's** servers calling Claude — i.e. the paid Anthropic **API**, billed
per token to Varys — and their **Claude Pro/Max subscription cannot pay for that**. A
third-party web app cannot spend a user's subscription quota, and there is no remote API to tap
a Claude Code session the app didn't launch. So "chat embedded in Varys" and "billed to the
user's own subscription" appear mutually exclusive.

## Solution

**Author with AI** — an in-product authoring surface in the Varys web app, with inference on
the **user's own Claude subscription**, made possible by a small local **Bridge Helper**:

- The user runs the **Bridge Helper** once on their machine (e.g. `npx @varys/connect`). It
  authenticates to Varys (a short pairing code shown in the web UI links it to their account)
  and launches the Claude Code agent locally via the **Claude Agent SDK**, under the user's own
  **local Claude Code login** — so inference is billed to *their* Pro/Max plan, not Varys.
- The user converses in **Varys's web UI**. Each prompt is relayed down to their Bridge Helper,
  which feeds it to the agent. The agent is configured with **Varys's existing MCP Authoring
  Session server** (remote), so it drives the same server-side Playwright browser and the same
  capture/fingerprint/variable/secret/wait logic a human recording uses.
- The agent's **structured event stream** (assistant text, tool calls, results) is relayed
  back up and **mirrored into the Varys chat** — not terminal scraping, the real event stream.
- Because the browser runs on **Varys's** server, Varys streams a **live screenshot preview**
  into the web UI after each step (decoupled from what the model sees), plus a running tape of
  the recorded steps and checkpoints.
- On finish, the result is a **Draft** in the existing **review queue**, reviewed and
  **promoted** exactly as today. The agent still cannot self-promote.

So: **talk in Varys, watch the browser live in Varys, review in Varys — paid for by your own
Claude subscription.** The heavy browser stays server-side (as today); only the lightweight
agent brain runs locally on the user's machine.

## User Stories

1. As a test author with a Claude Pro/Max subscription, I want to author Varys tests by chatting inside the Varys web app, so that I don't have to operate a separate terminal/Claude Code window.
2. As a test author, I want the AI's inference billed to my own Claude subscription, so that I don't need an Anthropic API key or a per-token bill.
3. As a test author, I want to run a one-time local Bridge Helper that links to my Varys account, so that my own Claude Code login powers the authoring without exposing my credentials to Varys's servers.
4. As a test author, I want to link the helper to my web session with a short pairing code shown in the UI, so that the conversation routes to the right browser session securely.
5. As a test author, I want to type "open this URL, log in as X, go to the dashboard, screenshot it" in the Varys chat, so that the agent authors the flow conversationally.
6. As a test author, I want to watch a live screenshot of the browser update after each action, so that I can see what the AI is doing as I talk.
7. As a test author, I want the agent's messages and the tools it's calling mirrored into the Varys chat, so that I can follow its reasoning and intervene without switching apps.
8. As a test author, I want to send a follow-up message mid-flow ("also screenshot the Reports tab"), so that I can steer the Authoring Session incrementally.
9. As a test author, I want to see the test's recorded steps and proposed checkpoints accumulate in a tape as the session runs, so that I know what's being captured.
10. As a test author, I want to provide login credentials in the conversation and have the agent log in for me, so that it can reach auth-gated pages.
11. As a test author, I want passwords I provide to be tokenized as `{{secret:…}}` in the recorded test and never persisted, so that a real credential never lands in the test definition.
12. As a test author, I want a clear banner when a Draft is created, linking me straight to the review queue, so that the hand-off to review is seamless.
13. As a test author, I want to cancel a running Authoring Session from the chat, so that I can stop a flow that's going the wrong way and the server-side browser is torn down.
14. As a test author, I want a clear message if my Bridge Helper isn't running or has disconnected, so that I know to start it before chatting.
15. As a test author, I want my Claude Code subscription's usage limits to apply normally, so that authoring draws from the plan I already pay for.
16. As a reviewer, I want AI-authored Drafts from the in-product flow to appear in the same review queue as today, so that there's one place to accept AI output.
17. As a reviewer, I want to open, tune, run-to-seed-baselines, and Promote those Drafts in the existing surfaces, so that nothing about review changes.
18. As a reviewer, I want the agent to be unable to Promote from the chat, so that a human always looks at the diff before a test goes active.
19. As a team, we want anyone with a Claude Code subscription to be able to use Author with AI, so that AI authoring isn't gated on a shared API budget.
20. As a Varys operator, I want each Authoring Session to be a fresh server-side browser context torn down on finish/cancel/disconnect, so that resources are reclaimed.
21. As a Varys operator, I want the in-product authoring endpoints to require an authenticated Varys session (unlike the public `/mcp`), so that only signed-in users can drive a browser on the server.
22. As a Varys operator, I want orphaned Authoring Sessions (helper disconnected, never returned) swept after a TTL, so that headless browsers don't leak.
23. As a developer, I want the Bridge Helper to drive Varys's **existing** MCP tools, so that AI-authored tests stay byte-identical to human recordings and the today-flow is unaffected.
24. As a developer, I want the conversation mirror built from the Agent SDK's structured event stream (not terminal text), so that the UI renders typed events (assistant text, tool name+input, result).
25. As a developer, I want the live preview captured server-side and decoupled from the model's vision, so that watching every step costs no inference tokens (the model only "sees" a screenshot when it calls `observe`).
26. As a developer, I want the relay's protocol testable with a simulated helper and no live Claude, so that I can verify the plumbing deterministically.
27. As a security-conscious user, I want credentials I type to stay out of logs and not be persisted, so that the convenience of conversational login doesn't leak secrets.
28. As a Varys operator, I want the legal/terms position on relaying Claude Code output into a commercial UI confirmed before GA, so that we don't ship something outside Anthropic's terms.

## Implementation Decisions

**Topology — agent local, browser server-side.**
- The **Authoring Session** (server-side Playwright) and all MCP tools stay on Varys's server, unchanged (ADR 0001). The **Bridge Helper** runs only the agent brain locally and connects to Varys's MCP over the network. The helper carries no browser.
- Inference auth is the user's **local Claude Code login**, consumed by the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) inside the helper. Varys never holds the user's Claude credentials and never picks a model — the user's Claude Code/subscription determines model access.

**Bridge Helper (net-new — a small distributable package).**
- Pairs to the user's authenticated Varys session via a short-lived **pairing code** issued by the server and shown in the web UI.
- Runs the Agent SDK configured with **Varys's MCP Authoring Session server** as an MCP tool source, scoped to the paired session (a pairing-scoped token on its MCP/relay connection so the server can correlate the Authoring Session to the chat).
- Opens a persistent connection to the **Server Relay**: receives user prompts (web → helper), forwards them into the agent, and streams the agent's structured events (helper → web).

**Server Relay (net-new — authenticated, NOT `@Public`).**
- A per-chat broker: a WebSocket (or equivalent) connection for the paired helper, and a stream to the web UI, brokering prompts down and events up. One chat = one Authoring Session = one helper connection.
- Reuses the per-session in-memory model the Authoring Session already uses; **process-local**, so it inherits the same single-instance / sticky-routing constraint documented for Authoring Sessions today (acceptable; documented, not solved here).
- Lifecycle: kick on first prompt; queue a second prompt sent mid-run and drain at end-of-turn; cancel tears down the Authoring Session; an idle-TTL sweep reclaims orphaned browsers on disconnect.

**Live preview (net-new, server-side; decoupled from model vision).**
- Add a `screenshot(sessionId)` accessor to the Authoring Session service (the logic already exists inside its snapshot path) and stream a frame to the web UI **after each mutating tool** (`click`/`type`/`navigate`/`checkpoint`); skip `observe`/`hover`/`wait` and after `finish`. Frame capture is best-effort and never breaks the session.
- This channel is independent of the model's perception: the model only receives a screenshot when it itself calls `observe(screenshot:true)`. Watching every step is therefore free of inference cost.

**Conversation mirror.**
- Built from the Agent SDK's typed message stream: assistant text deltas, tool-use (name + input), tool-result summaries, and a Draft-created event. Rendered as a chat + tool-call chips, not raw terminal output.

**Login & secrets (reused, unchanged policy).**
- Conversational: the user supplies credentials in chat; the agent types them via the existing `type` tool. Password fields tokenize to `{{secret:…}}` unconditionally; the live value performs the login and is never persisted. No environment/vault binding during authoring (env wiring happens post-promote via the existing `EnvEditor`).

**Draft, review, and the Promote forcing-function (reused, unchanged).**
- Finish persists a **Draft** (`status='draft'`, `origin='ai'`) through the existing pipeline; it appears in the existing review queue and is tuned/promoted in the existing surfaces. **Promote is never exposed to the agent or the bridge** — it remains a human action in the web UI, preserving the structural guarantee that a human saw the diff before a test goes active.

**Contract / surface additions.**
- A small chat/session read-model and event protocol for the relay (chat id, status, the mirrored-event union, the live-frame channel) added alongside the existing `@varys/review-contract` shapes. No change to the Draft/Promote contract.

## Testing Decisions

A good test asserts **external behaviour** — the relay's event protocol, the live-frame
emission, and the Draft produced — never implementation details, and **never a live LLM or a
live Claude subscription** (the model's judgment and the Anthropic auth handshake are out of
scope to test; the machinery is in scope).

- **Bridge Helper — unit tests (new seam, faked Agent SDK).** Feed the helper a scripted,
  in-memory Agent SDK message stream and assert it maps to the relay event protocol correctly,
  and that an inbound web prompt is forwarded into the agent input. No network, no live Claude.
- **Server Relay + live preview — API E2E (deterministic, no LLM).** Prior art:
  `apps/api/test/authoring.e2e.spec.ts` (drives the MCP tool layer with a hand-written
  sequence, no LLM) and `apps/api/test/auth.e2e.spec.ts` (guarded endpoints). With a
  **simulated helper**, assert: pairing/auth required; a prompt is relayed; scripted tool
  activity fans out as mirrored events; live frames are emitted after mutating tools; `finish`
  yields a Draft.
- **Authoring tools + Draft lifecycle — unchanged, reuse existing E2E.**
  `apps/api/test/authoring.e2e.spec.ts` and `apps/api/test/drafts.e2e.spec.ts` already cover the
  tool layer and the draft → exclude-from-suites → promote lifecycle; assert they still pass
  (additive change).
- **Shared recorder core — unchanged.** `packages/recorder/src/index.spec.ts` continues to
  guarantee human↔agent parity; no change expected.
- **Author with AI web view — manual click-through.** No UI/component tests (consistent with
  the repo's posture for review/dashboard UI).
- **Explicitly not tested:** Claude's reasoning/coverage quality; the subscription auth
  handshake; screenshot pixel fidelity.

## Out of Scope

- **The Varys-hosted / API-key model** (Varys's backend calls the Anthropic API and absorbs or
  charges per-token cost) — deliberately rejected for this PRD in favour of the user's own
  subscription. It remains a possible future premium tier.
- **Tapping a Claude Code session the user started independently** in Anthropic's own app — not
  possible; the helper must be the launcher to own the stream.
- **Horizontal scale of Authoring Sessions** beyond the existing process-local / sticky-routing
  constraint.
- **Seeded-auth via Environments** during authoring (login stays conversational).
- **Promote / review from the chat or Claude Code** — web-UI only, preserved.
- **Voice input** ("as I talk" is conversational typing for v1; a mic is a trivial later add).
- **True video screencast** — stop-motion screenshot frames only.
- **Bridge Helper distribution polish** (signed installers, auto-update infrastructure) beyond a
  runnable `npx`/CLI for v1; **non-mainstream platforms**.
- **Mutation detection / gating** (unchanged from `prd/claude-mcp-authoring.md`).

## Further Notes

- **Gating legal check (before GA, not before build):** confirm Anthropic's terms permit
  relaying Claude Code (Agent SDK) output into a commercial product UI. Running it locally under
  the user's own login is the defensible posture, but the redistribution/embedding angle must be
  cleared.
- **Accepted risks (conscious):** credentials transit the conversation (now via the helper +
  relay) — held only in memory for the session, never logged, secret-tokenized in the recorded
  test; the Bridge Helper is trusted local software running under the user's Claude Code login.
- **Glossary additions** (`CONTEXT.md`): **Bridge Helper** (the user's local process that runs
  the Claude Agent SDK on their subscription and relays it to Varys) and **Author with AI** (the
  in-product authoring surface). **Authoring Session**, **Draft**, **Promote**, **Checkpoint**
  are used per their existing definitions.
- **Reuse map:** MCP server + tool registry + Authoring Session service; the Draft → review
  queue → Promote pipeline; `resolveAuthoringInstructions()` as the agent's steering prompt; the
  `TestDetail`/diff review surfaces; `EnvEditor` for post-promote env wiring.
- **Natural issue split (for `/to-issues`):** (1) `screenshot(sessionId)` + live-frame channel +
  chat↔session correlation (server; behind a deterministic frame-emission E2E) — delivers the
  live preview alone; (2) the Server Relay + pairing/auth + event protocol (behind the relay API
  E2E with a simulated helper); (3) the Bridge Helper package (Agent SDK + relay client; behind
  faked-SDK unit tests); (4) the Author with AI web view (manual click-through). (1) is
  independent and ships value immediately; (2)+(3) together deliver the conversation mirror;
  (4) is the surface over all of them.
