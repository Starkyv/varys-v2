# Slice 12 — Claude pins assertions during authoring

**Type:** HITL · **Label:** `in-review` (two human-review criteria outstanding) · **Blocked by:** 09

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

- [x] An author can write an assertion in plain language during an Authoring Session
- [x] Claude produces a pinned form using only the fixed vocabulary — never free-form code
- [x] A pin whose targets Claude captured from the live page carries full multi-signal fingerprints, not hand-written selectors
- [x] Claude verifies the pin evaluates against the live page before it is stored
- [x] A check the vocabulary cannot express is reported as unpinnable rather than forced into a poor fit
- [x] The author sees the proposed pin — which elements, which coercions, which relation — before accepting
- [ ] Authoring instruction wording reviewed by a human before shipping
- [ ] Pins produced for a handful of real checks reviewed by a human for correctness, not just validity

The last two are **human-review gates, and an agent cannot tick them.** The wording is written and
the mechanism is built and tested; what remains is a person reading the instructions and looking at
pins produced for real checks on a real app. That is the work this ticket's HITL label names, and it
is why the ticket stays `in-review` rather than moving further. See *What a human still has to do*.

## Blocked by

- Slice 09 (the vocabulary and its evaluation must exist to pin into)


## What was built

**Three MCP tools**, human-only (an agent that could DECLARE a check could answer a red run by
writing an assertion that passes — it edits assertions only through `edit_test`, which refuses any
id the test does not already declare):

- `find_elements` — the perception gap this slice had to close first. `observe` refs what you can
  *act* on; the things an assertion reads (a total in a `<span>`, a figure in a `<td>`, a count in a
  badge) never appear there, so without this the pinning tool could not reach its own subject
  matter. Takes a CSS selector, stamps refs, and reports each element's **text** — because pointing
  at a right-looking wrong node is the first way a pin goes silently wrong, and the text is how a
  model catches it. The selector is how the node is found *once*; what gets stored is the
  fingerprint captured from the ref.
- `pin_assertion` — the headline. Three guarantees, enforced in this order because each only means
  something if the one before it held: (1) the proposal is Zod-parsed against the fixed vocabulary
  before anything else happens, so nothing model-authored can reach a definition; (2) each side is
  captured off a live `ref` through the same `captureFp` a click uses, so the pin carries every
  signal the replay matcher scores; (3) the pin is **evaluated against the page it was authored
  against**, using the runner's own `extractSide` — so "this pin works" is demonstrated, not assumed.
- `declare_unpinnable_assertion` — the honest exit, and it has to be as easy to reach as pinning or
  it will not be taken. Records the check with a **reason**, which is stored on the definition and
  shown in the editor.

**The two failure modes are deliberately not alike**, and this is the heart of the slice.
`extraction-failed` means the pin is BROKEN — refused, nothing stored, because storing it would
author a check that has never once evaluated. `relation-false` means the pin WORKS and the page
disagrees with the author's claim — stored as written, and reported loudly with an instruction not
to reword the check. Refusing that one instead would train an author (or a model) to soften a check
until the app agrees with it, which is precisely the bug assertions exist to catch. It is the same
rule as "a false relation is never repairable", one moment earlier.

**Supporting changes.** `Recording` gains `assert()` / `assertions()` and carries them onto the
definition (omitted when empty, so every human DOM recording is byte-identical to before);
re-declaring an id REPLACES it, so a session correcting its own pin does not emit a duplicate the
schema would reject and lose the whole session with. `Assertion` gains `unpinnableReason`, which
slice 11 deliberately deferred here — the schema refuses an assertion that is both pinned and
unpinnable, since that is two contradictory claims in one record. `finish_session` reports
`assertionCount` split into pinned vs judged, and a draft that declares an assertion no longer
carries the "asserts nothing" warning.

## Flags raised

- **Two acceptance criteria are unmet by construction** — both are human-review gates. The
  instruction wording is written (`authoring-instructions.md` §Assertions, ~50 lines, and a
  condensed paragraph in `DEFAULT_AUTHORING_INSTRUCTIONS`); nobody has read it but me.

- **The seed prompt change does not reach an existing deployment.** `DEFAULT_AUTHORING_INSTRUCTIONS`
  is the *seed* for a DB-backed base prompt (`app_settings.authoring_instructions_base`). Any
  deployment that has ever saved the base prompt from the Author page keeps its saved copy, so the
  new Assertions guidance will NOT appear until someone resets it or pastes the section in. Worth
  deciding whether that needs a migration — I did not write one, because silently overwriting a
  prompt a team has edited is worse than the gap.

- **`right ?? { literal: "" }` for a unary relation, and why not a mirror of `left`.** The schema
  requires a `right`; `non-empty` has none. I first mirrored `left` there and both reviewers flagged
  it as opaque — but it is worse than opaque: `pinnedSideTarget(…, "right")` would then hand slice
  10's repair path a fingerprint for a side that does not exist, and a repair could "re-pin" it. An
  inert empty literal is what slice 09's own pinned forms use. Now covered by an E2E.

- **No propose → confirm round trip.** AC 6 is met in the sense that `pin_assertion` returns the pin
  in words (`proposed`, plus the live verdict) for Claude to report, and the full pinned form is
  visible in the editor before a human promotes the draft — promotion being the accept gate. But the
  pin is written to the recording *before* that description is returned; there is no two-step
  propose-then-accept. This matches how `checkpoint` already works, so I followed the existing
  pattern rather than inventing a second one. Flagging in case the criterion meant something
  stronger.

- **`authoring-session.service.ts` is now ~2800 lines** and this slice added ~350 of them. Raised by
  review as a Divergent Change smell: the file already changes for locator edits, checkpoints,
  repair sessions and now assertions. The new code is cohesive and would extract cleanly into an
  `AssertionAuthoring` collaborator. Not done here — a 350-line extract-class buried in a feature
  diff hides the boundary change from the person meant to approve it.

- **One out-of-slice fix, deliberately included.** `authoring-repair.e2e.spec.ts` asserted the
  `checkpoint`-in-a-repair-session refusal still said "records nothing"; that wording was reworded in
  heal-04 and the expectation was never updated, so the test has been red for three slices (heal-10
  flagged it and left it). Source message is right, test was stale — one line, now green.

- **`find_elements` is withheld from Repair Agents**, though it is read-only perception and a drainer
  diagnosing a failed extraction has a real use for it. Withheld because no criterion here asked to
  widen an agent's capability surface, and that should be a deliberate decision rather than a side
  effect. Easy to reverse: add it to `AGENT_TOOLS`.

- **The web surface is unverified by hand**, per house practice. The addition is one sentence
  (`unpinnableReason`) under an approximate assertion in the test editor, beneath slice 11's mode
  blurb and above its vocabulary help — three stacked paragraphs now. Someone frontend-literate
  should confirm that reads as helpful rather than as a wall of text.

## What a human still has to do

1. **Read the instruction wording** — `authoring-instructions.md` §"Assertions — checks a screenshot
   cannot make", and the assertions bullet in `DEFAULT_AUTHORING_INSTRUCTIONS`.
2. **Sanity-check real pins.** Point Claude at a real app, ask for a handful of checks in plain
   language, and look at what it pins — not whether the pins are *valid* (the vocabulary and the
   live evaluation already guarantee that) but whether they are *right*: that it picked the elements
   a human would have picked, chose the coercion that means what the check says, and reached for
   `declare_unpinnable_assertion` when it should have rather than forcing a near-miss. That last
   behaviour is the one prompt wording most easily fails to produce, and no automated test can
   observe it.

## Promotion candidates

None. Everything added is either engine vocabulary (`@varys/assertion-engine`), recorder core
(`@varys/recorder`), or API-layer session code. The one web change is a paragraph inside the
existing `AssertionsEditor`, which slice 09 already placed correctly.
