# Slice 10 — Extraction-failed is repairable; relation-false never is

**Type:** AFK · **Label:** `in-review` · **Blocked by:** 01, 09

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

Wire the distinction slice 09 produces into the queue slice 01 built.

An assertion whose extraction target no longer resolves is a **locator** failure. It is
repairable exactly like any broken step locator, and under an `auto` policy it enqueues a repair
job.

An assertion whose targets both resolved and whose relation is false is an **app** failure. It is
never repairable — under any policy, at any threshold, by any agent. Repairing it would mean
re-pinning until the numbers agree, which is a machine for hiding the exact bugs assertions exist
to catch. It enqueues a **triage** job instead (once slice 08 lands) or simply stays red.

This is a small slice by line count and the most important one in the assertions branch. It is
the point where a safety property becomes executable.

## Acceptance criteria

- [x] An assertion whose target does not resolve enqueues a repair job under an `auto` policy
- [x] Repairing it re-pins the assertion's extraction target and writes an unreviewed version
- [x] An assertion whose relation is false enqueues **no** repair job, under any policy
- [x] A relation-false assertion cannot be repaired even by a manually enqueued job
- [x] A relation-false assertion enqueues a triage job where slice 08 is present
- [x] The distinction is visible to the author on the run — "could not read the value" vs "the values disagree"
- [x] E2E: a fixture variant that *removes* the assertion's target produces a repair job; a variant that *changes its value* produces none

## Blocked by

- Slice 01 (the queue must exist)
- Slice 09 (the distinction must be produced before it can be acted on)

## What landed

The distinction is produced by `@varys/assertion-engine` (slice 09) and consumed in exactly one
place per consumer, so no two of them can come to disagree about it:

- **`@varys/assertion-engine`** — `side` on every evaluation (which target failed to extract, so a
  repair knows what to re-pin), and the pure verdict: `assertionRepairability`,
  `isRepairableAssertionFailure`, `assertionFailureVerdict`, plus the two refusal sentences
  (`RELATION_FALSE_NEVER_REPAIRABLE`, `COERCION_NEVER_REPAIRABLE`). Four new unit-test blocks
  (21 → 25) cover which side is blamed, which outcomes blame none, the three-way repairability
  verdict, and the mixed-failure precedence.
- **The runner** — an assertion failure that is *only* unresolved targets writes
  `runs.failure_kind = 'locator'` (which is what it IS) and calls the same `enqueueRepairIfAuto`
  a broken step locator does, so the policy gate, the clustering and the circuit breaker all apply
  with no second implementation. Anything else stays `'assertion'` and earns a triage job.
- **The breaker census** — `recentLocatorFailures` now recovers a target from the run's unresolved
  assertion side when there is no failing step, so a mass break caught by assertions is visible to
  the guard rather than invisible to it.
- **`POST /repair-jobs`** — the by-hand enqueue accepts an assertion extraction failure and refuses
  a relation-false run *in the engine's own words*. This is the path that could bypass the property,
  so it is the one the E2E pins hardest.
- **The write** — `TestConfigAssertionPatch.left` / `.right` re-pin a side's fingerprint through the
  same merge (`applyFingerprintPatch` + `hasMatchableSignal`) a step locator edit uses, exposed on
  MCP as `edit_test { assertions: [...] }`. `claim_repair_job` now returns `failingAssertion`
  (id, side, cause, `repairable`) — without it a drainer has nothing to find, since `failingStep` is
  null for these runs.
- **One lookup, not four** — `pinnedSideTarget` in the engine is the single walk from (assertion id,
  untrusted `side` text) to the fingerprint to re-pin, used by the runner, the breaker census, the
  by-hand enqueue and the fan-out. `/code-review` flagged three near-identical copies of it in the
  first cut; they are gone.
- **The fan-out** — `ClusterSite` generalises "where the broken locator lives" to a step index *or*
  an assertion id + side, so a clustered assertion repair is applied across its cluster rather than
  silently dropped.

## Flags raised

- **Precedence: one unrepairable failure suppresses repair for the whole run.** A run carrying both
  a false relation and a missing target gets a triage job and no repair. The reasoning is in
  `assertionFailureVerdict`'s doc comment: the app is known to be wrong there, so a repair would
  write a version and queue a re-run whose evidence is a still-red run. It is a deliberately
  conservative reading of the per-assertion criteria — worth a human's agreement, because the
  alternative (repair the repairable one, triage the other) is also defensible.

- **`try_locator` / `apply_fix` still only understand a STEP's locator.** A drainer repairing an
  assertion writes through `edit_test`, which is *not* verified against a live page — so unlike the
  step path, nothing stops it writing an assertion target that does not resolve. `report_repair`'s
  justification gate and the unreviewed version are what stand behind it instead. The verified
  candidate loop for assertion targets is real follow-up work (it wants `try_locator` to take an
  assertion id + side and merge onto THAT fingerprint); it is not in this slice's criteria.

- **`open_repair_session` on an assertion failure parks on the LAST step**, because that is the page
  the assertions were evaluated against. Previously such a run was refused outright ("did not fail
  at a step and has no red checkpoint"). Small behaviour change to a shared path — a reviewer should
  agree that "the page the assertion saw" is the right park.

- **One repair job per run, even when several assertions broke on DIFFERENT locators.** The runner
  takes the first recoverable target (`.find(...)`), matching the step path's shape — a run fails at
  one place and earns one job. The second broken target is picked up by the next run once the first
  is repaired, so it converges, but slowly: a test with two broken assertion targets needs two
  repair cycles. Deliberate and untested (the criteria do not cover it); worth a decision if this
  turns out to be common.

- **`run_assertions.side` is a new nullable column.** Rows written before this slice have no side,
  and the code treats that as "no recoverable target" (no job) rather than guessing left. So a
  historical extraction failure is not retroactively repairable, which is the safe direction.

- **The web surface is unverified by hand**, per house practice (no UI tests, and this session did
  not drive the SPA). The addition is one sentence per failing assertion — `consequenceOf(outcome,
  cause)` in `components/PinnedAssertion` — which states what follows: repairable, never repairable,
  or edit the check. Someone frontend-literate should confirm two blurb paragraphs stacked under a
  failing assertion reads as intended rather than as noise.

- **Two pre-existing test failures, verified pre-existing by stashing this work and re-running:**
  `test/authoring-repair.e2e.spec.ts` 1/4 (asserts a refusal message that was reworded in an earlier
  slice) and `test/repair-edit.e2e.spec.ts` 2/5. Neither touches this slice.
  `test/repair-queue.e2e.spec.ts`, `test/repair-cluster.e2e.spec.ts`, `test/repair-claim.e2e.spec.ts`
  and `test/healed-outcome.e2e.spec.ts` each failed once under machine load (testcontainers /
  socket errors) and passed on re-run with these changes in place.

## Promotion candidates

None. The web change is a function added to `components/PinnedAssertion`, which slice 09 already
placed correctly (app-level `components/`, two callers, purely presentational — but its vocabulary
is assertion vocabulary, so it is this feature's component and must not go to `@varys/ui`).

## Review

`/code-review` ran both axes.

- **Spec** — all seven criteria backed by code and tests. It named the two extensions beyond the
  ticket text (the cluster fan-out over assertion sites, and the breaker census learning to read
  `run_assertions`) as defensible readings of "wire the distinction into the queue slice 01 built",
  and the repair-session park change as needed-but-unnamed. It also raised the one-job-per-run
  limitation flagged above. No spec defects.
- **Standards** — no documented-standard violation; the E2E-hook check does not apply (no new
  operable surface — the web change is one `<p>` and a pure string helper). One strong Duplicated
  Code finding: the assertion-side → target walk written three times. **Fixed** by extracting
  `pinnedSideTarget` into `@varys/assertion-engine` with its own tests.
