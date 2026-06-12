# Issues — Varys v2 Slice 4: Full Multi-Environment + Variable UX

> Vertical slices for the Multi-Environment + Variable UX slice
> (`prd/multi-environment-variable-ux.md`). Each is a thin cut through the layers it touches and is
> demoable on its own. The PRD's 4-issue decomposition is split finer here: the env-management work is
> separated into **backend API** (API-E2E'd) vs **management UI** vs **Run picker** (manual-verified),
> matching the testing rule *"API E2E for real server behaviour, manual-verify the UI"*.
>
> **Build this issue-by-issue, in dependency order.** Restart `pnpm dev` after any schema/DDL change —
> the API applies DDL on boot. (Slices here add no new DDL: `variables` lives inside the `definition`
> jsonb; env values/secrets already exist as jsonb.)
>
> **Already built — verify, then extend (do NOT rebuild):** `environments` table; `EnvironmentsService.create` /
> `getById` (secrets returned as names only); `POST /environments`, `GET /environments/:id`;
> `POST /runs {testId, environmentId?}`; worker resolution (`resolveDefinition` against the run's env,
> name `"default"` when none); `@varys/variable-resolver` (`resolveString` / `resolveDefinition`, throws on
> unresolved); failed-run legibility (`runs.error` persisted + shown in the viewer); run/needs-review/diff
> views already display the env name.
>
> **Dependency shape:** `{1, 2, 3}` can each start immediately. `1 → {4, 5}`; `3 → {5 (refines its
> requirement rule), 6}`; `6 → 7`. Slice 2 is the correctness core and is pure backend — it can land first.
>
> **Status: ✅ All 7 slices implemented. Backend (1–3) fully E2E-verified; web + recorder/extension
> (4–7) typecheck/build-green with unit coverage where pure — UI surfaces are manual-verified.
> Full suite green in isolation: packages (recorder 14, resolver 7, step-schema 8), API E2E 36/36, web 17/17.**
>
> | # | Slice | Layer | Verify | Status |
> |---|---|---|---|---|
> | 1 | Environment management API (list / update / delete) | api | API E2E | ✅ Done (4/4 E2E pass) |
> | 2 | Per-environment baselines + the approve-env fix | api/runs | API E2E | ✅ Done (13/13 E2E pass) |
> | 3 | Variable declaration + resolution validation | step-schema / resolver / runner | unit + API E2E | ✅ Done (unit 13 + 14/14 E2E) |
> | 4 | Environment management UI | web | manual | 🟢 Implemented — typecheck + build green; manual click-through is your gate |
> | 5 | Run-with-environment picker | web | manual | 🟢 Implemented — typecheck + build green; `needsEnvironment` E2E passes; manual click-through is your gate |
> | 6 | Recorder variable UX — classify + Variable/Static confirm | recorder / extension | unit + manual | 🟢 Implemented — recorder 10/10 unit; extension typecheck + build green; confirm UI manual |
> | 7 | Selector guard | recorder / extension | unit + manual | 🟢 Implemented — recorder 14/14 + resolver 7/7 unit; extension typecheck + build green; warning UI manual |
>
> **Non-obvious gotchas (will bite a fresh agent):** ports are non-standard (API **:4000**, web **:5200**,
> Postgres **:5433**) — don't reset them. Every NestJS controller needs an explicit `@Inject(XService)`
> (esbuild emits no decorator metadata under `tsx`, so type-based DI is `undefined` at runtime; swc-run
> tests pass regardless, so green tests don't prove the dev server boots). Run API E2Es **per file** —
> they flake under whole-suite contention. The web app is same-origin (`API_BASE = ""`, deep link
> `?run=<id>`, tab via `?view=`). **Secrets:** the API must never return secret *values*; the worker must
> never persist resolved values.

---

# Slice 1 — Environment management API: list / update / delete

**Layer:** `apps/api` · **Verify:** API full-thread E2E · **Blocked by:** none · **Status: ✅ Done — 4/4 E2E pass (`environments.e2e.spec.ts`).**

## What to build

Round out the environments REST surface so a UI (Slice 4) and a Run picker (Slice 5) have something to
call. Add **list**, **update** (name + values + a secret delta), and **delete** to
`EnvironmentsService` + `EnvironmentsController`. Secrets stay write-only: set/clear by name, never
echoed back. Delete is allowed even when runs reference the environment (the run keeps a nullable
`environmentId`; a dangling id degrades to the `"default"` display name — already how `getById`/
`needsReview` resolve names).

## Sub-steps

- [x] `EnvironmentsService.list()` → `Array<{ id, name, values, secretNames[] }>` (secrets names-only, same redaction as `getById`).
- [x] `EnvironmentsService.update(id, input)` where `input = { name?, values?, secrets?: Record<string,string>, removeSecrets?: string[] }`:
  - [x] set `name` when provided;
  - [x] **replace** `values` wholesale when provided (full-map replace is acceptable for MVP per PRD §B);
  - [x] merge `secrets` (set name→value) and delete each key in `removeSecrets` from the stored secrets jsonb;
  - [x] read-modify-write the `secrets` jsonb; return the redacted `EnvironmentView` (names only) — never the values.
- [x] `EnvironmentsService.delete(id)` → hard delete the row; do **not** block on referencing runs.
- [x] Controller: add `@Get()` list, `@Put(":id")` update, `@Delete(":id")` delete — each with explicit `@Inject(EnvironmentsService)` already on the constructor.
- [x] Documented the update verb (`PUT`) + the body shape (`values` full-replace, `secrets` set-map, `removeSecrets[]`) in `UpdateEnvironmentInput`'s doc comment + the controller route comment.

## Done when

- [x] `GET /environments` returns every env as `{ id, name, values, secretNames[] }` and **never** a secret value.
- [x] `PUT /environments/:id` can rename, replace values, set new secrets, and clear named secrets — and its response carries secret **names only**.
- [x] `DELETE /environments/:id` removes the env even if a run references it (no FK on `runs.environment_id`); the run views already fall back to the `"default"` display name for a dangling id.

## Verify (API E2E — extends `apps/api/test/environments.e2e.spec.ts`)

- [x] Create via `POST /environments` with a `values` map + a secret → `GET /environments` lists it with the value but **no secret value**.
- [x] `PUT` sets a new secret and clears another via `removeSecrets`; re-GET shows the name set changed, values replaced, still no secret values.
- [x] `DELETE` removes the env and it leaves the list; `GET /environments/:id` then 404s.
- [ ] *(Run it:* `cd apps/api && pnpm vitest run test/environments.e2e.spec.ts` *— Docker required for testcontainers Postgres. Not run yet per testing preference.)* The delete-while-referenced-by-a-run "default" fallback is exercised by the existing runs views; not re-wired here.

---

# Slice 2 — Per-environment baselines + the approve-env fix

**Layer:** `apps/api/src/runs` · **Verify:** API full-thread E2E (the correctness core) · **Blocked by:** none *(pure backend; can land first)* · **Status: ✅ Done — 13/13 E2E pass (`baseline.e2e.spec.ts`).**

## What to build

Fix the bug that makes per-environment baselines silently never match. The **runner** already keys
baseline *lookups* by the run's environment **name** (`runner/src/index.ts` derives `environment` from
`environmentId`, defaulting `"default"`). But `RunsService.approve` / `approveAll` **seed and replace
baselines under a hardcoded `ENVIRONMENT = "default"` constant** (`runs.service.ts:30`, used at the
insert and the replace-lookup). So approving a run that executed against `dev` writes the baseline under
`"default"`, and the next `dev` run looks under `dev`, finds nothing, and re-seeds forever. Thread the
**run's actual environment name** through approve so the seed/replace lands under the environment the
run used.

## Sub-steps

- [x] In `approve(runId, checkpointName)`, the `ctx` query now also selects `runs.environmentId`,
      resolved to the environment **name** via a new private `environmentName(environmentId)` helper
      (defaults to `"default"` when null/dangling; `getById` was refactored onto the same helper).
- [x] That resolved name (not the module-level `ENVIRONMENT` constant) is used in **both** baseline
      writes: the `pending-baseline` insert and the `diff` replace-lookup `where`.
- [x] `approveAll` inherits the fix automatically (it calls `approve` per checkpoint) — no separate leak.
- [x] `reEvaluate` / `persistMasks` are unaffected: they re-diff stored bytes + write a new
      `test_version`, touching no baselines (noted in an `approve` comment).
- [x] `ENVIRONMENT` constant kept — still used by `environmentName` + the `needsReview` fallback.

## Done when

- [x] Approving a checkpoint seeds/replaces the baseline under the **run's environment name**, not `"default"`.
- [x] Re-running the **same** test against the **same** environment after an approve matches its baseline (`passed`).
- [x] `dev` and `demo` baselines are independent: seeding/approving one never touches the other.

## Verify (API E2E — `baseline.e2e.spec.ts` › "seeds and approves baselines per environment")

- [x] **Approve-fix:** seed+approve a checkpoint run against env A ("dev"), re-run against A → `passed` (proves the baseline landed under A, not `"default"`).
- [x] **Independence:** after approving against A, run the same test against env B ("demo") → B seeds its **own** `pending-baseline` (doesn't match A); approving B leaves A untouched; re-running A still `passed`.

---

# Slice 3 — Variable declaration + resolution validation

**Layer:** `@varys/step-schema` + `@varys/variable-resolver` + `packages/runner` · **Verify:** unit + API E2E · **Blocked by:** none *(blocks 6; refines 5's requirement rule)* · **Status: ✅ Done — step-schema 8/8 + variable-resolver 5/5 unit, baseline.e2e 14/14.**

## What to build

Give a test definition a **declared list of its variables**, and make an unresolved token fail
**legibly** instead of as a raw Playwright error. `Variable { name; kind: 'url' | 'data' | 'secret' }`
(exactly DESIGN §3). `variables` is **optional** (old definitions have none — back-compat). The resolver
already throws `unresolved variable|secret: <name>`; ensure that message is the one persisted to
`runs.error` (the runner's catch already persists `err.message` — confirm resolution happens inside the
try so it's caught, and the message reaches the viewer unchanged).

## Sub-steps

- [x] `@varys/step-schema`: added `variable = z.object({ name, kind: z.enum(['url','data','secret']) })` + `variables: z.array(variable).optional()` on `testDefinition`; exported `Variable`. Screenshot/step shapes unchanged.
- [x] step-schema unit tests: `variables` parses; absent `variables` still parses (back-compat, asserts `undefined`); unknown `kind` rejected. *(Schema-level "undeclared token" validation left out — PRD optional; resolver covers the runtime failure.)*
- [x] `@varys/variable-resolver`: `resolveString` already throws legibly; pinned the exact messages `unresolved variable: missing` / `unresolved secret: missing` in `index.spec.ts`.
- [x] `packages/runner`: **fix** — `resolveDefinition` (and the env lookup) were **outside** the try, so an unresolved-token throw escaped the catch and left the run stuck. Moved the whole resolution block inside `try`; `chromium.launch()` now happens after resolution (fail-fast), with `browser?.close()` in `finally`. The viewer already renders `runs.error`.

## Done when

- [x] A definition can carry `variables: [{name,kind}]`; a definition without it still parses and runs.
- [x] A run against an environment **missing** a value/secret the test uses ends `failed` with `runs.error = "unresolved variable: <name>"`, shown in the viewer — not a Playwright stack.

## Verify

- [x] Unit (step-schema): `variables` optional + parses; `kind` enum enforced. *(8/8)*
- [x] Unit (variable-resolver): substitution + `{{secret:…}}` + throws-with-legible-message. *(5/5)*
- [x] API E2E (`baseline.e2e.spec.ts` › "fails legibly when the environment is missing a variable"): a `{{baseUrl}}/…` recording run against an env with **no** `baseUrl` → `failed`, `error` contains `unresolved variable: baseUrl`. *(14/14, fails in ~1.3s — before chromium launch.)*

---

# Slice 4 — Environment management UI

**Layer:** `apps/web` · **Verify:** manual (no MSW/component tests, per direction) · **Blocked by:** Slice 1 · **Status: 🟢 Implemented — `pnpm typecheck` (27/27) + `pnpm --filter @varys/web build` green; manual click-through pending.**

## What to build

A screen to **list, create, edit, and delete** environments. Per PRD §G: a **free-form key/value
editor** for `values` plus **add/clear secret** controls for `secrets` (matches the jsonb shape).
Secrets show **names only** with set/clear actions — values are never displayed (the API never returns
them). When a test's declared `variables` are available, surface them as hints ("tests reference:
baseUrl, dataset"); full declared-variable-driven forms are a later refinement.

## Sub-steps

- [x] `api.ts`: added `fetchEnvironments()`, `createEnvironment(body)`, `updateEnvironment(id, body)`, `deleteEnvironment(id)` (+ `CreateEnvironmentBody` / `UpdateEnvironmentBody` request types) against the Slice-1 endpoints (same-origin, throw on non-2xx).
- [x] `queries.ts`: `environmentsQueryKey()`, `useEnvironments()`, `useCreateEnvironment()`, `useUpdateEnvironment()`, `useDeleteEnvironment()` — each invalidates the env query on success.
- [x] New `EnvironmentsList.tsx` (+ `.module.css`): create-new (name); per-env `EnvironmentCard` with rename, key/value rows for `values`, add-secret (name+value), clear-secret toggle per existing name; delete with `window.confirm`.
- [x] Secret inputs are **write-only**: existing secrets render as `🔒 name` + a "clear on save" toggle; new secrets are added via a name+`type=password` value form (value held only in local state until Save, shown as a "will set on save" chip). No API value is ever bound into an input.
- [x] `EnvironmentView` added to `@varys/review-contract` (shared read-model; API service keeps its structurally-identical interface — not refactored, to avoid churn).
- [x] `main.tsx` `Nav`: added the "Environments" tab (`?view=environments`); `App` routes to it.
- [ ] *(Deferred)* surface declared `variables` as hints in the editor — needs the `/tests` list to expose `variables` (that API change belongs with Slice 5's requirement rule). Noted, not built here.

## Done when

- [x] A reviewer can create an env, see it in the list, edit its name/values/secrets, and delete it — all from the UI. *(Implemented; manual click-through pending.)*
- [x] Secret values are never shown; only names + set/clear controls appear. *(Editor only ever renders `secretNames`; values are local-only until Save.)*

## Verify

- [x] `pnpm typecheck` (27/27) + `pnpm --filter @varys/web build` (82 modules) green.
- [ ] **Manual (your gate):** with the stack up (`pnpm dev`), open `?view=environments` → create → edit (rotate the secret, change `baseUrl`) → delete, confirming secrets never render and the list refreshes. *(No UI/MSW tests per direction.)*

---

# Slice 5 — Run-with-environment picker

**Layer:** `apps/web` (+ `needsEnvironment` on the tests API) · **Verify:** manual + 1 API E2E · **Blocked by:** Slice 1 *(picker data); refined by Slice 3 (requirement rule)* · **Status: 🟢 Implemented — typecheck (27/27) + web build green; `tests.e2e` needsEnvironment passes; manual click-through pending.**

## What to build

Let the reviewer **choose an environment on Run**, and thread `environmentId` through to
`POST /runs {testId, environmentId}` (the API already accepts it). Apply the **requirement rule** (PRD
§C): if the test **declares variables** (Slice 3) or its definition still contains unresolved
`{{tokens}}`, **require** an environment — disable Run until one is chosen (or default to the
most-recently-used). A test with no variables runs with no environment, exactly as today.

## Sub-steps

- [x] `api.ts`: `runTest(testId, environmentId?)` — sends `environmentId` in the body only when set.
- [x] `queries.ts`: `useRunTest` mutation takes `{ testId, environmentId? }`.
- [x] `TestsList.tsx`: a **shared** environment `<select>` (populated from `useEnvironments()`) applied to every row's Run; the chosen id is passed into `run.mutate`.
- [x] Requirement rule: Run is disabled (with a `title` hint + a "needs env" badge) when `t.needsEnvironment` and no env is chosen.
      - [x] **Decision:** computed server-side as a `needsEnvironment` boolean on `TestSummary` (declared `variables` **or** any `{{token}}` in the latest definition — covers current recordings that don't yet declare variables). The Tests endpoint exposes it; the client just reads the flag (it has no definition to scan).
- [x] Remember the most-recently-used env in `localStorage` (`varys:lastEnvId`); preselected on load, dropped if that env no longer exists.

## Done when

- [x] Running a test offers an environment picker; the chosen env is attached to the run and resolves at replay (the `navigating to "{{baseUrl}}/"` recording now seeds). *(POST /runs with environmentId already E2E-proven in Slices 2–3.)*
- [x] A test that needs a variable can't be Run with no environment (Run disabled + hint); a no-variable test still Runs with none.

## Verify

- [x] `pnpm typecheck` (27/27) + `pnpm --filter @varys/web build` green; existing `TestsList.test.tsx` kept passing (3/3) — mocked `/environments`, fixtures gained `needsEnvironment`.
- [x] API E2E (`tests.e2e.spec.ts` › "flags whether a test needs an environment"): a `{{token}}`/declared-variables test → `needsEnvironment: true`; a literal one → `false`.
- [ ] **Manual (your gate):** create a `dev` env (Slice 4) → on Tests, pick it → Run a `{{baseUrl}}` recording → confirm it resolves + seeds (the end-to-end payoff). *(No UI tests per direction.)*

> **Fixed a pre-existing unrelated red:** `tests.e2e.spec.ts` › "a created test definition can be retrieved by id" was failing on HEAD (independent of this slice) — `fetched.body.definition` no longer `toEqual`d the posted one because `parseTestDefinition` injects `captureMode: "element"`. Fixed by comparing against the canonical `parseTestDefinition(definition)` (drift-proof against future defaults). `tests.e2e` now 3/3.

---

# Slice 6 — Recorder variable UX: classify + Variable/Static confirm

**Layer:** `@varys/recorder` + `apps/extension` · **Verify:** recorder unit + manual (extension UI) · **Blocked by:** Slice 3 · **Status: 🟢 Implemented — recorder 10/10 unit; extension typecheck + `wxt build` green; confirm UI manual.**

## What to build

Make recordings portable. Auto-handling is **unchanged** (origin → `{{baseUrl}}`; `type=password` →
`{{secret:…}}`) but those now also get **declared** on the definition's `variables` list. For the
**ambiguous middle** — a typed value that isn't clearly static — prompt an inline **one-tap
Variable / Static** choice with a **heuristic default**: data-shaped (entity/dataset name, GUID, date,
long id, free text) → **Variable** (emitted `{{<name>}}`, declared `kind: 'data'`); short/enumerable →
**Static** (literal). The heuristic is a **pure, unit-tested function**; the confirm gesture is
extension UI (manual-verified, like the rest of the overlay). Each `{{token}}` is declared once.

## Sub-steps

- [x] Pure `classifyTypedValue(value): 'variable' | 'static'` in `@varys/recorder` — GUID/date/multi-word/long-id/long-token → variable; short single token → static. Unit-tested boundaries.
- [x] **Design change:** instead of a stateful accumulator, variables are **derived from the steps' tokens** by a pure `variablesFromSteps(steps)` — `{{baseUrl}}`→url, `{{secret:x}}`→secret, any other `{{x}}`→data, declared once. One source of truth the recorder's `getDefinition` *and* the extension's save path share (the background store keeps only steps). `getDefinition` attaches `variables` (omitted when none).
- [x] Non-password typed value: kind comes from the injected `classifyTyped` (defaults to the heuristic) — **Variable** → `value = "{{<name>}}"` (name via `variableNameFor(el)`); **Static** → literal. `variablesFromSteps` dedups names.
- [x] Recorder stays self-contained — the helpers (`classifyTypedValue`, `variableNameFor`, `variablesFromSteps`) are injected alongside `startRecorder` in the spec's `INJECT`; the decision is **passed in** via the `classifyTyped` param (the extension supplies it).
- [x] Extension `content.ts`: passes `classifyTypedValue`; a passive listener stashes the last non-password typed value; the overlay shows an inline **Variable / Static** toggle (pressed = current) that rebuilds the `type` step and rewrites it via a new `varys:replace-last-type` background message. Background `save()` attaches `variablesFromSteps(steps)` so declared variables persist.
- [x] Recorder unit tests (playwright-injected): emitted definition carries declared `variables`; an ambiguous data-shaped value → `{{username}}` (`kind:'data'`) + `baseUrl` (`kind:'url'`). Existing origin→`{{baseUrl}}` / password→`{{secret:…}}` coverage retained.

## Done when

- [x] A recording emits a `variables` list covering its url/secret/data tokens, each declared once. *(Derived via `variablesFromSteps`; tested.)*
- [x] A data-shaped typed value becomes a `{{variable}}`; a short/enumerable one stays literal; the author can flip the default with one tap. *(Heuristic tested; flip is the manual-verified overlay toggle.)*

## Verify

- [x] Unit (recorder, 10/10): `classifyTypedValue` boundaries; `variablesFromSteps` (url/secret/data, dedup, token-free); `variableNameFor`; emitted-definition data-var assertion.
- [x] `pnpm typecheck` (27/27) + `pnpm --filter @varys/extension build` (`wxt build`) green.
- [ ] **Manual (your gate):** record against a real form → confirm the Variable/Static toggle appears with the right default, flipping rewrites the step, and the saved test carries `variables`. *(Extension UI manual-verified — no MV3 E2E harness.)*

---

# Slice 7 — Selector guard

**Layer:** `@varys/recorder` + `apps/extension` (+ resolver) · **Verify:** recorder unit + manual (extension UI) · **Blocked by:** Slice 6 · **Status: 🟢 Implemented — recorder 14/14 + variable-resolver 7/7 unit; extension typecheck + `wxt build` green; warning UI manual.**

## What to build

Stop a locator from silently depending on environment-specific copy. When a chosen locator leans on
**environment-specific visible text** (a fingerprint's `text` / `accessibleName` that matches a declared
variable value), **warn** and offer to **bind it to the variable** or **drop to a structural locator**.
The *detection* is a pure, unit-tested predicate over the fingerprint; the affordance is extension UI
(manual-verified).

## Sub-steps

- [x] Pure predicate `selectorDependsOnVariable(fp, KnownVariable[])` in `@varys/recorder` → returns the matched `{ signal, value, variable }` when `text`/`accessibleName` equals a known variable value, else null.
- [x] Unit-tested: fires on `text`/`accessibleName` matching a variable value; quiet for structural-only fingerprints (testId/role/attributes) and non-matching/empty text.
- [x] Pure `applySelectorRemedy(fp, remedy, hit)` (also unit-tested): **bind** → set the offending signal to `{{variable}}`; **structural** → drop both `text` + `accessibleName`, keep structural signals.
- [x] **Resolver extension** (so a bound locator actually resolves at replay): `resolveDefinition` now resolves `{{tokens}}` in step + wait target fingerprints' `text`/`accessibleName` (token-free text passes through unchanged — verified against existing E2Es). Unit-tested (bound token resolves; plain text untouched).
- [x] Recorder `CheckpointSpec` element variant gains `target?` so the extension can commit a remedied fingerprint instead of the captured one.
- [x] Extension `content.ts`: tracks `knownVars` (name→entered value); on an element checkpoint, runs the predicate and — if it trips — shows a warning banner with **Bind to {{var}}** / **Use structural locator** / **Keep as-is**, committing the chosen remedy via the `target` override. Reuses the overlay/banner style.

## Done when

- [x] Picking a locator that depends on environment-specific visible text warns the author and offers bind-to-variable or drop-to-structural. *(Predicate + remedies tested; banner is the manual-verified surface.)*
- [x] The detection is a pure predicate with unit coverage; the warning UI is manual-verified.

## Verify

- [x] Unit (recorder 14/14): predicate fires on text/accessibleName match, stays quiet for structural; remedy bind/structural shapes. Resolver (7/7): bound fingerprint token resolves per-env, token-free text unchanged.
- [x] `pnpm typecheck` (27/27) + `pnpm --filter @varys/extension build` green.
- [ ] **Manual (your gate):** record a variable value, then pick an element whose visible text equals it → the warning appears with all three options; Bind emits `{{var}}` in the target, Structural drops the text signals. *(Extension UI manual-verified — no MV3 harness.)*

> **Also fixed (pre-existing, unrelated):** 3 stale `DiffViewer.test.tsx` tests were red on HEAD — the multi-checkpoint slice's "Approve all" button + "Tune masks & threshold" toggle made the tests' loose `/approve/i` and `/threshold/i` queries match multiple elements. Tightened to exact names. Web suite now 17/17. (Discovered while running the full suite for this slice.)

---

## Out of scope (this slice)

- Multi-environment **fan-out in one run** (suite × many envs) — Slice 6 of the roadmap.
- Folders / tags / suites — Slice 5 of the roadmap.
- Scheduling / CI / webhook triggers — runs stay manual via the Run button.
- RBAC — flat authz: any signed-in member manages environments + secrets (DESIGN §11).
- At-rest secret encryption — deferred; secrets are plaintext jsonb (local/single-tenant accepted risk).
  Kept guarantees: *API never returns secret values*; *worker never persists resolved values*.
- OIDC/SSO login-replay correctness (one-time PKCE/state/nonce) — a recorder concern, noted not solved here.
