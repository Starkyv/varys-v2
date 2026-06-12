# Issues — Varys v2 Slice 2: Visual Review UI

> Tracer-bullet issues for the Visual Review UI slice (`prd/visual-review-ui.md`). Each is a thin
> vertical cut through every layer (shared read-model contract → API read/action → `apps/web` SPA →
> browser-E2E + MSW tests), demoable on its own.
> *Not published to an issue tracker — none configured; the `ready-for-agent` label could not be
> applied. Build order = dependency order below.*
>
> **Status: 🟡 In progress.** Issue 1 (walking skeleton) is **done and test-driven**; Issues 2–4 remain.
>
> | Issue | Status |
> |---|---|
> | 1 — Walking skeleton: deep-linked diff viewer | ✅ Done |
> | 2 — Two view modes (side-by-side ↔ overlay) | ✅ Done |
> | 3 — Approve / Reject + irreversible-confirm gate | ✅ Done |
> | 4 — "Needs review" list | ⬜ Not started |
>
> **Dependency shape:** `1 → {2, 3}`, and `{1, 3} → 4`.

---

# Issue 1 — Walking skeleton: deep-linked diff viewer renders baseline/actual/diff

**Type:** AFK · **Status: ✅ Done**

## What to build

The thinnest end-to-end path for the review UI, plus the scaffolding it rides on. Stand up a new
`apps/web` React SPA (Vite + TanStack Query + CSS Modules) in the existing pnpm + Turborepo workspace.
Define the **shared, typed per-checkpoint review read-model** — the contract the SPA and API agree on —
carrying, for a checkpoint under review: `reviewState` (`pending-baseline | diff`), `baselineUrl`,
`actualUrl`, `diffUrl` (baseline/diff null on a first seed), `diffScore`, `threshold`, `healed`, and
identifying context (test name, checkpoint name, environment, run id, run timestamp). Add an API read
endpoint that returns this read-model for a single run/checkpoint (artifact URLs via the existing
authenticated artifact route — the UI needs no separate storage credentials). The SPA, given a run id
(deep link), fetches the read-model and displays the baseline, actual, and diff images at full captured
resolution in a single view. No view-mode switching, no list, no actions yet — this exists to prove the
whole stack is wired: shared contract → API read-model → SPA → artifact route → browser test harness. It
also establishes the frontend testing conventions (Playwright-driving-the-SPA for E2E, MSW for the
component boundary) reused by every later UI slice.

The server's verdict (status, score) is **displayed, never recomputed client-side**. The
`pending-baseline` first-seed path (no prior baseline, nothing to diff against) renders a "first
approval" affordance rather than a broken diff.

## Acceptance criteria

- [x] `apps/web` builds and runs from the monorepo (Vite 7 + React 18 + TanStack Query + CSS Modules); `pnpm --filter @varys/web dev` serves it same-origin via a proxy to the API. *(production build verified; a single-command `dev` across all services is still the tracked follow-up)*
- [x] The per-checkpoint review read-model is a single shared typed contract consumed by both the SPA and the API (`@varys/review-contract`, pure types — compile-time agreement; no drift).
- [x] An API read endpoint returns the read-model for a given run/checkpoint, with baseline/actual/diff served via the authenticated artifact route (`GET /runs/:id`; `getUrl` → `/artifacts/:token`).
- [x] Opening the SPA at a deep link for a diffed run displays the baseline, actual, and diff images at full captured resolution. *(deep link is `?run=<id>`; the `/runs/:id` path is the API's under the same origin)*
- [x] A `pending-baseline` (first-seed) checkpoint renders the seeded actual as the candidate baseline and indicates this is a first approval (no diff shown).
- [x] The UI displays the server-computed status/score and does not recompute the verdict.
- [x] Loading and error states render for the viewer fetch.
- [x] A browser-driven E2E (Playwright over the real SPA + real API + testcontainers Postgres + local-FS, extending the slice-1 backend harness) seeds a diffed run and asserts the three images render.

## Blocked by

- MVP Issue 2 — Baseline seed → approve → diff verdict (external; see `issues/mvp.md`).

---

# Issue 2 — Two view modes: side-by-side ↔ diff-highlight overlay

**Type:** AFK · **Status: ✅ Done**

## What to build

Add the second way of looking and the control to switch between them. The viewer gains a **diff-highlight
overlay** mode (the precomputed diff image emphasizing changed pixels over the actual) alongside the
existing **side-by-side** (baseline | actual), with a single switchable control that toggles modes
without leaving the checkpoint. Surface the verdict metadata the server computed — diff score, the
per-checkpoint threshold it was judged against, and whether a step **healed** during the run — so the
reviewer understands the verdict, not just the picture. Exactly these two modes this slice; swipe slider
and onion-skin/blink are deferred (DESIGN.md §8). No re-evaluation or threshold tuning — the diff image
is the one the slice-1 `diff-engine` already produced.

## Acceptance criteria

- [x] The viewer offers side-by-side and diff-highlight overlay modes, switchable with one control, without re-fetching or leaving the checkpoint. *(local `useState` mode toggle; the run query is not re-fetched)*
- [x] The diff-highlight overlay emphasizes the changed pixels using the precomputed diff image.
- [x] Diff score, the threshold the checkpoint was judged against, and the healed flag are shown.
- [x] A `pending-baseline` checkpoint (no diff) sensibly disables/hides the overlay mode rather than showing a broken view. *(overlay control is not rendered for a first seed)*
- [x] MSW component tests assert each mode renders the correct image(s) and the switch toggles between them. *(plus the browser E2E drives the toggle over the real stack)*

## Blocked by

- Issue 1 — Walking skeleton.

---

# Issue 3 — Approve / Reject with the irreversible-confirm gate

**Type:** AFK · **Status: ✅ Done**

## What to build

The decision actions, in context. Wire the viewer's **Approve** and **Reject** to slice-1's existing
(MVP Issue 2) audited approve/reject API actions — this slice defines no new mechanics, only the
in-browser surface for them. **Approve** promotes a pending baseline to active, or replaces the active
baseline with this run's actual (an intended change; the old baseline is deleted — no rollback), and is
**gated behind a blocking hard-confirmation dialog** that names the irreversible consequence
("permanently replaces the baseline — no undo") with explicit confirm/cancel; cancel is a true no-op.
**Reject** records a regression and leaves the baseline unchanged, and takes **no** destructive confirm
(the friction matches the risk). On a successful decision, the run query and (later) the list are
invalidated so the checkpoint reflects its new state and can't be acted on twice; a checkpoint the
server reports as already-resolved renders as already-decided rather than offering a stale approve. A
failed action surfaces an error and leaves the checkpoint reviewable. Each action's who/when is recorded
by the existing audited API.

The hard-confirm dialog is the **sole guard on the product's only irreversible, unrecoverable action**
(DESIGN.md §4, accepted risk #1) — treat the gate as load-bearing.

## Acceptance criteria

- [x] Approve cannot be completed without clearing the hard-confirmation dialog; cancel/dismiss changes nothing.
- [x] Approving a `pending-baseline` activates the test; approving a `diff` replaces the active baseline with the run's actual.
- [x] Reject records a regression, leaves the baseline unchanged, and requires no destructive confirm.
- [x] After a successful decision the checkpoint reflects its new state and cannot be acted on again from the same view. *(on success the run + needs-review queries are invalidated; the re-fetched checkpoint renders as already-decided)*
- [x] A checkpoint already resolved (e.g. by another reviewer) renders as already-decided instead of offering a stale approve. *(read-model now carries `resolution`)*
- [x] A failed approve/reject surfaces an error and leaves the checkpoint reviewable (no silent loss).
- [x] Each approve/reject records approver + timestamp via the existing audited API. *(slice-1 behavior, consumed here)*
- [x] Browser-E2E covers approve-with-confirm → baseline activated/replaced, reject → regression + baseline unchanged, and cancel → nothing changed; MSW tests cover the confirm gate, request shapes, and error state.

## Blocked by

- Issue 1 — Walking skeleton *(parallelizable with Issue 2)*.

---

# Issue 4 — "Needs review" list: the way in

**Type:** AFK

## What to build

The humble entry point that lets a reviewer find work without knowing run ids. Add an API read endpoint
that returns the checkpoints currently in `pending-baseline` or `diff` state (using the shared
read-model), and an SPA list view showing, per entry: test name, checkpoint name, environment, run time,
and why it needs review (awaiting first approval vs. visual diff). Clicking an entry opens it in the diff
viewer. After a checkpoint is resolved (Issue 3), the list refreshes so it shows only what still needs
attention, and a clear empty state appears when nothing is left. This is explicitly **not** the slice-7
test × environment dashboard — just a flat list, enough to find work.

## Acceptance criteria

- [ ] An API read endpoint returns checkpoints in `pending-baseline` or `diff` state with the shared read-model.
- [ ] The list shows test name, checkpoint name, environment, run time, and the review reason per entry.
- [ ] Clicking an entry opens that checkpoint in the diff viewer.
- [ ] Resolving a checkpoint removes it from the list (the list refreshes after a decision).
- [ ] A clear empty state renders when nothing needs review.
- [ ] Loading and error states render for the list fetch.
- [ ] Browser-E2E: seed pending-baseline and diff checkpoints → they appear in the list → open one → resolve it → it drops off; MSW tests cover empty/loading/error states.

## Blocked by

- Issue 1 — Walking skeleton.
- Issue 3 — Approve / Reject (so "leaves the list after a decision" is demoable).
