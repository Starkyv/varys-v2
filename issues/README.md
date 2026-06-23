# Implementation issues

No issue tracker is configured for this repo, so issues live here as markdown (consistent
with PRDs in `prd/`); the `ready-for-agent` label is conceptual. Each issue is an
independently-grabbable vertical slice.

## Slice 15 — Author with AI

Tracer-bullet slices for [`prd/author-with-ai.md`](../prd/author-with-ai.md) (DESIGN.md
**slice 15**).

Dependency order:

```
0 (terms + spike, HITL) ───────────────┐ gates GA of 3 (not its dev)
1 (live preview, AFK) ──▶ 2 (pairing + relay, HITL) ──▶ 3 (helper + mirror) ──┬─▶ 4 (steering)
                                                                              └─▶ 5 (login)
```

| #  | Slice                                                | Type      | Label                       | Blocked by |
|----|------------------------------------------------------|-----------|-----------------------------|------------|
| 00 | Terms + Agent-SDK-on-subscription spike              | HITL      | needs-decision              | —          |
| 01 | Live preview of an Authoring Session                 | AFK       | ready-for-agent             | —          |
| 02 | Pairing + relay pipe                                 | HITL      | needs-design                | 01         |
| 03 | Bridge Helper drives Agent SDK; conversation mirror  | HITL→AFK  | ready-for-agent (after 00)  | 00, 01, 02 |
| 04 | Steering & lifecycle                                 | AFK       | ready-for-agent             | 03         |
| 05 | Conversational login + secret tokenization           | AFK       | ready-for-agent             | 03         |

**Start with 01** — it ships value with no Bridge Helper (watch today's Claude-Code-driven
authoring live in Varys) and de-risks the live-frame channel. **00** can run in parallel and
gates the GA of 03.

## Slice 16 — Locator editor + live verify

Tracer-bullet slices for [`prd/locator-editor-live-verify.md`](../prd/locator-editor-live-verify.md)
(DESIGN.md **§14 / slice 16**). Linear chain — grab top-down.

```
1 (edit signals) ──▶ 2 (raw override) ──▶ 3a (verify backend) ──▶ 3b (verify UI)
```

| #  | Slice                                  | Type | Label           | Blocked by |
|----|----------------------------------------|------|-----------------|------------|
| 1  | [Edit structured signals](locator-1-edit-structured-signals.md) | AFK  | ready-for-agent | —  |
| 2  | [Raw selector override](locator-2-selector-override.md)         | AFK  | ready-for-agent | 1  |
| 3a | [Verify — partial-replay backend](locator-3a-verify-backend.md) | AFK  | ready-for-agent | 2  |
| 3b | [Verify — editor UI](locator-3b-verify-ui.md)                   | AFK  | ready-for-agent | 3a |

**Start with 1** — it's self-contained (no schema or matcher change) and immediately
demoable: edit a click's accessible name, save, see the new version carry it.
