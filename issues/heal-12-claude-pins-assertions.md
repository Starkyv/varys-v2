# Slice 12 — Claude pins assertions during authoring

**Type:** HITL · **Label:** `needs-design` · **Blocked by:** 09

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

Close the authoring loop: an author writes an assertion in plain language, and Claude works out
**how** to evaluate it during the Authoring Session — picking the elements, choosing coercions,
choosing the relation — so every later run evaluates it for free.

This is the moment the design's core idea applies to assertions: Claude decides once, Varys
remembers the answer, and no model runs again unless the answer goes stale.

HITL because it is **prompt design against a fixed vocabulary**. The authoring instructions must
push Claude to pin wherever the vocabulary can express the check, and to say so plainly when it
cannot — rather than forcing a bad fit into `contains` and producing an assertion that passes for
the wrong reason. A pin that is subtly wrong is worse than an honest fallback to the judge,
because it looks exact.

Requires a human to review the instruction wording and to sanity-check the pins produced for a
handful of real checks before this ships.

## Acceptance criteria

- [ ] An author can write an assertion in plain language during an Authoring Session
- [ ] Claude produces a pinned form using only the fixed vocabulary — never free-form code
- [ ] A pin whose targets Claude captured from the live page carries full multi-signal fingerprints, not hand-written selectors
- [ ] Claude verifies the pin evaluates against the live page before it is stored
- [ ] A check the vocabulary cannot express is reported as unpinnable rather than forced into a poor fit
- [ ] The author sees the proposed pin — which elements, which coercions, which relation — before accepting
- [ ] Authoring instruction wording reviewed by a human before shipping
- [ ] Pins produced for a handful of real checks reviewed by a human for correctness, not just validity

## Blocked by

- Slice 09 (the vocabulary and its evaluation must exist to pin into)
