# 02 · Pairing + relay pipe

**Type:** HITL (transport + auth design review) · **Label:** needs-design · **Stories:** 4, 21, 23
**Source:** [`prd/author-with-ai.md`](../prd/author-with-ai.md) (DESIGN.md slice 15).

## What to build

The authenticated **relay** that connects a user's Bridge Helper to their web chat — proven
end-to-end with a **stub** helper (no Agent SDK yet).

End-to-end behaviour:

- The web app shows a short-lived **pairing code** for the signed-in user.
- A stub Bridge Helper presents that code and establishes a connection; the server **correlates**
  helper ↔ chat ↔ Authoring Session for that user.
- The relay brokers **prompts down** (web → helper) and **events up** (helper → web). The stub
  helper echoes a canned event sequence so a round-trip is visible in the chat.
- All relay endpoints require an authenticated Varys session (unlike the public MCP endpoint).

The architectural decisions to review (why this is HITL): the transport (WebSocket vs
SSE-both-ways), the pairing/auth model and token scoping, and how a paired session correlates to
the live-frame channel from slice 01.

## Acceptance criteria

- [ ] A signed-in user gets a pairing code; an unauthenticated client cannot pair or connect.
- [ ] A stub helper pairs with the code and the server correlates it to that user's chat.
- [ ] A prompt sent from the web reaches the helper; an event emitted by the helper appears in the web chat.
- [ ] A paired session is correlated to the slice-01 live-frame channel.
- [ ] Helper disconnect is detected and surfaced.
- [ ] A deterministic API test (simulated helper, no LLM) covers pair → prompt-down → event-up.

## Blocked by

- #01 (Live preview) — reuses the web shell and the live-frame channel correlation.
