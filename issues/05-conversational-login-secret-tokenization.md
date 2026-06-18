# 05 · Conversational login + secret tokenization through the bridge

**Type:** AFK · **Label:** ready-for-agent · **Stories:** 10, 11, 27
**Source:** [`prd/author-with-ai.md`](../prd/author-with-ai.md) (DESIGN.md slice 15).

## What to build

Verify and harden the conversational login path through the in-product flow, reusing the existing
recorder behaviour.

- The user provides credentials in the chat; the agent reaches an auth-gated page and logs in by
  typing them via the existing `type` tool.
- Password fields tokenize to `{{secret:…}}` in the recorded Draft unconditionally; the live
  value performs the login and is **never persisted**.
- Credential values are not written to logs anywhere along the helper → relay → server path.

## Acceptance criteria

- [ ] The agent logs into an auth-gated fixture app using chat-supplied credentials and continues authoring.
- [ ] The resulting Draft tokenizes the password as `{{secret:…}}`; the plaintext appears in no persisted artifact.
- [ ] No credential value is emitted to server or helper logs.
- [ ] A deterministic test asserts the tokenized step and the absence of plaintext in the saved definition.

## Blocked by

- #03 (Bridge Helper drives the Agent SDK; conversation mirrored)
