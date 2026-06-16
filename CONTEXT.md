# Varys

Visual-regression test automation: record → baseline → rerun → compare, with an
optional Claude/MCP layer that can author tests by driving a live browser session.

## Language

**Authoring Session**:
A live, server-side Playwright browser session that Claude drives (via the MCP server)
to author a test — perceiving the page and performing actions while Varys captures the
resulting steps. Distinct from a Run, which replays an already-saved test.
_Avoid_: live session, recording session (when Claude-driven)

**Run**:
A server-side replay of a saved test against one environment, producing checkpoint
diffs against the approved baseline.
_Avoid_: execution, playback

**Checkpoint**:
A named screenshot target within a test whose image is diffed against a per-environment
baseline. The unit of visual review.
_Avoid_: snapshot, assertion

**Draft**:
An AI-authored test that has not yet been promoted — a first-class test with a full
definition, but excluded from suites and schedules and surfaced in a review queue until a
human accepts it. (Human-recorded tests are active on create and are never drafts.)
_Avoid_: staging test, pending test

**Promote**:
The human action that accepts a Draft: assign it a folder + tags and make it active
(eligible for suites and schedules). Distinct from baseline approval, which remains a
separate per-environment gate.
_Avoid_: publish; approve (reserved for baseline/checkpoint approval)
