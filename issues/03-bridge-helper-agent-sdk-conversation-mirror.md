# 03 · Bridge Helper drives the Agent SDK; conversation mirrored

**Type:** HITL until the slice-00 spike lands, then AFK · **Label:** ready-for-agent (after 00)
**Stories:** 1, 2, 3, 5, 7, 12, 15, 19, 24
**Source:** [`prd/author-with-ai.md`](../prd/author-with-ai.md) (DESIGN.md slice 15).

## What to build

The headline experience: a real **Bridge Helper** the user runs locally (e.g. `npx
@varys/connect`) that launches the Claude agent via the **Claude Agent SDK** under the user's own
Claude Code subscription, pointed at Varys's remote MCP Authoring Session server.

End-to-end behaviour:

- The user pairs the helper (slice 02), types a prompt in the Varys chat ("open URL X, log in,
  screenshot the dashboard"), and the helper runs the agent against the MCP — billed to the
  user's **own subscription**, no API key anywhere in Varys.
- The agent's structured event stream is **mirrored into the Varys chat**: assistant text,
  tool-use (name + input) as chips, and tool-result summaries — built from the Agent SDK's typed
  events, not terminal text.
- The live preview (slice 01) updates per step throughout.
- On `finish_session`, a **Draft** is created and a banner deep-links to the review queue. The
  agent **cannot Promote** (no such tool) — Promote stays a web-UI human action.

## Acceptance criteria

- [ ] With the helper paired, a chat prompt drives the Authoring Session on the user's own subscription (no Anthropic API key configured anywhere in Varys).
- [ ] Assistant text and tool-call / tool-result events render in the Varys chat as the agent works.
- [ ] The live preview updates per step throughout the run.
- [ ] `finish` yields a Draft in the existing review queue, with a banner deep-linking to it.
- [ ] No Promote capability is exposed to the agent or the helper.
- [ ] AI-authored Drafts remain byte-identical in shape to human recordings / the today-MCP flow (the shared recorder core is unchanged).

## Blocked by

- #00 (Terms + spike) — gates shipping to users; development may proceed against the spike's documented contract.
- #01 (Live preview)
- #02 (Pairing + relay pipe)
