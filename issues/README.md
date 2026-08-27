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

## Slice 17 — Run outcome — test-runner status model

Tracer-bullet slices for [`prd/run-outcome-baseline-vs-verified.md`](../prd/run-outcome-baseline-vs-verified.md)
(DESIGN.md **§4 / §8 / slice 17**). All AFK — the decisions are locked in the PRD; no mandatory schema
change (outcome is derived from data already stored). The derived `RunOutcome` follows the **test-runner
model**: **Pending baseline** (first run, awaiting approval) → **Baseline** (set/updated reference) →
**Passed** (matched) / **Failed** (diff or crash); no Reject. Slice 1 is the foundation (the shared
`deriveRunOutcome` helper + the status vocabulary); 2–5 fan out from it.

```
1 (derived outcome + run-detail badge) ─┬─▶ 2 (runs list + test history)
                                         ├─▶ 3 (matrix + suite runs)
                                         ├─▶ 4 (re-baseline a passed actual) ──▶ 6 (sourceRunId audit · deferred)
                                         └─▶ 5 (pass-rate excludes baseline runs)
```

| #  | Slice                                  | Type | Label           | Blocked by |
|----|----------------------------------------|------|-----------------|------------|
| 1  | [Derived RunOutcome + run-detail badge](outcome-1-derived-runoutcome-run-detail.md) | AFK | ready-for-agent | —  |
| 2  | [Outcome on runs list + test history](outcome-2-runs-list-test-history.md)          | AFK | ready-for-agent | 1  |
| 3  | [Outcome in dashboard matrix + suite runs](outcome-3-dashboard-matrix-suite-runs.md) | AFK | ready-for-agent | 1  |
| 4  | [Re-baseline a passed actual](outcome-4-rebaseline-passed-actual.md)                | AFK | ready-for-agent | 1  |
| 5  | [Pass-rate excludes baseline runs](outcome-5-pass-rate-excludes-baseline.md)        | AFK | ready-for-agent | 1  |
| 6  | [Baseline source-run audit](outcome-6-baseline-source-run-audit.md)                 | AFK | ready-for-agent (deferred) | 4 |

**Start with 1** — it's the only one with no blocker and is immediately demoable: a first run reads
**Pending baseline**, an approved one reads **Baseline**, a matched re-run reads **Passed**, and a
diff reads **Failed** on the run page. 2–5 are independent fan-out from 1 (grab in any order). **6 is
deferred** (the sole schema touch; not needed for the core ask).

## Slice 19 — Self-healing tests: assertions + the repair queue

Tracer-bullet slices for [`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md).
ADRs: [0003](../docs/adr/0003-repair-on-user-cloud-claude-claim-drain.md) (cloud Claude claims from
a Varys-owned queue), [0004](../docs/adr/0004-brief-authored-tests-converge-no-agentic-kind.md) (no
agentic test kind), [0005](../docs/adr/0005-scoped-repair-agent-credential.md) (scoped Repair Agent
credential; amends [0002](../docs/adr/0002-mcp-oauth-per-user.md)).

Depends on **slice 18** (repair session full edit) for `edit_test`.

**Three independent entry points** — 00, 01/02, and 09. The assertions branch (09–12) is fully
independent of the queue and can run in parallel with all of it.

```
00 (wrong-fix spike, HITL) ───────────────────────── gates GA of 05

01 (policy + enqueue) ──┬──▶ 03 (claim + lease) ──┬──▶ 04 (repair → unreviewed) ──┬──▶ 05 (justification, HITL) ──▶ 06 (healed)
02 (agent credential) ──┘                          │                               └──▶ 13 (review UI)
                        └──▶ 07 (cluster + breaker) └──▶ 08 (triage)

09 (assertion engine) ──┬──▶ 10 (extraction-failed repairable)   [also needs 01]
                        ├──▶ 11 (judge fallback)
                        └──▶ 12 (Claude pins assertions, HITL)
```

| #  | Slice                                                              | Type | Label           | Blocked by |
|----|--------------------------------------------------------------------|------|-----------------|------------|
| 00 | [Wrong-fix rate spike on real failed runs](heal-00-wrong-fix-rate-spike.md) | HITL | needs-decision | — |
| 01 | [Repair Policy + job enqueued + queue visible](heal-01-repair-policy-enqueue-visible.md) | AFK | in-review | — |
| 02 | [Repair Agent credential (second issuer)](heal-02-repair-agent-credential.md) | AFK | in-review | — |
| 03 | [Claim a job under a lease](heal-03-claim-under-lease.md) | AFK | in-review | 01, 02 |
| 04 | [Repair round trip → unreviewed version](heal-04-repair-round-trip-unreviewed.md) | AFK | in-review | 03 |
| 05 | [Brief-justification gate](heal-05-brief-justification-gate.md) | HITL | in-review (rubric wording + 00 gate GA) | 04 |
| 06 | [`healed` outcome + re-run + digest](heal-06-healed-outcome-rerun.md) | AFK | in-review | 05 |
| 07 | [Failure clustering + circuit breaker](heal-07-clustering-circuit-breaker.md) | AFK | in-review | 01 |
| 08 | [Triage jobs (read-only diagnosis)](heal-08-triage-jobs.md) | AFK | in-review | 03 |
| 09 | [`@varys/assertion-engine` + replay evaluation](heal-09-assertion-engine-replay.md) | AFK | in-review | — |
| 10 | [Extraction-failed repairable, relation-false never](heal-10-extraction-failed-repairable.md) | AFK | in-review | 01, 09 |
| 11 | [Judge fallback for unpinnable assertions](heal-11-judge-fallback-unpinnable.md) | AFK | in-review | 09 |
| 12 | [Claude pins assertions during authoring](heal-12-claude-pins-assertions.md) | HITL | in-review (wording + real-pin review outstanding) | 09 |
| 13 | [Repair review UI (signal diff + justification)](heal-13-repair-review-ui.md) | AFK | ready-for-agent | 04 |

**Start with 01 and 02 in parallel** (no blockers, and 03 needs both), or take **09** if you would
rather ship the new capability before the new architecture.

> **Why `healed` is slice 06 and not slice 01.** Repair deliberately lands an *unreviewed version
> while the run stays `failed`* (04), and only gains the amber outcome after the justification gate
> exists (05). Sequenced this way, the unsafe state — a repair turning a run green with no guard —
> never exists, not even mid-implementation.

> **Measure 00 alongside 01.** Claude's wrong-fix rate decides whether `healed` is a useful amber or
> noise nobody reviews, and whether the stateless-bundle alternative in ADR-0005 would have
> sufficed. It costs a session with tools that already ship, not new code.
