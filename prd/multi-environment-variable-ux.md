# PRD — Varys v2 Slice 4: Full Multi-Environment + Variable UX

> **Scope:** make environments first-class — **manage them in the UI**, **target a run at one**, keep
> **baselines and diffs per environment**, and turn the recorder's crude origin/password handling into a
> real **variable UX** (declare variables, confirm the "ambiguous middle" at record time, guard
> text-based selectors). Slice 4 of the roadmap in `DESIGN.md` (table row 4): *"Env management, per-env
> profiles, inline variable confirm, env-agnostic guarantees. Depends on 1."*
> **Status:** ready for implementation. *(No issue tracker is configured — the `ready-for-agent` label
> can't be applied; this file is the source of truth until a tracker is wired up. Run `/to-issues` on
> this PRD to cut the tracer-bullet issues.)*
> **Source of truth for the platform:** `DESIGN.md` — esp. **§2** (environment-agnostic variables +
> screenshot-target selection), **§3** (step schema: `variables`, `Variable{name,kind}`), **§4** (baseline
> lifecycle — per-env baselines seed independently), **§5** (customer = environment), **§7** (secret
> scrubbing), **§11** (flat authz). **Prior slices:** `prd/mvp.md`, `prd/visual-review-ui.md`,
> `prd/multi-checkpoint-capture-modes.md`.

---

## Problem Statement

I recorded a test against my real app, hit **Run**, and it failed with *"navigating to `{{baseUrl}}/`"*.
There is nowhere to tell Varys **what `{{baseUrl}}` is**, nowhere to store the **login password** as a
secret, and no way to run the same recording against **dev / demo / a specific customer** — each of
which has its own URL, its own data, and should have its **own approved baselines**.

Concretely, four gaps bite:

1. **Environments aren't usable.** The backend can store an environment and resolve `{{tokens}}` against
   it, but there's **no UI to create or edit one**, **no list endpoint**, and the **Run button attaches
   no environment** — so every recorded test fails at the first navigate, because `{{baseUrl}}` is never
   resolved.
2. **Baselines aren't really per-environment.** The runner keys baselines by the run's environment, but
   **approve seeds them under a hardcoded `"default"`** — so approving in one environment doesn't produce
   a baseline the next run (in that same environment) will find. Per-env baselines are broken until this
   is fixed.
3. **Recordings aren't portable.** Only the navigation **origin** (→ `{{baseUrl}}`) and **password**
   fields (→ `{{secret:…}}`) are auto-parameterized. Any **typed value that varies by environment** — a
   dataset name, an account id, a search term — gets baked in **literally**, so the test only works where
   it was recorded. There's no declared list of a test's variables either.
4. **Secrets need a safe home.** The login password (and similar) must be enterable, stored apart from
   ordinary values, **never returned by the API**, and **never written into runs, logs, or artifacts**.

## Solution

- **Environments are first-class and manageable.** A reviewer can **list, create, edit, and delete**
  named environments. Each carries a **`baseUrl`**, a set of **named variable values**, and a set of
  **named secrets** (write-only — you can set or clear them, but their values never come back).
- **A run targets an environment.** The Run action offers an **environment picker**; the worker resolves
  the recorded `{{tokens}}` against that environment's profile before replay. **Baselines and diffs are
  kept per environment**, seeded and approved **independently** — approving the `dev` baseline never
  touches the `demo` one.
- **Recordings become portable.** At record time the recorder still auto-handles origin and passwords,
  and now asks about the **ambiguous middle** — typed values that might be environment-specific — with a
  **one-tap Variable / Static confirm** and a sensible default, **declares the test's variables**, and
  **guards text-based selectors** so a locator doesn't silently depend on environment-specific copy.

The immediate payoff: the user records on their app, creates a `dev` environment with `baseUrl` + the
login secret, picks it on Run, and gets a real seed → approve → re-run → diff loop — the thing that
failed this session now works.

## User Stories

1. As a reviewer, I want to **see a list of environments**, so that I can pick one to run against or edit.
2. As a reviewer, I want to **create an environment** with a name and a `baseUrl`, so that recordings that
   navigate to `{{baseUrl}}` resolve against it.
3. As a reviewer, I want to **add named variable values** to an environment (e.g. `dataset = "Q3 sales"`),
   so that a recording's `{{dataset}}` token resolves per environment.
4. As a reviewer, I want to **add named secrets** to an environment (e.g. the login `password`), so that a
   recording's `{{secret:password}}` resolves only inside the worker.
5. As a reviewer, I want secret **values to never be shown back to me** (only their names), so that a
   leaked screen or API response can't expose them.
6. As a reviewer, I want to **edit an environment's values and secrets** (set, change, clear), so that I
   can rotate a password or fix a URL without re-creating the environment.
7. As a reviewer, I want to **delete an environment** I no longer use, so that the list stays relevant.
8. As a reviewer, I want to **choose an environment when I run a test**, so that the same recording can be
   exercised against dev, demo, or a customer deployment.
9. As a reviewer, I want a test with unresolved variables to **refuse to run without an environment** (or
   make the missing choice obvious), so that I don't get a cryptic mid-replay failure.
10. As a reviewer, when a run fails because a token has **no value in the chosen environment**, I want a
    **legible error** ("unresolved variable: dataset") in the viewer, so that I know exactly what to add.
11. As a reviewer, I want **baselines kept per environment**, so that `dev` and `demo` (which show
    different data) each have their own golden and don't diff against each other.
12. As a reviewer, I want **approving a checkpoint to seed/replace the baseline for the environment the
    run used**, so that the next run against that environment compares correctly.
13. As a reviewer, I want to **run the same test against several environments over time** and review each
    independently, so that one recording covers all my deployments.
14. As a test author, I want the recorder to keep **auto-parameterizing the navigation origin** to
    `{{baseUrl}}`, so that the URL is portable without my thinking about it.
15. As a test author, I want the recorder to keep treating **password fields as secrets**
    (`{{secret:…}}`), so that credentials never enter the recording.
16. As a test author, when I type a value the system **can't classify**, I want a **one-tap "Variable or
    Static?" prompt** with a sensible default, so that environment-specific data becomes a variable and UI
    constants stay literal.
17. As a test author, I want a **data-shaped value** (a dataset name, GUID, date, long id, free text) to
    **default to Variable**, and a **short/enumerable** value to default to Static, so that the prompt is
    usually right and I just confirm.
18. As a test author, I want the test to carry a **declared list of its variables** (name + kind:
    url / data / secret), so that the environment editor and the resolver both know what the test needs.
19. As a test author, I want a warning (a **selector guard**) when a chosen locator depends on
    **environment-specific visible text**, with the option to bind it to the variable or drop to a
    structural locator, so that my selectors don't silently break across environments.
20. As a reviewer, I want **any signed-in member to manage environments and secrets** (flat authz, no
    roles), consistent with the MVP authz model, so that the team isn't blocked on permissions.
21. As an operator, I want **secrets resolved only transiently inside the worker** and **scrubbed from
    runs, results, logs, and artifacts**, so that nothing sensitive is persisted.
22. As a reviewer, I want the run/needs-review/diff views to **show which environment** a run executed
    against, so that I know what I'm approving (this already exists; it must stay correct per-env).
23. As a reviewer, I want a test with **no variables** to still run with no environment chosen (as today),
    so that simple same-origin tests aren't burdened by environment setup.

## Implementation Decisions

### A. Already built — do NOT rebuild (verify, then extend)
- **`environments` table**: `id, name, values jsonb, secrets jsonb, createdAt`.
- **`EnvironmentsService.create({name, values?, secrets?})` → `{id}`** and **`getById(id)` →
  `{id, name, values, secretNames[]}`** (secret values are deliberately **never** returned — only names).
- **`POST /environments`** and **`GET /environments/:id`** controllers.
- **`POST /runs` accepts `{testId, environmentId?}`** and `RunsService.create` stores it.
- **Worker resolution**: when a run has an `environmentId`, the runner loads the environment, builds an
  `EnvironmentProfile {values, secrets}`, calls `resolveDefinition(recorded, profile)`, and sets the
  run's environment **name**; with no environment it leaves tokens unresolved and uses the name
  `"default"`.
- **`@varys/variable-resolver`**: `resolveString` substitutes `{{name}}` from `values` and
  `{{secret:name}}` from `secrets` and **throws on any unresolved token**; `resolveDefinition` resolves
  `navigate.url` and `type.value`.
- **Failed-run legibility** (added this session): a replay error is persisted to `runs.error` and shown
  in the viewer — so an unresolved-token failure already surfaces a readable message.

### B. Environment management API (new)
- **List endpoint** `GET /environments` → array of `{id, name, secretNames[]}` (and `values` is fine to
  include; secrets remain names-only). Add a `list()` to `EnvironmentsService`.
- **Update** `PUT /environments/:id` (or `PATCH`) → set `name`, **merge/replace `values`**, and apply a
  **secret delta**: set named secrets to new values, and **clear** named secrets explicitly; never echo
  secret values back. Decision: the update body carries `values` (full map replace is acceptable for
  MVP) and `secrets` (a map of name→value to set; a separate `removeSecrets: string[]` to clear).
- **Delete** `DELETE /environments/:id`. Decision for MVP: allow delete even if runs reference the
  environment (runs store `environmentId` nullable and resolve the **name** for display; a dangling id
  degrades gracefully to the `"default"` display name). Revisit if it proves confusing.
- Secrets stay **plaintext in `jsonb`** (local/single-tenant accepted risk, DESIGN §11 / §7); the
  guarantee is **API never returns them** and the **worker never persists** resolved values. At-rest
  encryption (envelope/KMS) is explicitly deferred.

### C. Run targeting (API done; web new)
- `POST /runs {testId, environmentId}` is already wired. Add a **web environment picker** to the Run
  action (Tests view) and thread `environmentId` through `runTest`/`useRunTest`.
- **Requirement rule:** if the test **declares variables** (see §E) or its definition contains unresolved
  `{{tokens}}`, the Run UI should **require an environment** (disable Run until one is chosen, or default
  to the most-recently-used). A test with no variables may run with no environment (today's behavior).

### D. Per-environment baselines + the approve fix (correctness core)
- Baselines are keyed by **`(testId, checkpointName, environment, viewportKey)`** where `environment` is
  the **run's environment name**. This is already how the **runner** looks up baselines for diffing.
- **Bug to fix:** `RunsService.approve` / `approveAll` currently seed/replace baselines under a hardcoded
  `environment: "default"` constant, regardless of the run's actual environment. **Thread the run's
  environment name through approve** (derive it from the run's `environmentId` → environment name, same
  resolution `getById` already does) so a seed/replace lands under the environment the run executed
  against. Without this, per-env baselines silently never match and every run re-seeds.
- Per-env baselines **seed independently**: running the same test against `dev` then `demo` produces two
  separate pending baselines; approving each is independent; re-running `dev` compares against the `dev`
  baseline only. (Single environment per run in this slice; **multi-env fan-out in one run is Slice 6.**)
- `persistMasks` (Slice 3) re-judges a run_result and writes a new `test_version`; it does **not** touch
  baselines, so it is environment-agnostic and unaffected — but verify its re-judge still reads the run's
  environment where relevant.

### E. Variable declaration in the step schema (new)
- Add **`variables: Variable[]`** to the test definition, where **`Variable { name; kind: 'url' | 'data'
  | 'secret' }`** (exactly DESIGN §3). `variables` is **optional** for back-compat (old definitions have
  none). The screenshot/step shapes are unchanged.
- **Resolution validation:** a run against an environment should fail **legibly** (via the existing
  `runs.error` surface) when a used token has no declared variable or no value/secret in the chosen
  environment — i.e. surface `"unresolved variable: X"` rather than a raw Playwright error. The resolver
  already throws on unresolved tokens; ensure the message is clear and that it's the error persisted.
- The declared `variables` list is what the **environment editor** can show as "this test needs:" and
  what lets the UI enforce the §C requirement rule.

### F. Recorder variable UX (recorder package + extension; the authoring half)
Governing principle (DESIGN §2): **structure is static, data is variable, ask only about the ambiguous
middle.**
- **Auto (unchanged):** navigation origin → `{{baseUrl}}` (declared `kind: 'url'`); `type=password`
  inputs → `{{secret:<id|name|"password">}}` (declared `kind: 'secret'`).
- **Ambiguous middle:** for a typed value that isn't clearly static, the recorder prompts an **inline
  one-tap "Variable / Static"** choice with a **heuristic default**:
  - **data-shaped** (entity/dataset name, GUID, date, long id, free text) → default **Variable** →
    emitted as `{{<name>}}` and declared `kind: 'data'`;
  - **short / enumerable** UI value → default **Static** → emitted as the literal.
  - Decision: the **classification heuristic is a pure function** (`classifyTypedValue(value) →
    'variable' | 'static'`) living in the recorder (or variable-resolver) package, so it's unit-testable;
    the **confirm gesture itself is extension UI** (manual-verified, like the rest of the overlay).
- **Selector guard:** if a chosen locator depends on **environment-specific visible text**, warn and
  offer to **bind it to the variable** or **drop to a structural locator**. Decision: implement the
  *detection* as a pure predicate over a fingerprint (does it lean on `text`/`accessibleName` that match a
  variable value?) — testable — with the UI affordance as extension UI.
- Recorded variables **accumulate on the definition's `variables` list**; each `{{token}}` used is
  declared once.

### G. Environment values UX (web; manual-verified)
- The environment editor maps **declared variable names → values** and **secret names → write-only
  inputs**. Decision for MVP: a **free-form key/value editor** for `values` plus an **add/clear secret**
  control for `secrets` (matches the `jsonb` shape), with the test's **declared variables surfaced as
  hints** ("tests reference: baseUrl, dataset") when available. Full declared-variable-driven forms can
  come later; free-form is enough to unblock real use.
- Per user direction for this work stream: **no MSW/component UI tests**; the management UI and run picker
  are **manual-verified**.

### H. customer = environment (DESIGN §5)
- Environments **are** the customer deployments (dev / demo / lnrs / cfg / carvana). Names are free-form.
  No separate "customer" concept. This slice does not add folders/tags/suites (Slice 5) or fan-out
  (Slice 6).

## Testing Decisions

A good test here asserts **external behavior** — HTTP responses, replay/seed/diff outcomes, the **emitted
definition**, and the **resolver's** input→output — never internal wiring. Use the **highest existing
seam**.

- **Primary seam — API full-thread E2E** (`apps/api/test/*.e2e.spec.ts`: testcontainers Postgres +
  `@varys/fixture-app` + local-FS storage + **real headless-chromium replay**, the exact harness used by
  `runs.e2e.spec.ts` / `baseline.e2e.spec.ts`). Cover:
  - create an environment via `POST /environments` with `values.baseUrl = <fixture url>` and a secret;
    `GET /environments` lists it and **never returns the secret value** (names only);
  - a recording whose `navigate.url` is `{{baseUrl}}/…` **resolves and seeds** when run against that
    environment (this is the exact path that fails today with no environment);
  - **per-env baselines are independent**: seed+approve against env A, then run against env B → B seeds
    its **own** pending baseline (doesn't match A); re-running A matches A's baseline (**passed**);
  - **the approve fix**: after approving against env A, a re-run **against env A** is `passed` (proves the
    baseline was seeded under A, not `"default"`);
  - **unresolved token** (env missing a value the test uses) → run is `failed` with a **legible
    `error`** naming the variable (reuses the failed-run surface).
- **`@varys/variable-resolver` unit tests:** substitution, `{{secret:…}}` vs `{{name}}`, **throws on
  unresolved**, and the **classification heuristic** + **selector-guard predicate** (pure functions).
- **`@varys/step-schema` unit tests:** `variables` parses and is optional (back-compat); a definition
  using an undeclared token is flagged (if validation is added at the schema level).
- **`@varys/recorder` unit tests** (playwright-injected, as in `recorder/src/index.spec.ts`): the emitted
  definition carries declared `variables`; origin → `{{baseUrl}}`; password → `{{secret:…}}`; an
  ambiguous data-shaped value becomes a `{{var}}` with `kind: 'data'`.
- **Web:** **no UI/MSW tests** (per direction) — env management UI + run picker are manual-verified.

## Out of Scope

- **Multi-environment fan-out in a single run** (suite × many envs, aggregated report) — **Slice 6**
  (suite runs + parallelism). This slice is **one environment per run**, but selectable, with per-env
  baselines.
- **Folders / tags / suites** — Slice 5.
- **Scheduling / CI / webhook triggers** — Slice 8 / 12 (runs stay manual via the Run button).
- **RBAC / role-gating** — flat authz (DESIGN §11): any signed-in member manages environments + secrets.
- **At-rest secret encryption** (envelope/KMS vault) — deferred; secrets are plaintext `jsonb`
  (local/single-tenant accepted risk). The kept guarantees are *never returned by the API* and *never
  persisted from the worker*.
- **OIDC/SSO login-replay correctness** — replaying a captured Keycloak/OAuth auth URL fails because of
  one-time PKCE/state/nonce params; that's a **recorder** concern (suppressing auto-redirect navigates),
  not environment resolution. Note it; don't solve it here.

## Further Notes

### What this unblocks
This is the slice that fixes the failure observed this session: a recording of the real DataGenie app
hit **`navigating to "{{baseUrl}}/"`** because the Run created a run with **no environment**, so the
worker skipped resolution. With an environment carrying `baseUrl` (+ the login secret) and a Run picker
to attach it, that recording resolves and seeds.

### Context for a fresh session (read these first)
- `DESIGN.md` — the durable decision record; §2/§3/§4/§5/§7/§11 are the relevant ones here.
- `README.md` — how to run the stack. **Restart `pnpm dev` after schema changes** — the API applies DDL
  (incl. `ALTER … ADD COLUMN IF NOT EXISTS`) on boot.
- `CLAUDE.md` — project rules. **Hard rule: no `Co-Authored-By: Claude` trailer on commits.**
- Prior PRDs/issues: `prd|issues/mvp.md`, `…/visual-review-ui.md`, `…/multi-checkpoint-capture-modes.md`.

### Non-obvious gotchas (these will bite a fresh agent)
- **Non-standard ports** (a co-located app + local Postgres force them): API **:4000**, web **:5200**,
  Postgres **:5433**. Don't move them back to defaults.
- **NestJS DI under `tsx`/esbuild needs explicit `@Inject(XService)`** on every controller — esbuild emits
  no decorator metadata, so type-based injection is `undefined` at runtime (tests pass via swc regardless,
  so green tests don't prove the dev server boots).
- **Don't edit source while a Docker-backed vitest runs** (mid-run transpile → bogus failures). Run API
  E2Es **per file** — they flake under whole-suite contention; a lone red that passes alone is a flake.
- **Same-origin web model:** `API_BASE = ""`; deep link is `?run=<id>`; artifact URLs are relative.
- **Per-user testing preference:** don't run tests unless asked; skip UI/MSW tests; add an API E2E only
  where there's real server behavior; implement issue-by-issue.

### Suggested decomposition (run `/to-issues` on this PRD)
Tracer-bullet order — each a thin vertical cut, demoable on its own:
1. **Environment list + management UI + run picker** — `GET /environments`, update/delete, the management
   screen, and the Run-with-environment picker. Unblocks a real run end-to-end. *(thin vertical)*
2. **Per-environment baselines + the approve-env fix** — thread the run's environment through
   approve/approveAll; prove independent per-env baselines via API E2E. *(correctness core; can precede 1
   since it's pure backend)*
3. **Variable declaration + resolution validation** — `variables` on the step schema; legible
   unresolved-token errors. *(blocks 4)*
4. **Recorder variable UX** — inline Variable/Static confirm (with the testable classification heuristic)
   and the selector guard. *(authoring half; depends on 3)*
