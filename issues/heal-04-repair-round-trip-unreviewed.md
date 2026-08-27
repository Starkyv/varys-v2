# Slice 04 — Repair round trip: an unreviewed version, and the run stays failed

**Type:** AFK · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** 03

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

A claimed job can actually repair the test. Within the scope of its claim, an agent reuses the
Slice 18 repair tools — `goto_step`, `observe`, `try_locator`, `apply_fix`, `read_test`,
`edit_test` — and reports the result. Varys writes a new **audited, unreviewed** test version.

**Deliberately: the failing run stays `failed`.** No amber outcome, no re-run, no green. The
`healed` outcome arrives in slice 06, behind the justification gate in slice 05. Sequencing it
this way means the unsafe state — a repair turning a run green without a guard — never exists,
not even mid-implementation.

Because a version nobody can act on is not a complete slice, this includes a **minimal accept /
reject**: accepting marks the version reviewed; rejecting reverts the test to its previous
version. The richer side-by-side signal diff is slice 13.

Scope enforcement is the load-bearing part: the agent's tool access is confined to the test of
the job it holds. A claim is not a general licence.

## Acceptance criteria

- [x] An agent holding a claim can drive the repair tools against that job's test
- [x] The same agent is **refused** those tools for any other test
- [x] Releasing or losing the claim revokes tool access immediately
- [x] A reported repair writes a new test version, marked unreviewed, attributed to the agent's label
- [x] The originating run's outcome is **unchanged** — still `failed`
- [x] The unreviewed version appears in the review queue
- [x] Accepting marks it reviewed; the test's active definition is the repaired one
- [x] Rejecting reverts the test to its previous version and the job moves to a terminal state
- [x] The agent is still refused baseline approval at every point in this flow
- [x] E2E: a fixture-variant locator break → job → simulated drainer repairs via the real tools → an unreviewed version exists and the run is still red

## Blocked by

- Slice 03 (a job must be claimable before it can be repaired)

## Flags raised

- **`report_repair` closes the job; it does not write the version.** The versions are written by
  `apply_fix` / `edit_test` while the claim holds — each one lands `unreviewed` and carries the
  job id — and `report_repair` records the drainer's account and takes the job terminal. Written
  that way on purpose: a drainer that dies between applying a fix and reporting it still leaves an
  `unreviewed` version rather than a silently-active edit. The consequence to check is the one the
  E2E pins: a report with no version behind it is REFUSED, so a job can never read `done` with
  nothing to show for it.
- **Losing a claim revokes the tools mid-session.** A repair session outlives the claim it was
  opened under (the browser is still parked), so the claim is now re-checked on every
  session-addressed tool call, not just at open. `close_repair_session` is deliberately exempt —
  refusing it would leave a real browser running with no way for its owner to shut it down, and it
  changes nothing about any test. Worth a second opinion on that exemption.
- **Reject reverts by APPENDING the previous definition as a new version**, rather than deleting
  the rejected one. Keeps the audit trail and keeps runs that already executed against the
  rejected version pointing at a row that exists — but it does mean a rejected repair costs the
  test two version numbers.
- **Baseline migration on a reject is positional, and guarded.** A checkpoint's name is its
  baseline key, so reverting a definition that renamed one has to move the golden back; the
  rename is inferred by pairing checkpoints positionally, and skipped entirely when the two
  definitions hold different numbers of checkpoints. In that (locator-repair-impossible) case the
  baselines are left alone, so the next run reports `pending-baseline` — visible — rather than
  comparing against the wrong golden.
- **The review surface here is minimal on purpose** — test, version, attribution, the drainer's
  report, the brief, accept/reject. The side-by-side signal diff, the justification and a
  clustered repair's blast radius are slice 13's, and the `RepairReviews` panel in
  `apps/web/src/views/RepairQueue/index.tsx` is where that work should land.
- **`/code-review` was not run**: this session is configured not to spawn subagents. The diff
  wants a human pass, particularly over `repair-reviews.service.ts` and the new scope re-check in
  `mcp.controller.ts`.
- **Three pre-existing E2E failures, untouched by this slice**, in the uncommitted slice-18
  "repair session full edit" work that shares these files: `repair-edit.e2e.spec.ts` (2 — an
  inserted step's captured target has no `role`; a checkpoint rename aimed at a click step) and
  `authoring-repair.e2e.spec.ts` (1 — an assertion on the old wording of the `checkpoint` refusal).
  Left alone rather than folded into this diff.

## Promotion candidates

None. The `RepairReviews` panel is the only new UI, it has exactly one caller, and it reads
repair-queue vocabulary throughout — it is this feature's component, not a shared one.
