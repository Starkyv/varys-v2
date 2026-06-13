# Issues — Varys v2 Slice 5: Organization (Folders + Tags + Suites)

> Tracer-bullet issues for the Organization slice (`prd/organization-folders-tags-suites.md`).
> Three **truly vertical** slices — each cuts schema → API → contract → `apps/web` and is
> demoable in the browser on its own. *(The PRD sketched a 4-way backend/UI split; per user
> direction this was re-cut to 3 full-stack slices — implementation first.)*
> *Not published to an issue tracker — none configured; the `ready-for-agent` label could not
> be applied. Build order = dependency order below.*
>
> **Testing posture (per user direction):** no UI/component tests anywhere; API E2Es only
> where a real server guarantee is worth pinning — exactly **two compact chromium-free E2Es**
> in the whole slice (Issue 1: delete-folder-unfiles + organize-never-reversions; Issue 3:
> delete-suite-leaves-tests + membership full-replace). All CRUD happy paths and all UI are
> **manual-verified**. Run E2Es per file.
>
> **Hard rules that bite here:** organization metadata is **relational, never in the
> definition jsonb** — organize actions must create no `test_version` and touch no baselines.
> New NestJS controllers need explicit `@Inject(Service)` (esbuild emits no decorator
> metadata — green tests don't prove the dev server boots). DDL is additive
> (`IF NOT EXISTS`); **restart `pnpm dev` after schema changes**. Ports: API :4000,
> web :5200, Postgres :5433.
>
> **Dependency shape:** `{1, 3}` can start immediately; `1 → 2`.
>
> **Status: 🟢 All three issues implemented — both pinned E2Es green (folders.e2e 3/3,
> suites.e2e 2/2); typecheck 27/27; web build + existing TestsList tests green. The UI
> surfaces (folder bar, organize editor, tag filter/chips, Suites tab) are your manual
> click-through gate. Restart `pnpm dev` once — the folders/test_tags/suites DDL applies
> on API boot.**
>
> | Issue | Status |
> |---|---|
> | 1 — Folders + test rename (full stack) | 🟢 Implemented — E2E 2/2, typecheck + web build green; UI manual click-through pending |
> | 2 — Tags (full stack) | 🟢 Implemented — folded tag E2E passes (folders.e2e 3/3); typecheck + web build green; UI manual click-through pending |
> | 3 — Suites (full stack) | 🟢 Implemented — suites.e2e 2/2; typecheck + web build green; UI manual click-through pending |

---

# Issue 1 — Folders + test rename: file, rename, and browse tests (full stack)

**Type:** AFK · **Blocked by:** none · **Status: 🟢 Implemented — `folders.e2e` 2/2; typecheck 27/27; web build + existing TestsList tests green; UI manual click-through pending.**

## Parent

`prd/organization-folders-tags-suites.md` (Slice 5 of the roadmap in `DESIGN.md`, §5).

## What to build

Give every test a browsable home and an editable name. A flat set of named **folders** (no
nesting; names unique); each test lives in at most one (`null` = **Unfiled**). Folders can be
created, renamed, and deleted — deleting a folder **unfiles** its tests (mirrors the
environment-delete precedent: graceful degradation, never destroys tests). A test gains a
**partial-update** action carrying `{ name?, folderId? (nullable) }` so a recording saved as
`recorded` can finally be renamed and filed. The tests **list read-model** gains
`folderId`/`folderName` alongside the existing fields (`needsEnvironment` etc. — keep it one
fetch), with new `FolderSummary` (id, name, testCount) in the shared review-contract. The
Tests view gains a **folder filter** (all / each folder / Unfiled) and a per-test **organize
affordance** (rename + set/clear folder) — the Run button and environment picker stay
untouched. Organization metadata lives in relational tables around `tests`, never inside
`test_versions.definition`: filing or renaming creates **no new test version** and cannot
perturb baselines, masks, thresholds, or review state.

## Acceptance criteria

- [x] Folders can be created, listed (with per-folder test counts), renamed, and deleted; creating/renaming to a duplicate name is a conflict error. *(unique constraint → 409.)*
- [x] A test can be renamed and moved into / out of a folder via a partial update (`PATCH /tests/:id` `{name?, folderId?}` — null unfiles; bogus folder → 404); the tests list carries `folderId`/`folderName`.
- [x] A test with no folder appears under **Unfiled**; deleting a folder unfiles its tests — enforced by the DB itself (`folder_id` FK `ON DELETE SET NULL`).
- [x] Renaming/filing a test creates **no new test_version** — structural (the update writes only the tests row); pinned by E2E (version stays 1, definition jsonb untouched).
- [x] Tests view: folder filter (All / Unfiled / per-folder with counts) + folder create/rename/delete + per-row ✎ organize editor (rename, file); Run + env picker unchanged. *(Manual click-through pending — no UI tests.)*
- [x] One compact chromium-free API E2E (`folders.e2e.spec.ts`, 2/2) pinning exactly: delete-folder-unfiles and organize-creates-no-version. No other automated tests added; the 3 existing TestsList component tests maintained (fixtures only).
- [x] New controller uses explicit `@Inject(FoldersService)`; DDL additive (`CREATE TABLE IF NOT EXISTS folders` + `ALTER TABLE tests ADD COLUMN IF NOT EXISTS folder_id`); **restart `pnpm dev`** to apply.

## Blocked by

None — can start immediately.

---

# Issue 2 — Tags: slice tests across folders (full stack)

**Type:** AFK · **Blocked by:** Issue 1 · **Status: 🟢 Implemented — tag E2E folded into `folders.e2e` (3/3); typecheck 27/27; web build + existing TestsList tests green; UI manual click-through pending.**

## Parent

`prd/organization-folders-tags-suites.md` (Slice 5 of the roadmap in `DESIGN.md`, §5).

## What to build

Let tests be sliced across folder boundaries with free-form **tags** (`release:5.0`,
`feature:dashboard` — colon namespacing is convention, not schema). Tags are a
`(testId, tag)` join relation with unique pairs — no tags entity, no tag CRUD. The Issue-1
partial-update gains `tags` (full-list replace; trimmed, empties and duplicates dropped). A
read-only **distinct tags in use** listing feeds pickers/filters. The tests list read-model
gains `tags`. The Tests view gains a **tag filter** and tag editing inside the Issue-1
organize affordance (add from existing or type new, remove). Tagging, like filing, never
creates a test version.

## Acceptance criteria

- [x] A test's tags can be set via the partial update (full replace covers add + remove, transactional with the row patch); duplicates/whitespace-only normalized away; uniqueness enforced by the composite PK `(test_id, tag)`.
- [x] The tests list carries each test's `tags` (alphabetical); read-only `GET /tags` lists the distinct tags in use.
- [x] Tests view: tag filter (appears once any tag exists; stale filter auto-resets); tag chips on rows; organize affordance edits tags (datalist autocomplete from tags-in-use, × to remove, unconfirmed input counted on Save). *(Manual click-through pending — no UI tests.)*
- [x] Tagging creates no new test_version — same structural guarantee as Issue 1 (the update writes only `tests` + `test_tags` rows).
- [x] One tag assertion folded into Issue 1's E2E file (`folders.e2e.spec.ts`, now 3/3): normalization + list surfacing + distinct listing + full-replace removal. No other automated tests; the 3 existing TestsList component tests maintained (fixtures only).

## Blocked by

- Issue 1 — Folders + test rename *(extends the same partial-update endpoint and organize affordance).*

---

# Issue 3 — Suites: the saved selection that slice 6 will run (full stack)

**Type:** AFK · **Blocked by:** none *(parallel with Issues 1–2)* · **Status: 🟢 Implemented — `suites.e2e` 2/2; typecheck 27/27; web build green; UI manual click-through pending.**

## Parent

`prd/organization-folders-tags-suites.md` (Slice 5 of the roadmap in `DESIGN.md`, §5).

## What to build

Make the **run unit** exist: a **suite** is a named, explicit selection of tests — what
slice 6 (suite runs + parallelism, depends on 4 + 5) will execute as `suite × env(s)`. Suites
support create (name + optional initial members), list (with member counts), get-by-id (with
member test summaries), rename, **member full-replace** on update (the slice-4 precedent),
and delete — which removes memberships only, never the member tests. One test may belong to
many suites. New `SuiteSummary` / `SuiteView` types in the shared review-contract. A new
run-less **Suites** tab in the web app (same `?view=` routing as Tests/Environments/Runs):
list suites, create, rename, pick members (checkbox the saved tests), delete — with copy
making clear that *running* a suite arrives in a later slice (no Run affordance anywhere).
Dynamic (tag-query) membership is explicitly deferred.

## Acceptance criteria

- [x] Suites can be created (with or without initial members), listed with member counts, fetched with member test summaries (full `TestSummary[]` — folder/tags/needsEnvironment context reused from `TestsService.list()` via a module export), renamed, and deleted.
- [x] Updating a suite replaces its member list wholesale (transactional delete+insert; ids deduped; bogus test id → 404); a test can belong to several suites — composite PK `(suite_id, test_id)`.
- [x] Deleting a suite removes the suite + memberships only (CASCADE) — member tests untouched; pinned by E2E (shared member survives in the other suite and the tests list).
- [x] Suites tab (`?view=suites`): list with counts / create / Edit expands rename + checkbox member-picking (rows show folder + tag context) / delete behind a confirm naming that only the selection is deleted; **run-less** with copy pointing at a later slice. *(Manual click-through pending — no UI tests.)*
- [x] One compact chromium-free API E2E (`suites.e2e.spec.ts`, 2/2) pinning exactly: membership full-replace and delete-suite-leaves-tests-intact. No other automated tests.
- [x] New controller uses explicit `@Inject(SuitesService)`; DDL additive (`suites` + `suite_tests`); **restart `pnpm dev`** to apply.

## Blocked by

None — can start immediately *(member picking benefits from Issue 1–2 filters but does not require them).*
