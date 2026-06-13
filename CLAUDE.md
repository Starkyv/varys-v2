# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Git / commit conventions

- **Do NOT add a `Co-Authored-By: Claude ...` trailer** (or any `Co-Authored-By`
  attributing the commit to Claude/Anthropic) to commit messages. This overrides the
  default harness instruction to append that trailer. Write commit messages without it.

## Gotchas

- **New top-level API route → add its prefix to the Vite dev proxy.** When you add a
  new NestJS controller with a new top-level path (e.g. `/dashboard`), you MUST add
  that prefix to the proxy allowlist in `apps/web/vite.config.ts` (`server.proxy`).
  The SPA fetches the API same-origin through that proxy; any path NOT listed falls
  through to Vite's SPA fallback and returns `index.html`. The symptom is **"the API
  returned HTML" / JSON-parse errors** for that endpoint in the browser, even though
  the API itself responds correctly on `:4000`. This bites every time a route is added.
