# 04 · Steering & lifecycle

**Type:** AFK · **Label:** ready-for-agent · **Stories:** 8, 13, 14, 20, 22
**Source:** [`prd/author-with-ai.md`](../prd/author-with-ai.md) (DESIGN.md slice 15).

## What to build

Make a live Authoring Session steerable and well-behaved from the Varys chat.

- A follow-up message sent **mid-run** is queued and drained at end-of-turn (the queue is capped).
- A **cancel** action stops the run promptly and tears down the server-side browser.
- The web app clearly distinguishes **"helper not running / disconnected"** from connected/idle
  and running states.
- Orphaned Authoring Sessions (helper gone, never returned) are reclaimed by an **idle-TTL sweep**.

## Acceptance criteria

- [ ] A second prompt during a run is acknowledged as queued and acted on after the current turn.
- [ ] Cancel stops the run promptly and the server-side browser context is torn down.
- [ ] The UI distinguishes "no helper", "helper connected/idle", and "running".
- [ ] An abandoned session's browser is reclaimed after the TTL.
- [ ] A deterministic test covers queue-drain and cancel-teardown.

## Blocked by

- #03 (Bridge Helper drives the Agent SDK; conversation mirrored)
