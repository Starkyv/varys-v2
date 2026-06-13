# Varys — UI generation brief (for Claude design)

> Paste this into Claude design **with the `ui/` design-system folder uploaded**
> (`@varys/ui` — tokens, themes, foundations, components). It's the spec for the
> whole web control-plane UI. Generate UI that uses that design system exactly.

---

## 0. Your role & objective

You are designing the **web app for Varys** — an internal visual-regression test
automation platform. Produce a complete, consistent, production-quality UI for the
screens listed in §5, built **entirely on the uploaded design system** (§2). Match
the "Nexus" dashboard aesthetic in the reference screenshots (§7): airy, white cards
on a light-grey canvas, soft shadows, generous rounding, a violet/teal accent system,
SF Pro Display type, a left sidebar + top bar shell, and clean data-viz.

## 1. What Varys is (product context)

Varys does **visual-regression testing**: a user records a test by interacting with a
web app; a server replays it with Playwright, screenshots designated elements, and
**pixel-diffs** them against an approved **baseline** per environment. Changes surface
for human **review** (approve → new baseline, or reject → regression). Tests are
organized with **folders + tags + suites** and run **manually or scheduled**.

This UI is the **control plane**: manage tests, trigger runs, review diffs, organize,
inspect run timelines, and (the new hero) a **dashboard**. It is NOT the recorder
(that's a Chrome extension) — it's everything after a test is recorded.

## 2. NON-NEGOTIABLE: use the uploaded design system (`ui/` = `@varys/ui`)

- **Never hardcode** colors, spacing, radii, shadows, or type. Reference the **CSS
  custom-property tokens**: `var(--color-primary)`, `var(--color-text)`,
  `var(--space-16)`, `var(--radius-xl)`, `var(--shadow-sm)`, `var(--font-size-2xl)`, …
  (full list in `ui/src/themes/_tokens.scss`).
- **Reuse the existing components**: `Button` (primary/secondary/ghost/danger),
  `Badge` (status pills + delta badges), `Card` + `CardHeader`, and the `icons/` set.
- **New primitives**: when a screen needs something not yet in the library, **add it
  to `ui/src/components/` following the same folder template** —
  `Name.tsx` · `Name.module.scss` · `Name.types.ts` · `Name.stories.tsx` · `index.ts`
  — styled only with tokens. Likely additions: `Input`, `Select`, `Checkbox`,
  `Table`, `Tabs`, `Sidebar`/`NavItem`, `TopBar`, `StatCard`, `ProgressBar`,
  `Avatar`, `Tooltip`, `Dialog`/`Modal`, `Toast`, `Sparkline`, `Skeleton`,
  `EmptyState`, `SegmentedControl`, `Dropdown`/`Menu`.
- **Theming**: support light/dark via `[data-theme]` and per-brand via `[data-brand]`
  (already wired in the DS). Don't introduce a parallel theming mechanism.
- **Data-viz**: use the categorical palette `--color-dataviz-1..5` (exported as
  `dataViz` from `@varys/ui/tokens`) for chart series, in legend order.
- **Stack**: React + SCSS Modules (`.module.scss`). Match `@varys/ui` conventions:
  `cx()` for class composition, `forwardRef` where appropriate, tokens over literals.
  No Tailwind, no CSS-in-JS, no other component library.

## 3. Domain model / glossary (use these exact names & fields)

The UI renders read-models from `@varys/review-contract`. **Do not invent fields** —
use these shapes:

- **Test** (`TestSummary`): `id, name, createdAt, needsEnvironment, folderId,
  folderName, tags[]`. A *recording*: ordered steps + fingerprints + checkpoints,
  versioned. `needsEnvironment` ⇒ the Run action must require an environment.
- **Checkpoint** (`CheckpointView`): a named screenshot — the unit of diff/review.
  `name, reviewState(pending-baseline|diff|passed), captureMode(element|fullpage|
  region), resolution(approved|rejected|null), diffScore, threshold, healed, masks[],
  actualUrl, baselineUrl, diffUrl`.
- **Environment** (`EnvironmentView`): `id, name, values{}, secretNames[]` — a
  deployment (dev/demo/lnrs/cfg/carvana). **customer = environment.** Secret *values*
  are never returned (write-only).
- **Variable**: a `{{token}}` in the recording; kinds `url|data|secret`; values live
  per-environment, not in the test.
- **Run** (`RunView`): `runId, status(queued|running|passed|needs_review|failed),
  testName, environment, runTimestamp, error, steps[], failedStepIndex, traceUrl,
  timeline: StepRun[], checkpoints: CheckpointView[]`.
- **StepRun** (timeline row, every run): `index, label, checkpointName, startedAt,
  durationMs, outcome(passed|failed)`.
- **Baseline**: approved golden image per `(test, checkpoint, env, viewport)`. Seeded
  by first run → *pending* → approved once → active. **Replacement is irreversible**
  (approve gets a hard confirm).
- **Needs review** (`NeedsReviewItem`): a checkpoint awaiting a decision —
  `runId, testName, environment, runTimestamp, checkpointName, reviewState`.
- **Folder** (`FolderSummary`): `id, name, testCount`. A test's one home; null =
  Unfiled.
- **Tag**: free-form string; many-to-many across folders (`release:5.0`).
- **Suite** (`SuiteSummary`/`SuiteView`): `id, name, testCount` (+ `tests[]`). A saved
  selection of tests = the run unit.
- **Suite run** (`SuiteRunSummary`/`SuiteRunView`): `suiteRunId, suiteName,
  environments[], status, counts{total,queued,running,passed,needsReview,failed},
  runTimestamp, children: SuiteRunChild[]`. A fan-out of **suite × env(s)**.

**Status taxonomy → Badge tone:** `passed`→success, `needs_review`/`diff`/
`pending-baseline`→warning, `failed`→danger, `queued`/`running`→neutral, `healed`→info.

## 4. Core user flows (design for these journeys)

1. **Record → save** (extension; out of scope here, but tests appear in this UI).
2. **Seed baseline**: first run per env → checkpoints land `pending-baseline` →
   reviewer approves once in the diff viewer → test active.
3. **Run**: from Tests, trigger a test (pick environment if `needsEnvironment`,
   optional "keep trace") → status advances live (poll) → open the run.
4. **Review**: Needs-review queue → open run → diff viewer → per-checkpoint
   **approve/reject** (irreversible confirm on approve), tune **masks + threshold**
   with live **re-evaluate**, or **approve-all** in the run.
5. **Organize & run at scale**: file tests into folders, tag them, build a **suite**,
   run **suite × env(s)** → watch the aggregated **suite-run report**.
6. **Diagnose a failure**: failed run → **step timeline** shows which step failed and
   which never ran (with per-step durations) → **Open timeline** (Playwright trace).
7. **Monitor (Dashboard)**: at-a-glance **test × environment status matrix** → drill
   to a run → checkpoints → diff; runs activity feed; per-checkpoint trend sparklines;
   alerts inbox.

## 5. Screens to design

Ground every screen in the read-models above and the live endpoints noted.

### 5.0 App shell (frame for everything)
- **Left sidebar**: brand mark + product name; grouped nav (e.g. **Overview/Dashboard,
  Tests, Suites, Runs, Needs review, Environments**); collapsible; account/team block
  + secondary actions at the bottom (mirror the Nexus sidebar grouping & active-pill
  treatment).
- **Top bar**: search, notifications/alerts inbox, a primary **Run** / record CTA,
  account avatar + name/role.

### 5.1 Dashboard (HERO — the next thing being built)
- **KPI stat cards** (Card + StatCard + delta Badge): e.g. Tests, Pass rate,
  Needs-review count, Failures (with `↗/↘` delta badges like the screenshots).
- **Test × environment status matrix**: rows = tests, columns = environments, each
  cell = latest run status (colored) → click drills to that run → checkpoints → diff.
- **Runs activity feed**: recent runs (`RunSummary`) with status, test, env, time.
- **Per-checkpoint trend sparklines**: so flaky/newly-broken checkpoints stand out.
- **Alerts**: in-app inbox surface for diffs/failures.

### 5.2 Tests  — `GET /tests`, `/folders`, `/tags`; `PATCH /tests/:id`; `POST /runs`
List grouped/filterable by **folder** and **tags**; organize affordance (file +
retag, inline); per-row **Run** with environment picker (required when
`needsEnvironment`) + remembered "keep trace" checkbox; `needsEnvironment` indicator.

### 5.3 Suites — `GET/POST/PUT/DELETE /suites`; `POST /suites/:id/runs`
Suites with member counts; a **suite editor** (search + multi-select tests); a **Run
panel** with environment **multi-select** + "keep trace" → triggers suite × env(s).

### 5.4 Runs — `GET /runs` (polled)
History table: test, environment, **status badge**, timestamp, error preview;
newest-first; live status; row → run detail.

### 5.5 Suite runs + report — `GET /suite-runs`, `GET /suite-runs/:id` (polled)
History of fan-outs with aggregate **counts**; report = aggregate header + per-child
rows (`SuiteRunChild`) each opening as a normal run.

### 5.6 Needs review — `GET /runs/needs-review` (polled)
Flat triage list of checkpoints awaiting a decision (`pending-baseline` | `diff`) with
just enough context (test, env, checkpoint, time) to open and act.

### 5.7 Run detail / Diff viewer — `GET /runs/:id`; decision/tuning endpoints
- **Header**: test name, environment, timestamp, status badge, **"Open timeline"**
  link when `traceUrl` present.
- **Per checkpoint**: 4 switchable view modes — **side-by-side, diff-highlight
  overlay, swipe slider, onion-skin/blink**; verdict row (`diffScore` vs `threshold`,
  `captureMode`, `healed` flag); **mask editor** (draw rectangles) + **threshold
  slider** with live **re-evaluate** (preview, no re-run) and **persist**.
- **Decisions**: per-checkpoint **Approve** (danger-styled **irreversible confirm**:
  "permanently replaces the baseline — no undo") / **Reject**; **Approve all in run**.
- **Failed run**: no checkpoints — show the **step sequence** with the failing step
  highlighted, steps that never ran dimmed, per-step durations, and the error.

### 5.8 Environments — `GET/POST/PUT/DELETE /environments`
List of environments; editor for **variable values** (plain map) and **secrets**
(write-only — show names only, never values); used by the Run pickers.

## 6. Visual reference (the "Nexus" look)

Mirror the uploaded dashboard screenshots: white **Cards** with `--radius-xl` +
`--shadow-sm` on a `--color-bg-page` canvas; **stat cards** = label + big number
(`--font-size-3xl`, strong) + soft delta **Badge** with a trend arrow; secondary
**Buttons** for Filter/Sort/Export/date pickers; left sidebar with uppercase section
labels (`overline` text role) and a soft active pill; charts in the `dataViz` palette;
muted icon glyphs in rounded squares (the `CardHeader` icon slot).

## 7. Quality bar & what to output

- **Every screen** has **loading (skeleton), empty, and error** states.
- **Accessible**: keyboard focus uses the DS focus ring; meaningful `aria-*`; color is
  never the only status signal (pair with text/icon — see Badge `dot`/`icon`).
- **Responsive**: sidebar collapses; matrix/tables scroll gracefully on narrow widths.
- **Consistent**: identical spacing rhythm, one type scale, tokens everywhere.
- **Deliver**: the screens as React + SCSS-module components that import from
  `@varys/ui`; any new shared primitives added under `ui/src/components/` in the
  standard 5-file template; a brief note of which new components you introduced and
  the tokens you used. Do not restyle or fork the existing `@varys/ui` tokens.
