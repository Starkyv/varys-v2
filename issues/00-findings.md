# 00 · Findings — Terms + Agent-SDK-on-subscription spike

**Decision: ⛔ NO-GO on the feature as currently designed** (users on their *own Claude
subscription*, mirrored into Varys) **without prior Anthropic approval.** The SDK *mechanics*
are a GO; the *subscription-billing* premise is the blocker.

This gates slices **03–05** (the conversation mirror). Do not build them on the
subscription assumption until this is resolved.

## 1. Terms — the blocker (cite + verify with Anthropic)

Per Anthropic's official Claude Agent SDK / Claude Code docs (`code.claude.com/docs/en/agent-sdk/overview`, `.../authentication`), as researched via the Claude Code guide:

> "Unless previously approved, Anthropic does not allow third party developers to offer
> claude.ai login or rate limits for their products, including agents built on the Claude Agent
> SDK. Please use the API key authentication methods described in this document instead."

Consequences:
- The Agent SDK does **not** auto-read a user's Claude Code **subscription** OAuth credentials for
  programmatic/product use. The documented, approved path for a product is **`ANTHROPIC_API_KEY`
  (pay-per-token)** — exactly the model we set out to avoid.
- Auth precedence: cloud-provider → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper`
  → `CLAUDE_CODE_OAUTH_TOKEN` → interactive `/login` (CLI only). An API key, if set, wins.
- Using customers' **subscriptions/credits** through a third-party product needs **prior Anthropic
  approval** (the policy says "unless previously approved" — so an approval path exists). There is
  also a recent support article, *"Use the Claude Agent SDK with your Claude plan"*, suggesting an
  evolving story — **so confirm the current position with Anthropic directly** before deciding.

> ⚠️ This is the Claude Code guide's reading of the public docs, not legal advice. The exact
> boundary (e.g. a helper a user runs **locally under their own login** vs. a product "offering
> claude.ai login") is nuanced — get Anthropic's explicit word for GA.

## 2. Technical feasibility — confirmed (GO)

The SDK *itself* does everything slice 03 needs (so if the credential question resolves, 03 is
buildable). Confirmed against the docs; environment check: Node 22, `@anthropic-ai/claude-agent-sdk`
resolves on npm (v0.3.x), `claude` CLI present.

- **Package / entry point:** `@anthropic-ai/claude-agent-sdk`, headless `query({ prompt, options })`
  returns an async iterable of `SDKMessage`.
- **Remote MCP:** supported — `options.mcpServers: { varys: { type: "sse" | "http", url, headers } }`,
  tools exposed as `mcp__varys__*`, gated via `allowedTools`. (Maps directly onto our existing
  `/mcp`.) The `system`/`init` message reports MCP connection status.
- **Event stream shape** (for the bridge's `BridgeHelperEvent` mapping): discriminate on
  `message.type`:
  - `system`/`init` → session id + mcp server status
  - `assistant` → `message.content[]` blocks: `text` (→ assistant event) and `tool_use`
    (`name`, `input` → tool event)
  - `result` (`success` | `error_*`) → final, carries `session_id`, `total_cost_usd`, `usage`
  - (tool *results* are fed back internally; the next `assistant` reflects them)
- **Sessions / multi-turn:** capture `session_id` from `result`, continue with
  `options.resume: sessionId` (or `continue: true`). True mid-session streaming input is limited —
  follow-ups are effectively new `query()` calls resuming the session.

Illustrative slice-03 shape (NOT installed/run here — documents the contract):

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
for await (const m of query({
  prompt,
  options: {
    mcpServers: { varys: { type: "sse", url: `${VARYS}/mcp`, headers: { /* bridge token */ } } },
    allowedTools: ["mcp__varys__*"],
  },
})) {
  if (m.type === "assistant") for (const b of m.message.content) {
    if (b.type === "text") postEvents([{ type: "assistant", text: b.text }]);
    if (b.type === "tool_use") postEvents([{ type: "tool", name: b.name, detail: JSON.stringify(b.input) }]);
  }
  if (m.type === "result") { /* turn done */ }
}
```

## 3. Architectural consequence

The **local Bridge Helper exists specifically to run on the user's own subscription**. If
subscription billing is off the table (API-key required), the helper's reason-for-being
weakens: with an API key you can run the **agent loop server-side in Varys** (the original
"embedded API" design) — no helper, no pairing needed. So this finding re-opens the
Path-1-vs-Path-2 decision from the start of the project.

## 4. Options (the user's call — business / product)

- **A. Pursue Anthropic approval** for subscription use (or confirm the evolving "Agent SDK with
  your Claude plan" path). If granted → slices 03–05 as designed (helper + bridge stand).
- **B. Varys pays the API (server-side loop).** Drop the helper; run the agent loop on Varys's
  server with an `ANTHROPIC_API_KEY`. Simpler; slice 02's relay/UI partly repurpose (web chat +
  live preview stay; the helper/pairing become unnecessary). Cost sits with Varys.
- **C. Bring-your-own credential.** Each user supplies their **own API key** (or a
  `claude setup-token` OAuth token) that the helper/server uses — permitted, billed to the user's
  own API account (not their subscription). Keeps the BYO-billing spirit and most of slice 02.
- **D. Pause 03–05.** Ship the done, credential-agnostic value (live preview + relay pipe) and
  revisit once the credential path is decided.

## 5. What was/wasn't done

- ✅ Terms go/no-go (above), from cited official docs.
- ✅ SDK contract for slice 03 documented (above).
- ⏸️ **No live billed spike run** — deliberately: a live `query()` would spend the user's quota and
  exercise the subscription path the terms restrict. Mechanics are confirmed by the docs; a
  runnable spike is deferred until the credential path (A/B/C) is chosen, since *which credential
  the spike uses* depends on that decision.
- ✅ **No app code or dependencies added** (AC) — only doc research + an `npm view`.
