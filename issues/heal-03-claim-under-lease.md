# Slice 03 — Claim a job under a lease

**Type:** AFK · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** 01, 02

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

An authenticated agent can take exclusive ownership of one queued job, and a dead claimer cannot
strand work. This is the slice that proves the control inversion of
[ADR-0003](../docs/adr/0003-repair-on-user-cloud-claude-claim-drain.md): Varys queues, something
external claims.

New MCP tools available only to an agent principal: claim the next job, and release a claimed
one. The queue is **project-wide and first-claim-wins** — any member's agent may drain it, and
the job records who claimed it so a later repair is attributable.

A **Claim is a lease**, not a permanent assignment. It expires if the claimer stops reporting and
the job returns to the queue. Claiming is a single conditional UPDATE — the same optimistic-claim
pattern the scheduler already uses to make overlapping ticks safe — so two concurrent drainers
cannot both win the same job.

An attempt cap stops one impossible repair consuming a drainer forever.

Tests inject the clock. Do not assert lease behaviour on wall-clock timing.

## Acceptance criteria

- [x] An agent principal can claim the next queued job and receives the test, the failing step, and the brief
- [x] Two concurrent claims for the same job: exactly one succeeds, the other gets the next job or nothing
- [x] A claimed job is invisible to other claimers while its lease holds
- [x] A lease that expires without a report returns the job to `queued` and increments its attempt count
- [x] A claimed job can be explicitly released, returning it to the queue immediately
- [x] A job exceeding the attempt cap moves to a terminal state and is no longer claimable
- [x] The job records who claimed it and when
- [x] A human (non-agent) OAuth principal cannot call the claim tools
- [x] The queue view distinguishes queued, claimed, and terminal jobs
- [x] E2E: a simulated drainer over HTTP drives the whole lifecycle — no live Claude, following the simulated-helper pattern already established for the bridge relay

## Blocked by

- Slice 01 (jobs exist to claim)
- Slice 02 (an agent principal exists to claim them)

## Flags raised

- **An explicit release counts as an attempt, which the criteria did not ask for.** Only lapsed
  leases were specced to increment. Without it a drainer that claims and immediately releases an
  unfixable job loops on it forever — the exact treadmill the cap exists to stop — so both ways of
  ending a claim spend one attempt. If that is wrong, it is one line in `giveBack`.
- **The cap's terminal state reuses `failed`**, rather than adding an `abandoned` status. The
  queue legend now reads "Given up on: every attempt was spent without a repair", which is what
  a reader of that row needs to know; slice 04 will also write `failed` when a drainer reports it
  cannot fix a job, and those two are the same fact to a human.
- **The lease (15 min) and the cap (3) are constants** in `repair-jobs.service.ts`, not settings.
  Nothing in this slice needs them tunable; the circuit-breaker slice (07) is where project-level
  repair configuration arrives, and they belong with it if they should be configurable at all.
- **`GET /repair-jobs` now performs a write** — it sweeps lapsed claims before reading. Deliberate:
  a lazy sweep on the two paths that care (reading the queue, claiming from it) means there is no
  background sweeper to be down and no window where the view calls a dead drainer's job
  "in progress". `hasClaimOn` additionally checks the expiry in its predicate, so a credential's
  reach shrinks the instant its lease runs out even between sweeps.
- **Narrow race worth knowing about:** returning a lapsed claim to `queued` would violate the
  partial unique index if a second queued job for the same (test, cluster) had appeared meanwhile.
  Both enqueue paths refuse while a job is open (`queued` **or** `claimed`), so this needs a lost
  check-then-insert race to occur at all — but if the queue view ever 500s, that is where to look.
- **The Brief is `tests.intent` and has no write path outside AI authoring yet** (slice 05 makes it
  editable), so the E2E states it with SQL to prove a claim carries it.
- Slice 01's E2E simulates a claim with raw SQL and leaves `claim_expires_at` NULL. The sweep
  treats NULL as "no deadline", so that fixture still behaves as it did; every real claim carries
  an expiry, because only `claimNext` creates one.
