# Slice 00 — Spike: Claude's wrong-fix rate on real failed runs

**Type:** HITL · **Label:** `needs-decision` · **Blocked by:** none

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

Nothing shippable. Measure one number before the rest of the slice is built: **how often does
Claude re-pin a broken locator to a plausible but *wrong* element?**

Every tool needed already ships — `failed_runs`, `open_repair_session`, `goto_step`,
`try_locator`, `apply_fix`, `read_test`. Take 10–15 genuinely failed runs from real tests, drive
each repair by hand with Claude, and classify the outcome. Do not commit any fix.

This number decides three things the PRD leaves open:

- Whether `healed` (slice 06) is a useful amber or a stream of noise nobody reviews.
- Whether the brief-justification judge (slice 05) is a sufficient guard, or whether the
  strong-signal rule rejected in Q11 of the design interview needs to come back alongside it.
- Whether the **stateless repair bundle** recorded as the near-miss in
  [ADR-0005](../docs/adr/0005-scoped-repair-agent-credential.md) would have sufficed — if almost
  every real failure is "an element moved", the live-session machinery is being built for a
  minority.

Classify each failure by cause too: *element renamed/moved* vs *flow changed* (a new dialog, an
extra step). That split is the direct input to the stateless-vs-session question.

## Acceptance criteria

- [ ] At least 10 real failed runs attempted, from tests that failed on an unresolvable locator
- [ ] Each outcome classified: repaired correctly · repaired **wrongly** · could not repair · the locator engine would have healed it unaided
- [ ] Each failure classified by cause: element moved/renamed · flow changed · other
- [ ] Findings written up in `issues/00-findings.md` style, with the wrong-fix rate stated plainly
- [ ] An explicit recommendation on each of the three open questions above
- [ ] No test definition is modified — every repair is discarded

## Blocked by

None - can start immediately.

## Flags raised

**Not started — the dataset this spike measures does not exist in a reachable environment.**
Status deliberately left at `needs-decision`. Groundwork below so whoever runs it does not
have to re-inventory.

*Inventory of the local dev DB (`docker compose up -d postgres`, volume `varys-v2_varys-pgdata`),
26 runs total, 9 failed:*

| Test | Failed step | Runs | Dates | Error |
|------|-------------|------|-------|-------|
| Explorer — KPIs and Dimensions selection | 6 | 2 | 2026-06-18 → 06-25 | click "Batch Transactions": could not locate click target |
| Briefs | 3 | 1 | 2026-06-18 | click "Florida and Illinois showing the harshest mirror-pattern": could not locate click target |
| Top Stories | 11 | 3 | 2026-06-14 | checkpoint "screenshot-3" (element): no fingerprint signal matched |
| Test env | 4 | 1 | 2026-06-23 | click "Images": could not locate click target — *google.com throwaway, not a real app test* |

The remaining 2 failures are not locator failures (`waitForLoadState` timeout; `page.screenshot:
target closed`) and are out of scope per the first acceptance criterion.

That is **4 distinct locator failures, 3 of them against a real app** — the 7 runs collapse
because Top Stories ×3 and Explorer ×2 are the same failure re-run. The criterion asks for ≥10.

*What is missing, concretely:*

1. **Sample size.** Reaching N≥10 means generating fresh failures by re-running the 19 stored
   tests against `dev.datagenie.ai` / `cfg.datagenie.ai` / `carvana.datagenie.ai` today. The
   stored runs are ~2 months stale, so most of those tests have probably drifted into new
   genuine failures — this is likely the cheapest route to a real dataset, and it needs someone
   who can authenticate against those apps.
2. **Credentials.** The `environments` rows carry exactly one cookie each — `disableAnimations`,
   no auth — so a repair session against any of the three real apps cannot reach a logged-in
   page from stored state alone. Nothing in the repo supplies these.
3. **Ground truth.** Classifying an outcome as *repaired correctly* vs *repaired **wrongly***
   is a judgment about which element the test author meant, on an analytics UI. That judgment
   is the substance of the spike and is why it is labelled HITL — an agent grading its own
   re-pins would produce exactly the number the spike exists to stop us guessing at.

The number gates GA of slice 05 and the stateless-vs-session call in ADR-0005, so a
fabricated or extrapolated figure is worse than an absent one. **Slices 01, 02 and 09 are
`ready-for-agent` and unblocked** — the queue work does not wait on this.
