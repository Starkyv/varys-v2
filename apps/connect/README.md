# `@varys/connect` — the Bridge Helper

The process you run on **your own machine** so that pressing **Run** on an Agent-Driven Test in
Varys starts a session with **your** Claude, on **your** subscription.

Varys hosts no browser for this kind of test and holds no key that can summon a model. It asks;
this listens; your Claude does the work. That is the whole design, and this program is the only
part of it that lives outside Varys.

## Use it

### Against a deployed Varys

No checkout needed — install it from the Varys you are using, which also guarantees it is never
older than that Varys:

```bash
VARYS_API=https://varys.example.com \
  npx https://varys.example.com/downloads/varys-connect.tgz <pairing-code>
```

The pairing panel shows this line with your own origin already filled in.

### From a checkout (local development)

`pnpm connect` resolves against that workspace and nowhere else:

```bash
cd /path/to/varys-v2
pnpm connect <pairing-code>
```

**Where Claude runs is a separate question from where the helper runs.** The helper launches Claude
in `VARYS_CONNECT_CWD`, which defaults to the directory you started the helper in — so the `cd`
above would point the agent at the Varys repo, which is almost never what you want. Name the
project you actually want it working in:

```bash
cd /path/to/varys-v2
VARYS_CONNECT_CWD=/path/to/your-project pnpm connect <pairing-code>
```

The code comes from the Varys web app — open an Agent-Driven Test, and the **Run this test** card
offers **Pair a helper**. Codes are single-use and expire in two minutes.

Leave it running. The Run button in Varys is live for exactly as long as this process is holding
its connection — that is not a coincidence, it is the same fact reported honestly.

## Before it can work

**Claude Code must be installed, signed in, and pointed at Varys's MCP server** — the spawned
Claude reaches Varys as *you*, over OAuth, which is what lets Varys attribute the resulting Run to
the press you made in the browser:

```bash
claude mcp add -s user --transport http varys http://localhost:5174/mcp
```

`-s user` matters: the helper launches Claude in `VARYS_CONNECT_CWD` (defaulting to wherever you
started the helper), and a server added at the default `local` scope is invisible from any other
directory. A Claude that cannot see `start_agent_run` launches, finds nothing to call, and the
request lapses for a reason nothing on screen explains.

## What it will and won't do

- It **never creates a Run.** Only `start_agent_run`, called by the spawned Claude as you, does
  that. This process could not report a run into existence if it wanted to — which is exactly why
  Varys can believe a Run that says it came from the web app.
- It holds **no Anthropic API key** and **no Varys session cookie**. Its one credential is a
  bridge token scoped to a single chat, good for reading commands and mirroring events back.
- It passes the **test id** through verbatim and tells Claude to use that id. It never looks a
  test up by name — "the wrong test ran" is the failure the id exists to prevent.
- It **acknowledges before it launches**, so "your helper answered but Claude would not start" and
  "nothing was listening at all" stay distinguishable in the web app.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `VARYS_API` | `http://localhost:4000` | The Varys API origin to pair with. |
| `VARYS_CONNECT_CWD` | current directory | Where the spawned Claude runs — its `CLAUDE.md`, its MCP servers, its files. |
| `VARYS_CONNECT_PERMISSION_MODE` | `bypassPermissions` | How the spawned Claude answers its own permission prompts. |

**About that default.** Nothing is watching the spawned Claude's stdin, so any mode that stops to
ask is a mode that hangs until the Wall-Clock Lease runs out — and the run then goes red for a
reason that has nothing to do with your application. Walking a journey means driving a browser, and
which tooling that takes is not knowable in advance. If you want it tighter, set the variable, and
know that a prompt nobody answers is a session that stalls.

## Not on npm, deliberately

`@varys/connect` is `private`, and there is no registry account in the loop. A deployed Varys
builds this tarball into its web image and serves it from `/downloads/varys-connect.tgz`, which is
the same trick the recorder extension already uses — and it has a property publishing does not:
the helper a user installs came from the exact Varys they are pairing with, so a version skew
between the two is not representable.

It has **no runtime dependencies**. Its only import of `@varys/review-contract` is `import type`,
erased at build, which is why that package is a devDependency and why the tarball installs
standalone.
