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
demoable: edit a click's accessible name, save, see the test's definition carry it.

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

## Slice 19 — Self-healing tests: the assertion engine

Tracer-bullet slices for assertions — the checks a screenshot cannot make. ADRs:
[0004](../docs/adr/0004-brief-authored-tests-converge-no-agentic-kind.md) (no agentic test kind),
[0008](../docs/adr/0008-attended-repair-only-no-queue-no-versions.md) (repair is attended).

Depends on **slice 18** (repair session full edit) for `edit_test`.

```
09 (assertion engine) ──┬──▶ 10 (extraction-failed repairable)
                        ├──▶ 11 (judge fallback)
                        └──▶ 12 (Claude pins assertions, HITL)

14 (attended repair loop: run_test proves the fix)
```

| #  | Slice                                                              | Type | Label           | Blocked by |
|----|--------------------------------------------------------------------|------|-----------------|------------|
| 09 | [`@varys/assertion-engine` + replay evaluation](heal-09-assertion-engine-replay.md) | AFK | in-review | — |
| 10 | [Extraction-failed repairable, relation-false never](heal-10-extraction-failed-repairable.md) | AFK | in-review | 09 |
| 11 | [Judge fallback for unpinnable assertions](heal-11-judge-fallback-unpinnable.md) | AFK | in-review | 09 |
| 12 | [Claude pins assertions during authoring](heal-12-claude-pins-assertions.md) | HITL | in-review (wording + real-pin review outstanding) | 09 |
| 14 | [Attended repair loop: `run_test`, judge no longer required](heal-14-attended-repair-loop.md) | AFK | in-review | — |

> **The repair queue that used to live here is gone.** Slices 00–08 and 13 planned an unattended
> drainer: a Repair Policy that enqueued a job, a second `/mcp` issuer, a claim under a lease, an
> unreviewed version pending a human accept, a justification judge, failure clustering, a circuit
> breaker, triage jobs, and a review UI for the lot.
> [ADR 0008](../docs/adr/0008-attended-repair-only-no-queue-no-versions.md) removed all of it:
> repair is attended, so the person who reads the red Run is the guard every one of those parts
> stood in for. Those ten slice files were deleted rather than left standing as plans for machinery
> that will not be built — the ADR is the record of why, and ADRs 0003 and 0005 are left in place
> as the record of what was decided before it.
>
> The five above survive because assertions and the attended loop were never part of the queue.
> They still open on `prd/self-healing-repair-queue.md`, which went with the queue; read them
> against ADR 0008 instead.
