# 00 · Terms + Agent-SDK-on-subscription spike

**Type:** HITL (decision + spike) · **Label:** needs-decision · **Stories:** 28
**Source:** [`prd/author-with-ai.md`](../prd/author-with-ai.md) (DESIGN.md slice 15).

## What to build

A decision plus a throwaway spike — **not** production code. Two questions must be answered
before the conversation-mirror slices (03–05) can ship to real users:

1. **Terms.** Confirm Anthropic's terms permit relaying Claude Code / Claude Agent SDK output
   into Varys's commercial product UI, given the model runs locally under the user's **own**
   Claude Code subscription login and Varys only mirrors the structured event stream.
2. **Feasibility spike.** Prove a small program using the Claude Agent SDK runs headlessly under
   a developer's own Claude Code subscription login (no API key), configured with a **remote**
   MCP server, and yields a usable structured event stream (assistant text, tool-use,
   tool-result) plus a way to feed it a prompt.

Capture the findings — a go/no-go on terms, and the SDK's auth + remote-MCP-config + event-stream
shape — so slice 03 can build against a known contract. The spike code is disposable.

## Acceptance criteria

- [ ] A written go/no-go on the terms question, with reasoning and any conditions.
- [ ] A spike demonstrating the Agent SDK driving a remote MCP under subscription auth, with the event stream observed.
- [ ] The event-stream shape (message / tool-call / tool-result types) and the prompt-input mechanism are documented for slice 03.
- [ ] No production code or dependencies added to the app from the spike.

## Blocked by

None - can start immediately. **Gates the GA of slices 03–05** (their development may begin in
parallel against the documented spike contract).

## Findings

See [`00-findings.md`](./00-findings.md). **Outcome: ⛔ NO-GO on the subscription model without
prior Anthropic approval** — the Agent SDK's documented product path is `ANTHROPIC_API_KEY`
(pay-per-token); using customers' Claude *subscriptions* via a third-party product is not allowed
unless previously approved. SDK *mechanics* (headless `query()`, remote MCP, event stream) are
confirmed and documented for slice 03. No live billed spike was run and no app deps were added.
