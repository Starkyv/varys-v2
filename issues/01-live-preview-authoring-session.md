# 01 · Live preview of an Authoring Session in the web app

**Type:** AFK · **Label:** ready-for-agent · **Stories:** 6, 9
**Source:** [`prd/author-with-ai.md`](../prd/author-with-ai.md) (DESIGN.md slice 15).

## What to build

Let a signed-in user **watch a running Authoring Session live in the Varys web app**, with no
Bridge Helper required — demoable against today's MCP flow (drive authoring from your own Claude
Code, watch it in Varys).

End-to-end behaviour:

- The server captures a screenshot of the Authoring Session's page **after each mutating tool**
  (click, type, navigate, checkpoint) and exposes it as a live frame stream, keyed by Authoring
  Session.
- This channel is **decoupled from the model's perception** — the agent only receives a
  screenshot when it itself calls `observe(screenshot:true)`. These frames are a separate,
  human-only channel and cost no inference.
- A signed-in user can discover the **active Authoring Sessions** and select one to watch.
- The web app renders a **live-preview pane** (page screenshot, updating per step) alongside a
  **step / checkpoint tape** that reflects the recorded steps as they accumulate. Reuse the
  existing zoomable-image and review surfaces.
- Frame capture is best-effort: a failed screenshot never disrupts the Authoring Session.

## Acceptance criteria

- [ ] Driving authoring via the existing MCP path produces a live screenshot in the web pane that updates after each click/type/navigate/checkpoint.
- [ ] No frame is emitted for `observe`/`hover`/`wait`, and none after `finish_session`/teardown.
- [ ] The agent's token usage is unchanged by the preview (frames are never sent to the model).
- [ ] The step/checkpoint tape reflects each recorded step and proposed checkpoint.
- [ ] A signed-in user can discover and select an active Authoring Session to watch; unauthenticated access is rejected.
- [ ] The resulting Draft still lands in the existing review queue, unchanged.
- [ ] A deterministic API test (no LLM) drives the tool layer and asserts frames emit on mutating tools only.

## Blocked by

None - can start immediately.
