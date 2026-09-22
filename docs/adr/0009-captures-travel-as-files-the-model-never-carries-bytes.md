# Captures travel as files; the model never carries the bytes

A screenshot reaches Varys as a **file** and by exactly one of two routes: `imagePath`, when the
agent and Varys are the same machine, or `imageRef` — a handle minted by POSTing the file to an
**upload URL that an authenticated tool call handed back**. The base64 argument (`image`) is
removed from the tool schema *and* refused by the server. `/mcp/uploads/:slot` reads no
`Authorization` header: the unguessable slot in the path is the capability, and it resolves to the
principal of the tool call that minted it.

## Context

[ADR 0007](./0007-no-server-side-browser-for-agent-driven-runs.md) put the browser on the author's
own machine for agent-driven tests and runs. That is still right, and it created this problem: the
bytes now start somewhere Varys cannot reach, so something has to carry them.

For a deployed Varys, that something was the model. `imagePath` is loopback-only — it names a file
on whichever machine is running the API — so every remote caller fell through to base64 inside the
tool call. The cost of that is not a detail:

- **A model can perceive an image but can never carry one.** A screenshot returned by a capture
  tool arrives as vision tokens, and no operation turns those back into PNG bytes. So filling
  `image` meant reading the base64 in as *text* (~100k tokens for an ordinary full-page capture)
  and writing every character of it back out (~100k more), serially, before the tool call could be
  made. Roughly 95% of the wall-clock time of a checkpoint was this round trip.
- **It ended at a cliff rather than a limit.** The output cap truncates the string, and
  `Buffer.from(s, "base64")` does not throw on a truncated one — it returns the prefix, a
  perfectly-formed half-image with an intact signature. `png.ts` grew an IEND check for exactly
  this, which converts a silently-wrong baseline into a refusal, and a refusal into a retry that
  pays the whole cost again.
- **The workaround it invited was the worst part.** Facing an output cap, the reasonable thing for
  an agent to do is crop or shrink the capture until it fits — degrading the one artifact a human
  is going to approve as a baseline.

An upload endpoint was added first, and did not fix it, for a reason worth recording: it demanded
the OAuth bearer. That token lives in the MCP *client's* credential store, not in the agent's
shell, so `curl -H "Authorization: Bearer $TOKEN"` named a variable that does not exist on any
machine. The preferred route was one the agent could not take, so it kept taking the slow one.

## Considered options

- **(Chosen) A capability URL, minted on every agent tool response.** The agent already makes
  these calls, so the freshest URL is always in front of it — expiry stops being a state it has to
  reason about, and there is no `request_upload` round trip before each capture.
- **(Rejected) A scoped upload bearer.** Functionally equivalent, but it puts a second issuer on
  `/mcp` — precisely what [ADR 0008](./0008-attended-repair-only-no-queue-no-versions.md) removed
  when it deleted the drainer credential. A capability in a URL needs no issuer and nothing to
  revoke; it expires.
- **(Rejected) A static `VARYS_TOKEN` in the agent's environment.** A new issuer *and* per-machine
  human setup, to solve a problem the tool response can solve for free.
- **(Rejected) Keep `image` as a documented last resort.** This is what we had. The schema already
  said `PREFERRED` and `LAST resort`, and the model still reached for the route that needed no
  shell. Advice did not change behaviour; removing the field did.

## Consequences

- **An MCP client with no shell can no longer submit a capture at all.** Accepted: ADR 0007's
  agent drives a local browser with Chrome DevTools, Playwright or computer use, none of which a
  shell-less client can do either. It was never a viable caller for these tools.
- **The refusal has to be recoverable, and it is.** `decodePng` runs *before* any row is written in
  both flows, so a refused capture leaves nothing behind — no half-filled Manifest slot, no burnt
  checkpoint name. The retry is clean, which is what makes server-side enforcement safe.
- **Enforcement lives in the server, not only in the schema.** MCP clients cache the tool list, so
  an agent mid-session goes on offering a field that no longer exists. The schema stops the model
  *choosing* base64; only the server stops the route *existing*. Both are needed, and the refusal
  carries the caller's own minted URL so it is one step from acting on.
- **A capture that was never written to disk cannot be submitted.** This is a real constraint on how
  agents capture, not a transport detail, so it is stated plainly in the instructions and in every
  refusal.
- **The stored authoring prompt had to be retired** (`authoring_instructions_base_v2` →
  `_v3`, orphan dropped in the bootstrap DDL). The base prompt is a contract with the tool surface:
  an override saved before this change would keep teaching a route that no longer exists, on
  exactly the deployments that had bothered to customise it.
- **The route a capture arrived by is logged and not stored.** It answers an operator's question —
  "is anything still trying to push bytes through the model?" — and stops being interesting once
  the answer is no. A column would have outlived the question.
