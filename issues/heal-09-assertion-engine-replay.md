# Slice 09 — `@varys/assertion-engine` + assertions evaluated in a replay

**Type:** AFK · **Label:** `ready-for-agent` · **Blocked by:** none

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

- [ ] A test can declare assertions with author-chosen stable ids
- [ ] An assertion id survives an edit to its `check` text, preserving its history
- [ ] An assertion can be deleted
- [ ] A pinned assertion is evaluated on every run in the worker with **no model call**
- [ ] Every coercion × relation pairing is covered by pure unit tests, including tolerance edges
- [ ] A numeric comparison within tolerance passes; just outside it fails
- [ ] A failing assertion fails the run
- [ ] Each assertion's result is shown separately on run detail, with its own history over time
- [ ] The result distinguishes **extraction failed** from **relation false** as separate outcomes
- [ ] The pinned form is visible in the test editor — which elements it reads, what it compares
- [ ] E2E: an assertion over a fixture page passes, then fails when the page's values are changed

## Blocked by

None - can start immediately. Independent of the repair queue.
