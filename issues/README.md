# Author with AI — implementation issues

Tracer-bullet slices for [`prd/author-with-ai.md`](../prd/author-with-ai.md) (DESIGN.md
**slice 15**). No issue tracker is configured for this repo, so issues live here as markdown
(consistent with PRDs in `prd/`); the `ready-for-agent` label is conceptual.

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
