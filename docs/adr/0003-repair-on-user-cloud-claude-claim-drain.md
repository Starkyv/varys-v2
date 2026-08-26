# Repair and triage execute on the user's cloud Claude, claimed from a Varys-owned queue

When a run fails on a locator it cannot resolve, Varys does **not** run an agent itself. It
enqueues a **Repair Job** (or, for failures it may not fix, a read-only **Triage Job**) and
waits for a **cloud Claude** — running on a project member's own Claude subscription — to
**claim** it over `/mcp` and drive the existing Repair Session tools. Varys keeps everything
durable and trustworthy (the queue, the pinned browser, the checkpoints, the baselines, the
audited test versions, the lease); Claude supplies only the judgement, and pays for it.

## Context

The obvious implementation is the opposite one: the worker already owns a Playwright page in
`processRun`, `app_settings.judge_api_key` already establishes that Varys may hold an Anthropic
credential and make server-side model calls, and running the Agent SDK in-process would need no
queue, no lease, and no control inversion. A future reader will find the queue and wonder why.

The reason is that Varys must not pay for agent-driven repair, and the existing device for that
— the **Bridge Helper** (ADR-0001, `bridge.service.ts`) — is a process on someone's laptop and
cannot serve a 3am schedule. A cloud Claude can, and bills the member who volunteered it.

## Considered options

- **(Chosen) Varys queues, cloud Claude drains.** Varys's `SchedulerService` stays the single
  source of truth, so the dashboard still knows what is due, queued and running. Varys holds no
  outbound credential and cannot summon anyone's Claude. The queue is project-wide and
  first-claim-wins — any member's cloud Claude may drain it, and the job records who claimed it
  so the repaired version is attributed to them. A claim is a **lease**: it expires if the
  claimer stops reporting, and the job returns to the queue.
- **(Rejected) Agent SDK in the worker, Varys-held API key.** Simplest by a wide margin and it
  would make repair synchronous and guaranteed. Rejected because Varys then pays for every
  repair on every customer's corpus, which is the cost the Bridge Helper exists to avoid.
- **(Rejected) Bridge Helper.** Already built and already bills the user, but it is local and
  attended. Unattended repair is most of the value.
- **(Rejected) Varys calls out to launch a cloud session.** Keeps one scheduling surface and a
  Varys-owned lifecycle, but requires Varys to hold a credential that can summon the user's
  cloud Claude — reintroducing exactly the trust and billing coupling we are avoiding.

## Consequences

- **Varys cannot guarantee an unattended repair ever happens.** A project whose members run no
  draining routine simply accumulates queued jobs. This must be visible in the UI, not silent.
- Repair latency is bounded by the drain interval, not by Varys. A repair is not "slow"; it is
  "unclaimed", and those are different states the UI must distinguish.
- ADR-0002's per-user OAuth gives an *attended* claimer a real identity. An **unattended**
  drainer cannot complete that flow (no browser, no human to authorize), so it authenticates
  with the scoped **Repair Agent** credential of ADR-0005 — a second issuer, not an exemption,
  so attribution and the audit trail on the repaired version still work.
- The blast radius needs its own guards, because Varys no longer controls the agent: queued
  failures are grouped into a **Failure Cluster** and repaired once per cluster, and a
  **Circuit Breaker** suppresses repair entirely above a threshold — mass failure means the app
  broke or was redesigned, which is a human decision, not drift.
- Claude may never approve a baseline. DESIGN.md §4 deletes the old baseline on replacement with
  no rollback; an agent that can approve baselines can permanently erase the evidence that a
  regression happened.
