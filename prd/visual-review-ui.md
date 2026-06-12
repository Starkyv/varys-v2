# PRD — Varys v2 Slice 2: Visual Review UI

> **Scope:** the in-browser **diff viewer + approve/reject** surface that lets a human resolve
> baselines and diffs without touching the API by hand. Slice 2 of the roadmap in `DESIGN.md`
> (table row 2): *"Diff viewer (side-by-side + highlight) + in-browser approve/reject + irreversible
> confirm. Depends on 1."*
> **Status:** ready for implementation. *(Not published to an issue tracker — none configured; the
> `ready-for-agent` triage label could not be applied. Living here until a tracker is wired up.)*
> **Source of truth for the full platform:** `DESIGN.md` (esp. §4 baseline lifecycle, §8 diff viewer,
> §12 tech stack). **First slice:** `prd/mvp.md`.

## Problem Statement

I can record a test, replay it server-side, and get a visual diff — but the only way to *act* on the
result is to call the API by hand. To approve a freshly-seeded baseline I have to read a run's JSON,
copy artifact tokens, open the baseline / actual / diff PNGs in separate browser tabs, eyeball them,
and then POST an approve action with the right ids. There is no place to *look* at what changed and
decide. Worse, baseline approval is **irreversible** (the old baseline is deleted on replace, by
design — `DESIGN.md` §4, accepted risk #1), so the most consequential, unrecoverable action in the
product is currently a bare HTTP call with no visual confirmation and no guard. A non-engineer can't
review at all, and even I can't review quickly or safely.

## Solution

A web UI — the **diff viewer** — where a reviewer sees every checkpoint that needs a decision, opens
it, and looks at the **baseline**, the run's **actual**, and the precomputed **diff** image together.
The viewer offers two ways to look: **side-by-side** and a **diff-highlight overlay**, switchable with
one control. From the viewer the reviewer takes the same two decisions the API already exposes, but in
context: **Approve** (promote a pending baseline to active, or replace the active baseline with this
run's actual) or **Reject** (mark it a regression, leave the baseline untouched). Because approve is
irreversible, it is gated behind a **hard confirmation dialog** that names the consequence ("this
permanently replaces the baseline — no undo"). Every action records **who** and **when** through the
existing audited API. A humble **"needs review" list** is the way in: it shows the runs/checkpoints
sitting in *pending-baseline* or *diff* state so the reviewer can find work without knowing run ids.

This slice is a **thin browser client over slice-1's baseline-lifecycle and diff API** — it adds no new
replay, diff, or storage behavior. It turns the existing "resolve via API action" loop into a "look,
then decide" loop a human can actually run.

## User Stories

**Finding work to review**
1. As a reviewer, I want a list of checkpoints currently needing a decision (pending baseline or diff), so that I can find what to review without knowing run ids.
2. As a reviewer, I want each list entry to show the test name, checkpoint name, environment, run time, and why it needs review (awaiting first approval vs. visual diff), so that I can triage what to open first.
3. As a reviewer, I want to click a list entry to open it directly in the diff viewer, so that reviewing is one click from finding.
4. As a reviewer, I want the list to refresh after I resolve an item, so that I always see only what still needs attention.
5. As a reviewer, I want a clear empty state when nothing needs review, so that I know I'm caught up rather than looking at a broken screen.

**Looking at the diff**
6. As a reviewer, I want to see the approved **baseline** image, the run's **actual** image, and the precomputed **diff** image for a checkpoint, so that I can judge what changed.
7. As a reviewer, I want a **side-by-side** view of baseline and actual, so that I can compare them directly.
8. As a reviewer, I want a **diff-highlight overlay** view that emphasizes the changed pixels, so that I can spot small changes I'd miss side-by-side.
9. As a reviewer, I want a single control to switch between view modes without leaving the checkpoint, so that I can look at the same change two ways quickly.
10. As a reviewer, I want the checkpoint's metadata shown — diff score, the per-checkpoint threshold it was judged against, and whether a step **healed** during the run — so that I understand the verdict, not just the picture.
11. As a reviewer, I want images served at full captured resolution, so that I'm deciding on what actually rendered, not a lossy thumbnail.
12. As a reviewer reviewing a **freshly-seeded baseline** (no prior baseline), I want the viewer to show the seeded actual as the candidate baseline and tell me this is a first approval, so that I understand there's nothing to diff against yet.

**Deciding**
13. As a reviewer, I want to **Approve** a pending baseline so that the test becomes active and future runs compare against it.
14. As a reviewer, I want to **Approve** a diff so that the run's actual replaces the current baseline (an intended change).
15. As a reviewer, I want to **Reject** a diff so that it is recorded as a regression and the baseline is left unchanged.
16. As a reviewer, I want approve to require a **hard confirmation** that names the irreversible consequence, so that I don't permanently destroy a good baseline with a stray click.
17. As a reviewer, I want the confirmation dialog to be dismissable without acting, so that a misclick on Approve costs nothing.
18. As a reviewer, I want reject **not** to require the destructive confirm (it changes no baseline), so that the friction matches the risk.
19. As a reviewer, I want the checkpoint to move out of the "needs review" state immediately after I decide, so that I don't accidentally act on it twice.
20. As a reviewer, I want a clear success indication after approve/reject, so that I know the decision was recorded.
21. As a reviewer, I want a failed approve/reject (network/API error) to surface an error and leave the checkpoint reviewable, so that I can retry rather than lose the decision silently.

**Trust, audit & safety**
22. As an auditor, I want each approve/reject to record who acted and when (via the existing audited API), so that there is a trail for an irreversible action.
23. As a reviewer, I want the viewer to reflect the verdict the server computed (status, score), never re-judge it client-side, so that what I approve is exactly what the runner produced.
24. As a reviewer, I want a checkpoint that another reviewer just resolved to show as already-decided rather than letting me approve a stale view, so that two people don't fight over one baseline.

**Operability & fit**
25. As an operator, I want the web app to build and run from the monorepo with the existing single-command dev flow, so that it deploys alongside the API and worker.
26. As a developer, I want the run/checkpoint read-model the UI consumes to be a shared, typed contract, so that the SPA and API can't silently drift.
27. As a reviewer, I want loading and error states for the list and the viewer, so that slow or failed fetches are legible rather than blank.
28. As a reviewer, I want the artifact images loaded through the same authenticated artifact route the API already exposes, so that I don't need separate credentials or a storage console.

## Implementation Decisions

**New app: `apps/web` — React SPA (Vite) + TanStack Query + CSS Modules** (per `DESIGN.md` §12). Joins
the existing pnpm + Turborepo workspace under `apps/*`. Server state (runs, checkpoints, list) is owned
by **TanStack Query**; CSS Modules for styling, consistent with the stated stack. No SSR; this is a
client SPA talking to the NestJS API.

**This slice is a client, not a new engine.** No replay, diff computation, storage, or baseline
*mechanics* are built here — they belong to slice 1. The diff image is **precomputed by the slice-1
`diff-engine`**; the UI only *displays* baseline/actual/diff and triggers the existing approve/reject
actions. There is **no client-side re-judging** of verdicts and **no live re-evaluation** (that's
slice 3).

**Hard prerequisite (called out honestly): MVP Issue 2.** The review UI consumes the
baseline-lifecycle + diff-verdict surface — pending/active baselines, the `passed / passed-with-heal-flag
/ diff / error / failed` status taxonomy, the baseline/actual/diff artifacts, and the **approve /
reject** API actions. As of writing, the committed backend is only at **MVP Issue 1 (walking
skeleton)**: the DB has no `baselines` table, `RunStatus` is `queued | running | passed | failed`
(schema comment: *"baseline/diff/heal statuses arrive later"*), and there are no approve/reject
endpoints. **Slice 2 cannot ship until MVP Issue 2 lands.** This PRD assumes the slice-1 *designed* API
surface; it does not re-specify it.

**Read-model contract (the API↔UI seam — build this first).** The UI needs a richer per-checkpoint
read-model than the skeleton's `{ name, status, artifactUrl }`. Define a **shared, typed contract** (a
small shared package, or types exported alongside the existing `@varys/*` packages — at the highest
shared point so SPA and API agree at compile time) carrying, per checkpoint under review:

- `reviewState`: `pending-baseline | diff` (the two states that need a human) — derived from run-result status, not a new stored column;
- `baselineUrl | null`, `actualUrl`, `diffUrl | null` — authenticated artifact routes via `storage.getUrl` (`null` baseline/diff for a first seed, where there is no prior baseline and nothing to diff);
- `diffScore | null`, `threshold`, `healed: boolean` — the verdict metadata the server computed;
- identifying context: test name, checkpoint name, environment, run id, run timestamp.

**API surface this slice relies on (shape, not paths):**

- *List needs-review* — a read endpoint returning checkpoints in `pending-baseline` or `diff` state, with the read-model above. Minimal filter/query; **not** the slice-7 dashboard.
- *Get run / checkpoint for review* — the same read-model for a single run/checkpoint, for the deep-linked viewer.
- *Approve baseline* and *Reject* — **already specified in slice 1** (MVP Issue 2). The UI calls them; it does not define new ones. Approve promotes pending→active or replaces active with the run's actual (deleting the old — no rollback); reject records a regression and leaves the baseline. Both are audited (approver + timestamp) by the API.

**View modes — exactly two this slice.** A switchable control toggles **side-by-side** (baseline | actual)
and **diff-highlight overlay** (the precomputed diff image emphasizing changed pixels over the actual).
`DESIGN.md` §8 designs *four* modes; **swipe slider and onion-skin/blink are deliberately deferred** to
keep this slice thin.

**Approve is gated; reject is not.** Approve opens a **blocking confirmation dialog** naming the
irreversible consequence ("permanently replaces the baseline — no undo") with explicit
confirm/cancel; cancel is a no-op. This dialog is the **only guard on accepted risk #1** and is a
correctness requirement of this slice, not polish. Reject changes no baseline and so takes no
destructive confirm.

**State transitions after a decision.** On a successful approve/reject, **invalidate the run query and
the needs-review-list query** (TanStack Query) so the resolved checkpoint leaves the list and the
viewer reflects the new state. A checkpoint the server reports as already-resolved renders as
already-decided rather than offering a stale approve (story 24) — the UI trusts the server's current
state, fetched fresh.

**Auth context for "who".** Varys-app auth is still the MVP **single trusted operator** (SSO/RBAC is
slice 10). The audited "who" is whatever the slice-1 API attributes the action to; this slice does not
add login. Images load through the existing **authenticated artifact route** (`getUrl` → local API
route), so the UI needs no separate storage credentials (`DESIGN.md` §7: *"the UI doesn't care"*).

## Testing Decisions

**What makes a good test here:** it asserts **external behavior** — what the reviewer sees on screen,
what requests cross the HTTP boundary, and the resulting persisted state/verdict — and **never**
component internals (no asserting on hook state, prop wiring, or CSS-module class names). Tests are
deterministic and run against committed fixtures (canned API payloads, committed PNG fixtures) or an
in-repo fixture app — never the live network.

**Primary seam — browser-driven E2E over the real stack (chosen).** Playwright drives the real
`apps/web` SPA against the **real NestJS API + a real Postgres (testcontainers) + local-FS storage**,
with a run seeded into a `pending-baseline` and into a `diff` state (produced by the real worker against
the in-repo `fixture-app`, or seeded directly into DB + storage). This **reuses and extends the
existing slice-1 backend harness** (`apps/api/test/replay.e2e.spec.ts` / `runs.e2e.spec.ts`:
testcontainers Postgres + `fixture-app` + `LocalFsAdapter` + the real queue/worker) and simply layers
the browser on top — the highest behavioral seam available. It drives the real gestures and asserts the
real outcome:
- open the **needs-review list** → see the seeded items;
- open a checkpoint → **toggle side-by-side ↔ overlay** → both render the right images;
- **Approve** → the hard-confirm appears → confirm → assert the API flipped the baseline to active / replaced it, recorded approver + timestamp, and the item left the list;
- **Reject** a diff → assert a regression was recorded and the **baseline is unchanged**;
- **cancel** the confirm → assert nothing changed.

**Secondary seam — component / HTTP-boundary (MSW).** Review components rendered with the network mocked
**at the HTTP boundary** (Mock Service Worker) returning canned read-model payloads. Covers the fiddly UI
states the heavy E2E shouldn't multiply over: view-mode switching shows the correct images; **Approve is
unreachable without clearing the confirm dialog**; **Reject** sends the correctly-shaped request and
takes no destructive confirm; first-seed (`baselineUrl: null`) renders the "first approval" affordance;
loading / error / empty states; an API error on approve surfaces and leaves the checkpoint reviewable.

**Pure unit — minimal.** Only genuinely pure logic: mapping a checkpoint's status → review affordances
(which actions/confirm apply) and the confirm-gate. Kept small; most behavior is asserted at the MSW
seam.

**Modules tested:** `apps/web` (the SPA — at the browser and MSW seams) and the **shared read-model
contract** (type-level; exercised end-to-end by the browser seam). The slice-1 approve/reject/diff
mechanics are assumed already covered by slice-1's tests and are not re-tested here, only consumed.

**Prior art:** the slice-1 full-thread integration tests
(`apps/api/test/*.e2e.spec.ts` — testcontainers Postgres, `fixture-app`, `LocalFsAdapter`, supertest,
vitest) are the backend harness the browser E2E builds on; reuse their `db-harness.ts` setup. The SPA
test conventions (Playwright-driving-the-SPA for E2E, MSW for the component boundary) are **new** with
this slice and establish the frontend testing pattern for every UI slice that follows (dashboard,
timeline, env management).

## Out of Scope

Deferred to later slices (all designed in `DESIGN.md`):

- **Other two view modes** — swipe slider, onion-skin/blink (`§8`; this slice ships side-by-side + overlay only).
- **In-viewer mask drawing + live per-checkpoint threshold tuning with instant re-evaluation** (`§8`) → **slice 3** (Multi-checkpoint + capture modes, recorder/in-viewer masking).
- **Bulk "approve all in run"** (`§8`) — moot while the MVP is one checkpoint per test; revisit with **slice 3** (multi-checkpoint).
- **The run dashboard** — test × environment status matrix, runs activity feed, per-checkpoint trend sparklines (`§10`) → **slice 7**. This slice ships only a humble flat "needs review" list, explicitly not the matrix.
- **Timeline / Playwright Trace Viewer** investigation surface (`§9`) → **slice 9**.
- **Notifications** — Slack + in-app inbox on diffs/failures (`§10`) → **slice 8**. (The "needs review" list is pull, not push.)
- **Authentication & RBAC** — Google SSO / email-password / OIDC, role gating, audit *surfacing* UI (`§11`) → **slice 10**. This slice runs under the MVP single-trusted-operator model.
- **Environment management UI / multi-env review** (`§4` per-env baselines) → **slice 4**. The viewer shows the environment a checkpoint belongs to but does not manage environments.
- **No new replay/diff/storage/baseline mechanics** — those are slice 1. Any gap there is a slice-1 bug, not slice-2 scope.

## Further Notes

- **Hard dependency:** ships only after **MVP Issue 2** (baseline lifecycle + diff verdicts + approve/reject endpoints) lands. The committed code is at **Issue 1 (walking skeleton)** today — no `baselines` table, no diff statuses, no approve/reject. Confirm Issue 2 is merged before starting.
- **Build the read-model contract first.** The richer per-checkpoint read-model (baseline/actual/diff URLs + score + threshold + healed + reviewState) is the seam everything else hangs off; define it as a shared typed contract before building components, so the browser E2E and the SPA share one source of truth with the API.
- **Make-or-break correctness concern for this slice:** the **irreversible-approve confirm dialog**. It is the sole guard on accepted risk #1 (`DESIGN.md` §4) — a mistaken approve permanently deletes a good baseline. Treat the confirm gate as load-bearing and test it at both seams (cannot approve without clearing it; cancel is a true no-op).
- **The viewer does double duty** (`DESIGN.md` §4): step-3 first-baseline approval (`pending-baseline`, no diff to show) *and* step-5 diff resolution (`diff`, full baseline/actual/diff). Both paths must be designed and tested; the first-seed path is the one easy to forget.
- **Don't re-judge on the client.** Display the server's verdict and score; the UI never recomputes pass/diff. This keeps "what I approved" identical to "what the runner produced."
- Suggested build order: shared read-model contract → list + viewer endpoints (read) → `apps/web` scaffold (Vite + TanStack Query) → needs-review list → diff viewer (two view modes) → approve/reject wired to slice-1 actions with the hard confirm → MSW component tests alongside → browser E2E extending the slice-1 harness last.
- Next step after this PRD: run **`/to-issues`** to cut it into tracer-bullet vertical slices (e.g. read-model + list → viewer + view modes → approve/confirm + reject → browser E2E).
