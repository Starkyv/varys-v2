# PRD — Varys v2 Slice 5: Organization (Folders + Tags + Suites)

> **Scope:** give the flat test list an organizing fabric — **folders** (one browsable home per
> test), **tags** (many-to-many slicing), and **suites** (a saved selection of tests = the run
> unit slice 6 will execute). Slice 5 of the roadmap in `DESIGN.md` (table row 5): *"Folders +
> tags + suites (saved selection = run unit). Depends on —."*
> **Status:** ready for implementation. *(No issue tracker is configured — the `ready-for-agent`
> label can't be applied; this file is the source of truth until a tracker is wired up. Run
> `/to-issues` on this PRD to cut the tracer-bullet issues.)*
> **Source of truth for the platform:** `DESIGN.md` — esp. **§5** (organization model: folders =
> where it lives, tags = how you slice it, suites = what you run; *two axes: what to run ×
> where to run*; customer = environment, **not** a folder), **§3** (the test definition is the
> versioned jsonb document — organization metadata deliberately lives *outside* it), **§11**
> (flat authz). **Prior slices:** `prd/mvp.md`, `prd/visual-review-ui.md`,
> `prd/multi-checkpoint-capture-modes.md`, `prd/multi-environment-variable-ux.md`.

---

## Problem Statement

Every saved recording lands in one flat, chronological Tests list. With a handful of tests
that's fine; past that it decays fast:

1. **No home.** There is no way to group tests by feature, page, or area — finding "the
   dashboard tests" means scanning the whole list and parsing names.
2. **No slicing.** A test can't be marked as belonging to a release, a feature, or any other
   cross-cutting concern (`release:5.0`, `feature:dashboard`) — there's exactly one axis: name.
3. **No run unit.** The only runnable thing is a single test. "Run the smoke set against dev"
   doesn't exist as a concept — and slice 6 (suite runs + fan-out, depends on **4, 5**) needs a
   **saved selection** to exist before it can execute one. Today nothing in the data model can
   express it.
4. **Names are immutable.** A recording saved as `recorded` (the extension's default) can never
   be renamed into something findable.

## Solution

Organize without touching the test definition or the replay pipeline:

- **Folders** — a flat set of named folders; each test lives in **at most one** ("one browsable
  home per test", DESIGN §5). Tests without a folder are **Unfiled**. The Tests view groups and
  filters by folder.
- **Tags** — free-form labels, many-to-many (`release:5.0`, `feature:dashboard`, anything).
  The Tests view filters by tag; the set of tags in use is listed for picking.
- **Suites** — a named, saved selection of tests: **the run unit**. This slice creates and
  manages suites (members, rename, delete) so slice 6 can execute `suite × env(s)`. Suites do
  **not** run yet — that is explicitly slice 6.
- **Rename** — a test's display name becomes editable alongside its folder and tags.

Organization metadata is **relational data around tests** — never part of the versioned
definition jsonb. Filing, tagging, renaming, or adding a test to a suite never creates a
`test_version`, never re-judges anything, and never touches baselines or runs.

## User Stories

1. As a test author, I want to **create a named folder**, so that related tests have one
   browsable home.
2. As a test author, I want to **move a test into a folder** (and out again), so that each test
   lives where I expect to find it.
3. As a test author, I want a test with no folder to appear under **Unfiled**, so that nothing
   silently disappears from the list.
4. As a reviewer, I want to **browse the Tests view grouped/filtered by folder**, so that I can
   find an area's tests without scanning everything.
5. As a test author, I want to **rename a folder**, so that the structure can evolve without
   re-filing tests.
6. As a test author, I want to **delete a folder** and have its tests become Unfiled (not
   deleted), so that removing structure never destroys tests.
7. As a test author, I want folder names to be **unique**, so that two folders can't be
   confused for each other.
8. As a test author, I want to **add one or more free-form tags** to a test (e.g.
   `release:5.0`, `feature:dashboard`), so that tests can be sliced across folder boundaries.
9. As a test author, I want to **remove a tag** from a test, so that stale labels don't
   accumulate.
10. As a reviewer, I want to **filter the Tests view by tag**, so that I can see exactly the
    `feature:dashboard` set regardless of which folders those tests live in.
11. As a reviewer, I want to **see the set of tags currently in use**, so that I pick from
    existing labels instead of guessing/misspelling them.
12. As a test author, I want a tag to be **attached at most once per test** (no duplicates),
    so that the tag list stays clean.
13. As a test author, I want tags that differ only by surrounding whitespace or emptiness to be
    **normalized away**, so that junk labels can't be created.
14. As a test author, I want to **rename a test**, so that a recording saved with the
    extension's default name becomes findable.
15. As a test author, I want to **create a named suite**, so that a selection of tests becomes
    a single, durable run unit.
16. As a test author, I want to **add and remove member tests** of a suite, so that the saved
    selection tracks what should run together.
17. As a reviewer, I want to **list suites with their member counts**, so that I can see at a
    glance what run units exist and how big they are.
18. As a reviewer, I want to **open a suite and see its member tests** (with their folder/tags
    context), so that I know exactly what would run.
19. As a test author, I want to **rename a suite**, so that its purpose stays clear.
20. As a test author, I want to **delete a suite** without affecting its member tests, so that
    retiring a run unit is safe.
21. As a test author, I want **one test to belong to many suites** (smoke *and* release), so
    that selections can overlap freely.
22. As a test author, I want **filing/tagging/renaming to never create a new test version**,
    so that organization changes can't perturb baselines, masks, thresholds, or review state.
23. As a reviewer, I want the existing **Run button and environment picker to keep working
    unchanged** on the Tests view, so that organization is additive, not disruptive.
24. As a reviewer, I want **existing tests (recorded before this slice) to appear Unfiled and
    untagged**, so that nothing breaks on upgrade (back-compat).
25. As a test author, I want the **Suites view to make clear that running a suite arrives in a
    later slice**, so that the UI doesn't promise what slice 6 hasn't built yet.
26. As any signed-in member, I want to **manage folders, tags, and suites without role
    gating** (flat authz, DESIGN §11), so that the team isn't blocked on permissions.
27. As a test author, I want **deleting a folder or suite to degrade gracefully** in every
    other view (no dangling references, no broken rows), so that cleanup is never risky.
28. As a reviewer, I want the Tests list to keep carrying **`needsEnvironment` and the run
    affordances** alongside the new folder/tags fields, so that one fetch still drives the
    whole view.

## Implementation Decisions

- **Organization metadata is relational, not part of the definition.** Folders, tags, suite
  membership, and the test's display name live in Postgres tables around `tests` — never
  inside `test_versions.definition`. Changing any of them creates **no new test version** and
  cannot affect replay, diffing, baselines, or review state. (The definition's own `name` field
  remains whatever was recorded; the `tests.name` column is the display name and the rename
  target — it is already the name every view shows.)
- **Folders are a flat namespace for this slice** — no nesting. DESIGN §5 requires "one
  browsable home per test", which a flat set satisfies; hierarchy is deferred until proven
  needed. Each test carries an optional folder reference (`null` = Unfiled). Folder names are
  **unique** (creating/renaming to a duplicate is a conflict error).
- **Deleting a folder unfiles its tests** (sets their folder reference to null) — mirroring the
  environment-delete decision from slice 4 (graceful degradation over referential blocking).
- **Tags are free-form text in a join relation** — `(testId, tag)` unique pairs; no separate
  tags entity, no tag CRUD. Tags are trimmed; empty strings and duplicates are dropped on
  write. The distinct set of tags in use is derivable by query and exposed read-only (for
  filter chips / pickers). Namespacing like `release:5.0` is a **convention, not a schema** —
  the colon means nothing to the system.
- **Suites are explicit membership** — a `suites` entity plus `(suiteId, testId)` unique pairs.
  A suite update **replaces the member list wholesale** (matching the slice-4 precedent of
  full-map replace for environment values — simplest correct write for MVP). Dynamic suites
  (tag-query-defined membership) are deferred. Deleting a suite removes memberships only.
- **Suite execution is out of scope** — slice 6 ("Suite runs + parallelism", depends on 4 + 5)
  builds fan-out/fan-in and `suite × env(s)`. This slice ends at suite CRUD + membership; the
  Suites view carries no Run affordance.
- **API surface (NestJS, new `folders` and `suites` modules + extensions to `tests`):**
  - Folders: list (with per-folder test counts), create, rename, delete.
  - Tags: a read-only "distinct tags in use" listing.
  - Suites: list (with member counts), get-by-id (with member test summaries), create (name +
    optional initial members), update (rename and/or full member-list replace), delete.
  - Tests: a **partial-update action** accepting any of `{ name, folderId (nullable), tags
    (full replace) }`; the tests **list read-model** gains `folderId`, `folderName`, and
    `tags` alongside the existing fields (`needsEnvironment` etc.).
  - Every new controller uses the explicit `@Inject(Service)` constructor token (the esbuild
    no-decorator-metadata gotcha — green tests don't prove the dev server boots without it).
- **Read-model contract (`@varys/review-contract`):** `TestSummary` is extended
  (`folderId`, `folderName`, `tags`); new `FolderSummary` (id, name, testCount), `SuiteSummary`
  (id, name, testCount), and `SuiteView` (suite + member `TestSummary[]`) types. The SPA never
  recomputes any of this — it displays what the API returns.
- **Schema (drizzle + the raw bootstrap DDL, all additive / `IF NOT EXISTS`):** a `folders`
  table; a nullable folder reference on `tests`; a `(test_id, tag)` join table; `suites` and
  `(suite_id, test_id)` join tables with uniqueness on the pairs. **Restart `pnpm dev` after
  the schema change** — the API applies DDL on boot.
- **Web (`apps/web`):** the Tests view gains a folder filter (including Unfiled), a tag filter,
  and a per-test organize affordance (rename, set folder, edit tags) — while keeping the Run
  button + environment picker untouched. A new **Suites** tab (same `?view=` routing as
  Tests/Environments/Runs) lists suites and provides create / rename / member-picking / delete.
  Filtering is **client-side** (the list endpoint already returns every test; the lists are
  small at this scale — no server-side query params yet).
- **Authorization:** flat (DESIGN §11) — any signed-in member manages folders, tags, suites.
  No new auth surface.

## Testing Decisions

A good test asserts **external behavior at the highest existing seam** — HTTP responses and
read-models, never internal wiring. This slice is relational CRUD + read-models with **no
replay involvement**, so the whole automated surface is the **chromium-free API full-thread
E2E** harness (testcontainers Postgres + supertest through the real application module — the
exact harness `environments.e2e.spec.ts` and `tests.e2e.spec.ts` already use; no worker, no
fixture app). *(Seams confirmed with the user.)*

- **Folders E2E:** create → appears in the folder list with a test count; assign a test → the
  tests list carries `folderId`/`folderName`; rename; create-duplicate-name → conflict;
  delete → its tests come back **Unfiled** (null folder) and still run.
- **Tags E2E:** set tags via the test partial-update (full replace — adds and removals in one
  write); duplicates/whitespace normalized away; the distinct-tags listing reflects exactly the
  tags in use; the tests list carries each test's tags.
- **Suites E2E:** create with members → suite list shows the count; get-by-id returns member
  test summaries; update replaces the member list wholesale; rename; delete → the suite is
  gone, its member **tests are untouched**; one test in two suites is fine.
- **Tests partial-update E2E:** rename surfaces in the tests list; the update creates **no new
  test version** (the version count is unchanged — the explicit no-reversioning guarantee).
- **No new unit seams** — this slice introduces no pure functions (no heuristics, resolvers, or
  classifiers), so there are no package-level unit tests. If any normalization grows beyond
  trivial (it shouldn't), it would be tested at the E2E seam through its observable effect.
- **Web: no UI/MSW tests** (per standing direction) — the Tests-view filters, organize
  affordance, and the Suites tab are **manual-verified**. The Tests view's three existing
  component tests must stay green if that component changes (maintenance, not new coverage).
- Run API E2Es **per file** — they flake under whole-suite contention; a lone red that passes
  alone is a flake.

## Out of Scope

- **Running a suite** — fan-out/fan-in, `suite × env(s)`, aggregated parent run reports —
  **Slice 6** (depends on 4 + 5). This slice only makes the run unit *exist*.
- **Dynamic suites** (membership defined by a tag query instead of an explicit list) — revisit
  once real usage shows the explicit list is too chatty.
- **Nested folders** — flat namespace for now.
- **Org / Project tenancy and membership** (DESIGN §5's tenancy half) — the `Org → Projects →
  Members` structure belongs with **Slice 10** (auth & multi-user). See Further Notes on the
  `org_id` hedge.
- **RBAC / role-gating** — flat authz stands (DESIGN §11).
- **Scheduling** (`suite × env × when`) — Slice 8.
- **Test deletion** — doesn't exist in the product yet and isn't added here; suite/folder
  deletion semantics are defined, test deletion is its own future decision.
- **Server-side list filtering/pagination** — client-side filtering is fine at current scale.

## Further Notes

### Why this slice now
Slice 6 (suite runs + parallelism) depends on 4 and 5. Slice 4 (multi-environment + variable
UX) is implemented — so this slice is the last prerequisite before suite execution. It also
fixes a real daily annoyance: extension recordings all save as `recorded` and pile up
unrenameable in one flat list.

### The `org_id` hedge (honest status)
DESIGN §5 calls for `org_id` on root entities so multi-tenancy is "a later flip, not a
migration". Slices 1–4 shipped **without** it (no `org_id` anywhere in the schema). Adding it
only to this slice's new tables would be inconsistent and useless; retrofitting it everywhere
is one additive migration that belongs with **Slice 10** (auth & multi-user), where an org to
point at first exists. Noted as accepted drift from §5, not silently ignored.

### Context for a fresh session (read these first)
- `DESIGN.md` — the durable decision record; §5 / §3 / §11 are the relevant ones here.
- `README.md` — how to run the stack. **Restart `pnpm dev` after schema changes** — the API
  applies DDL (incl. `ALTER … ADD COLUMN IF NOT EXISTS`) on boot.
- `CLAUDE.md` — project rules. **Hard rule: no `Co-Authored-By: Claude` trailer on commits.**
- Prior PRDs/issues: `prd|issues/mvp.md`, `…/visual-review-ui.md`,
  `…/multi-checkpoint-capture-modes.md`, `…/multi-environment-variable-ux.md`.

### Non-obvious gotchas (these will bite a fresh agent)
- **Non-standard ports:** API **:4000**, web **:5200**, Postgres **:5433**. Don't move them.
- **NestJS DI under `tsx`/esbuild needs explicit `@Inject(XService)`** on every controller —
  esbuild emits no decorator metadata; tests pass via swc regardless, so green tests don't
  prove the dev server boots.
- **Don't edit source while a Docker-backed vitest runs**; run API E2Es per file.
- **Same-origin web model:** `API_BASE = ""`; tab routing via `?view=`; deep link `?run=<id>`.
- **Per-user testing preference:** don't run tests unless asked; no UI/MSW tests; API E2E only
  where there's real server behavior; implement issue-by-issue.
- The tests list read-model already computes `needsEnvironment` server-side from the latest
  definition — extending that same query with folder/tags keeps it one fetch.

### Suggested decomposition (run `/to-issues` on this PRD)
Tracer-bullet order — each a thin vertical cut, demoable on its own:
1. **Folders + rename + tags, backend-first** — tables/DDL, folders module, tests
   partial-update, extended tests read-model, distinct-tags listing; chromium-free E2E.
   *(unblocks all UI)*
2. **Tests-view organization UI** — folder/tag filters + the organize affordance
   (rename / file / tag); manual-verified. *(depends on 1)*
3. **Suites backend** — suites module (CRUD + membership full-replace + member read-model);
   chromium-free E2E. *(parallel with 2)*
4. **Suites UI** — the Suites tab: list/create/rename/members/delete, explicitly run-less;
   manual-verified. *(depends on 3)*
