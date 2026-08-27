# Slice 09 — `@varys/assertion-engine` + assertions evaluated in a replay

**Type:** AFK · **Label:** `in-review` · **Status:** `in-review` · **Blocked by:** none

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

The capability Varys does not have today: a check on a *relationship*, not an image. Fully
independent of the repair queue — this branch can proceed in parallel with everything else.

A test declares named **Assertions** with a stable id and a plain-language `check`. A pinned
assertion is **data, never code** — which fingerprints to read, how to coerce each, and which
relation to apply, from a vocabulary Varys owns. Nothing model-authored executes in the worker.
Shape, carried over from the design interview:

```ts
Assertion { id; check: string; pinned?: PinnedAssertion }

PinnedAssertion = {
  kind: 'relation'
  left:  { target: Fingerprint; as: Coercion }
  right: { target: Fingerprint; as: Coercion } | { literal: string | number }
  relation: Relation
  tolerance?: number        // numeric relations only
}

Coercion = 'text' | 'number' | 'sum-number' | 'count' | 'exists'
Relation = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'non-empty'
```

The new package is pure and network-free, in the shape of `@varys/judge-engine`: it evaluates a
pinned form over **already-extracted values**. Extraction itself — resolving a fingerprint,
reading text off the page — stays in the runner. That split is what makes every coercion ×
relation pairing unit-testable with no browser.

In this slice the pinned form is **hand-written** in the test definition. Claude producing it
during authoring is slice 12.

The distinction that carries the whole safety story of assertions must be represented in the
result, not inferred: **extraction failed** (a target did not resolve — a locator problem) is a
different outcome from **relation false** (both values read, and they disagree — the app is
wrong). Slice 10 wires the consequence; this slice must produce the distinction.

## Acceptance criteria

- [x] A test can declare assertions with author-chosen stable ids
- [x] An assertion id survives an edit to its `check` text, preserving its history
- [x] An assertion can be deleted
- [x] A pinned assertion is evaluated on every run in the worker with **no model call**
- [x] Every coercion × relation pairing is covered by pure unit tests, including tolerance edges
- [x] A numeric comparison within tolerance passes; just outside it fails
- [x] A failing assertion fails the run
- [x] Each assertion's result is shown separately on run detail, with its own history over time
- [x] The result distinguishes **extraction failed** from **relation false** as separate outcomes
- [x] The pinned form is visible in the test editor — which elements it reads, what it compares
- [x] E2E: an assertion over a fixture page passes, then fails when the page's values are changed

## Blocked by

None - can start immediately. Independent of the repair queue.

## Flags raised

- **Extraction is a real part of the vocabulary, and it is asymmetric — worth a second pair of
  eyes.** The engine is pure and sees only values, so `packages/runner/src/assertions.ts` decides
  what each side reads, and the rule is not uniform: `text` / `number` go through the scored
  matcher (one identified element); `exists` uses the same matcher but treats "no match" as the
  ANSWER `false` rather than a failure; `count` / `sum-number` cannot use the matcher at all (it
  marks a single winner by design) and instead read the target's `selectorOverride ?? cssPath` as a
  SET, inside the fingerprint's frame. A `count` target with neither selector is an extraction
  failure whose message says what to add. That is documented at the top of the file, but it means a
  sum side is pinned to a plain CSS selector rather than to the multi-signal bundle — so it does not
  self-heal the way every other locator in Varys does. Slice 12 (Claude pins assertions) will be
  generating exactly these, and should probably not be allowed to pin a sum side to a
  build-hashed class.

- **`text` and `number` REFUSE a fingerprint that matched more than one element**, rather than
  reading the first. It is reported as `extraction-failed` / `coercion` ("3 elements matched — a
  text comparison needs exactly one"). Reading the first would be a wrong answer dressed as a right
  one, but note that the scored matcher already collapses ambiguity to "no match", so in practice
  this arm fires only for set-shaped extraction, i.e. never today.

- **An unparseable value is `extraction-failed`, not a third outcome — and slice 10 must read
  `cause`, not just `outcome`.** The slice asked for two outcomes, so a value that was READ but
  could not become a number ("n/a" as a `number`) lands in `extraction-failed` alongside a locator
  that missed. They are distinguished by `cause`: `unresolved` (a locator problem — the repairable
  one) vs `coercion` (a definition problem — re-pinning it would fix nothing). Slice 10 keying on
  `outcome === 'extraction-failed'` alone would hand a repair agent a job it cannot do. The column
  and the read-model both carry `cause` for exactly this reason.

- **A failing assertion sets `runs.error` and `status = 'failed'`, which outranks a pixel diff.**
  A run whose arithmetic is wrong has not verified, however its screenshots compare — so
  `needs_review` would be the wrong answer. Consequence to be aware of: `failure_kind` is
  `assertion` even when the same run ALSO has a red checkpoint, so that run's pixel regression gets
  no triage job of its own (the cluster is per test × class, and only one class is recorded). The
  assertion is the more specific finding, but the pixel diff is genuinely dropped from the queue.

- **Assertions are evaluated only when every step ran.** They execute after the loop, against the
  page the last step left behind; a run that threw mid-way records no assertion rows at all. That is
  deliberate (the run is already red, and the page is not in the state the assertions describe), but
  it means an assertion's history has GAPS on crash nights rather than a "couldn't be checked"
  point. The strip says "N of M runs passed" over the runs it has, which is honest but not the same
  as "it has been red for a week".

- **The run timeline shows every step passing on a run that reads `failed`.** No step failed — an
  assertion did — so `failed_step_index` is null and the timeline is all-green under a red badge,
  with the reason in `error` and in the assertions card above it. It is accurate, and it is the
  first time in Varys that a `failed` run has no failing step. Someone frontend-literate should
  decide whether the timeline should say so out loud.

- **The assertions card uses the `Check` glyph because `@varys/ui` has no better one.** A scale /
  balance glyph is what this wants. Adding an icon to the design system is a governance decision, so
  it was not done here.

- **History is capped at the most recent 30 verdicts per assertion**, un-paged and un-signposted:
  the strip renders what it is given, so a year-old assertion silently shows its last 30 runs rather
  than saying "30 of 412". Fine for a glance; wrong if this ever becomes the archive.

- **The web surface is unverified by hand.** Per house practice there are no UI tests and this
  session could not drive the SPA. Two judgement calls deserve a human eye: `extraction-failed` is
  rendered AMBER while `relation-false` is RED (nobody has established the app is wrong when Varys
  could not read a value, and giving them the same red would say they had), and the card is placed
  above the timeline because a failing assertion is *why* the run is red.

- **`test/review-ui.e2e.spec.ts` fails 5/5 on this branch — and fails identically at the commit
  before it** (verified by stashing this work and re-running). Pre-existing, not this slice.
  `test/repair-queue.e2e.spec.ts` and several others also fail intermittently on this machine with
  `beforeAll` errors (testcontainers under load); each one passes on re-run, including with these
  changes.

- **`/code-review` was not run**: this session is configured not to spawn subagents.

## Promotion candidates

- **`apps/web/src/components/PinnedAssertion/`** — already shared, and already at the right level.
  Two callers (run detail's assertions card and the test editor's assertions editor), purely
  presentational, no fetching, no feature state. But its vocabulary IS assertion vocabulary
  ("sum of every", "presence of", the relation glyphs), which by the promotion test makes it this
  feature's component rather than a design-system one. It lives in app-level `components/` because
  two features need it; it should NOT go to `@varys/ui`.
