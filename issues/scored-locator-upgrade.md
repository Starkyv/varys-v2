# Issues — Varys v2 Slice 13: Scored-Locator Upgrade

> Replace the ranked **first-tier-wins** matcher with a richer captured fingerprint and a
> **confidence-scored** resolver that fuses the whole signal bundle — *without re-recording* existing
> tests. Slice 13 of `DESIGN.md` (table row 13): *"Replace ranked matcher with confidence scoring (no
> re-record). Depends on 1."*
>
> **Why now:** real runs hard-fail with `could not locate checkpoint … no fingerprint signal matched`
> on DataGenie's briefings area (runs `7982924c…`, `b52e68d6…`) — container/card targets with no
> testId/id/role, only **build-hashed CSS-module classes** + **volatile text**. The current matcher has
> no structural fallback, over-trusts hashed classes, can't disambiguate repeated controls, and records
> the literal clicked node. A prior project solved most of this; its design is captured in
> `prd/selectors.md` (the reference) — this slice ports its hard-won tricks *and* goes past it using
> signals it never had (multi-signal bundle + bounding box).
>
> **Source of truth:** `DESIGN.md` §2 (locator engine — multi-signal fingerprint, self-heal, confidence
> scoring) · `prd/selectors.md` (reference implementation: semantic ladder, `getRowScope`/`within`,
> structural CSS path, accessible-name ladder, id-volatility rejection).
> *(No issue tracker configured — this file is the source of truth; no PRD by request.)*
>
> **Combinable?** Yes — split only at the capture↔resolve seam (Issue 1 captures signals, Issue 2
> consumes them). Issue 1 is additive/back-compat and ships independently; Issue 2 is the matcher
> rewrite and depends on it.
>
> | Issue | Status |
> |---|---|
> | 1 — Richer, durable fingerprint capture | ✅ Done |
> | 2 — Confidence-scored locator resolution | ⬜ Not started |
>
> **Dependency:** `1 → 2`.

---

# Issue 1 — Richer, durable fingerprint capture

**Type:** AFK · **Status: ✅ Done**

## What to build

Capture the signals a robust matcher needs, so existing recordings gain durability the moment the
resolver (Issue 2) ships — all **additive and backward-compatible** (old definitions still parse and
replay). Today `captureFingerprint` throws away or never gathers the things that matter; this issue
fixes the *capture* half of every gap. Specifically:

- **Anchorable ancestors.** Each captured ancestor carries its `id`/`data-testid` (not just `tag`/`role`),
  so the resolver can anchor a structural path at the nearest *stable* ancestor instead of climbing to
  `<body>`.
- **Row scope (the highest-value addition).** When a target sits inside a repeated container, capture a
  scope: the nearest `li` / `tr` / `[role=row|listitem]` / `article` ancestor plus a **short, unique
  distinguishing line of its visible text** (verified to appear in exactly one such container). This is
  the `within` concept from `prd/selectors.md` — *"the button inside the row that says Checkout flow."*
  Populate the already-reserved `neighborText`/scope field (it's currently always `undefined`).
- **Stable vs build-hashed classes.** Split classes: drop CSS-module hashes (`name__x___y`),
  purely-numeric, and utility-class soup (cap ~2); keep only durable classes as a corroborating signal.
  Stop storing every class as if it were stable identity.
- **Real accessible name + provenance.** Compute the name via a ladder (`aria-label` →
  `aria-labelledby` resolved → `title` → child `aria-label` → `svg<title>` → `img[alt]` → **first
  non-empty line** of `innerText`), and record a `nameFromAttr` flag (attr-derived = durable;
  text-derived = suspect). The name must never be the multi-line text dump it is today.
- **Climb to the semantic control — for clicks only.** A click on an inner `svg`/`span`/`icon` should
  capture the nearest actionable ancestor (`button, a, [role=button|link|option|menuitem|tab], input,
  label`). A **screenshot** target must NOT climb (you want the exact framed box). (Today only `svg`
  climbs.)
- **Reject volatile ids.** Don't record generated ids (`tippy-\d+`, React `useId` `:rN:`,
  numeric-suffix patterns) as a usable id signal — they never match on rerun.

## Acceptance criteria

- [x] Captured `ancestors` carry `id`/`testId` where present (plus existing `tag`/`role`).
- [x] A target inside a repeated container captures a row scope (`scope:{container,text}`): nearest `li`/`tr`/`[role=row|listitem]`/`article` + a distinguishing visible line verified unique among such containers.
- [x] Classes are split into stable vs build-hashed (`stableClasses` vs raw `moduleClasses`); triple-underscore/trailing-hash and purely-numeric and utility-soup (>3) are excluded from the stable subset.
- [x] `accessibleName` is computed by the ladder (aria-label → labelledby → title → child aria-label → svg title → img alt → first innerText line) with a `nameFromAttr` provenance flag, and is never a multi-line text dump.
- [x] A click capture climbs to the nearest actionable ancestor (`captureFingerprint(el,{climb:true})`); a screenshot capture keeps the framed element (no climb).
- [x] Generated ids (`tippy-N`, React `:rN:` / non-letter-leading) are not recorded as a usable id signal.
- [x] All additions are optional/back-compat: existing recorded definitions still parse and replay; the current resolver ignores the new fields (no regression — `accessibleName` is identical for short-named elements).
- [x] Unit tests: `@varys/capture` behavioral tests cover each new signal (ancestor ids, class split, name ladder + provenance, id rejection, climb vs no-climb, row scope), exercised through the public capture function (real Chromium `setContent`). Prior art: `packages/recorder/src/index.spec.ts`, `packages/step-schema/src/index.spec.ts`.

## Implementation note

`captureFingerprint` is eval'd standalone in the page (its `.toString()` is injected by both the capture and recorder specs), so the new logic is **inlined** to keep it self-contained rather than extracted into referenced helpers; it's covered behaviorally through the capture spec. **Immediate effect for new recordings:** click targets now climb to the real control, generated ids are dropped, and names are short/provenanced. The structural-fallback and row-scope **payoff lands with Issue 2** — the current ranked resolver ignores `scope`/`stableClasses`/`nameFromAttr`/ancestor-ids until then.

## Blocked by

None — DESIGN slice 1 (the fingerprint + capture) is already in place; this enriches it.

---

# Issue 2 — Confidence-scored locator resolution

**Type:** AFK

## What to build

Replace the ranked first-tier-wins matcher with a resolver that **fuses the whole bundle** and the new
signals from Issue 1, fixing the *resolve* half of every gap and adding the optimization the stored
bundle was designed for (DESIGN §2: *"confidence-scored matching later, without re-recording"*).

- **Score, don't short-circuit.** Generate candidate elements from every available signal — `testId`,
  `id` (CSS-escaped), `role`+name, **row-scoped** `role`/text (`within` → `.filter({ hasText })`),
  **structural path** (ancestor-id-anchored + `:nth-of-type` from `domIndex`), exact short `text`,
  `[aria-label]`/`[name]`/`[placeholder]` — then **score each resulting element** by cross-signal
  agreement: role, accessible-name (weight attr-name ≫ text-name via `nameFromAttr`), row/neighbor text,
  tag, ancestor-chain similarity, and **bounding-box overlap/aspect** (a corroboration signal the
  reference implementation never had — especially decisive for screenshot containers).
- **Structural fallback.** A container/screenshot target with no testId/id/role and only hashed classes +
  long text — the briefings-card case — resolves via the structural path. **No more `no fingerprint
  signal matched` for DOM-shape-stable targets.**
- **Demote hashed classes.** Build-hashed module classes contribute only a small corroborating weight;
  they are never a decisive match on their own.
- **Screenshot vs click resolution.** Element-screenshot targets resolve by structure + bounding box, not
  by requiring a semantic name; click targets keep preferring the semantic identity.
- **Keep Varys's safer discipline.** Return the highest **uniquely** scoring element; flag `healed` when a
  non-primary signal won; below a confidence floor, **hard-fail and surface for repair** — never silently
  act on `.first()` (the one place the reference implementation is riskier than Varys).

## Acceptance criteria

- [ ] Resolution scores candidates across signals and returns the highest unique match; `healed` is flagged when a non-primary signal decided it.
- [ ] A container/screenshot target with no testId/id/role and only hashed classes + long text resolves via the structural path (reproduces and fixes runs `7982924c…` / `b52e68d6…`).
- [ ] A control duplicated across rows (same `role`+name) resolves to the correct one via its captured row scope.
- [ ] Build-hashed CSS-module classes are only a corroborating weight, never a sole/decisive match.
- [ ] Element-screenshot targets resolve by structure + bounding-box corroboration, without needing a semantic name.
- [ ] A genuinely ambiguous target (no signal yields a unique above-floor winner) **hard-fails** and is surfaced for repair — it is never silently resolved to the wrong element; ids are `CSS.escape`d.
- [ ] `@varys/locator-engine` unit tests cover the scorer (structural fallback, row-scope, hashed-class demotion, box corroboration, ambiguity → fail); an API full-thread E2E proves a previously-unmatchable container target now seeds/diffs and a repeated-control target hits the right element. Prior art: `apps/api/test/runs.e2e.spec.ts`, `baseline.e2e.spec.ts`.

## Blocked by

- Issue 1 — Richer, durable fingerprint capture *(the scorer fuses the signals it adds)*.
