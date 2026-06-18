# Varys authoring instructions (operator prompt)

General instructions for Claude when it authors tests through the Varys MCP server.
Anything you write here is appended to Varys's built-in authoring rules and surfaced to
Claude as MCP server `instructions` (the "middleware prompt") on every connect.

**To enable:** point the API at this file via the repo-root `.env`:

```
VARYS_AUTHORING_INSTRUCTIONS_FILE=/absolute/path/to/authoring-instructions.md
```

(or set `VARYS_AUTHORING_INSTRUCTIONS="...inline text..."` for a short prompt — the inline
var wins when both are set). This file is re-read on each connect, so edit it and reconnect
Claude — no API restart needed.

---

<!-- Write your instructions below. Examples — delete/replace with your own: -->

- Prefer `fullpage` checkpoints unless a single component is the thing under test.
- Mask any timestamp, relative-time, or random-id regions you see.
- Don't author tests against the login screen; assume an authenticated session.
- Use our naming convention for checkpoints: `<area>-<state>` (e.g. `dashboard-empty`).
