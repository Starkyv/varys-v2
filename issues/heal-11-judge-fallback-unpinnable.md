# Slice 11 — Judge fallback for unpinnable assertions

**Type:** AFK · **Label:** `in-review` · **Blocked by:** 09

## Parent

[`prd/self-healing-repair-queue.md`](../prd/self-healing-repair-queue.md) (Slice 19).

## What to build

Not every check reduces to two extractions and a relation. "The chart looks reasonable" cannot be
pinned, and the honest answer is to judge it rather than to pretend.

An assertion with no pinned form falls back to the existing `JudgeProvider`. That seam is already
built, already swappable, and already maps a thrown transport error to needs-review rather than a
silent pass — which is precisely the behaviour required here.

The author-facing half matters as much as the mechanism: an author must be able to tell **which
of their assertions are exact and which are approximate**, and must be told when an assertion
cannot be pinned at all, so they can rephrase it rather than discovering months later that it was
never really being checked.

Note the deliberate boundary. A judge reading `$1,203,441` off an image and summing a 40-row
column is exactly where a model hallucinates — so the fallback exists for *qualitative* checks,
and the vocabulary exists for *quantitative* ones. Do not let the fallback become the default
path for numeric comparisons.

## Acceptance criteria

- [x] An assertion with no pinned form is evaluated by the existing judge provider
- [x] A judge transport error marks the run needs-review — never a pass
- [x] The test editor shows, per assertion, whether it is pinned (exact) or judged (approximate)
- [x] An assertion that cannot be pinned tells the author so, with enough detail to rephrase it
- [x] A judged assertion's verdict and reasoning appear on run detail beside its check text
- [x] Judged and pinned assertions on the same test both run, and either can fail the run
- [x] Unit tests use the fake judge provider, including its throw path

## Blocked by

- Slice 09 (assertions must exist and be evaluated before a fallback has meaning)


## What was built

**The mechanism.** `@varys/assertion-engine` gains a second evaluation path beside `evaluatePinned`:
`evaluateJudged` turns a judge's answer — or the absence of one — into an `AssertionEvaluation`.
The engine stays pure and network-free, and stays free of `@varys/judge-engine` entirely: it takes a
structural `JudgedVerdict` (`{ok:true, verdict, reasoning} | {ok:false, error}`), so every property
below is unit-testable with no browser and no transport. `packages/runner/src/assertions.ts` does the
calling; `@varys/judge-engine` gains `judgeAssertion` + `ASSERTION_JUDGE_SYSTEM` on the same seam the
`context` checkpoint and the justification gate already ride.

**Three new pieces of vocabulary, and the reason each is its own thing.**

- `AssertionMode` = `pinned | judged`. Exact against approximate, recorded per RUN rather than read
  off today's definition — an assertion that gets pinned next week must not retroactively claim its
  old approximate verdicts were exact.
- `judge-failed` — the model read the page and said no. It is the APP's, approximately, so it fails
  the run and is never repairable, for the same reason `relation-false` never is (re-pinning until a
  model agrees hides the same class of bug). It earns a read-only Triage Job.
- `judge-unavailable` — no verdict was reached at all. **Neither a pass nor a failure**, which is the
  property the whole slice turns on. The run goes `needs_review`, earns NO job of either kind, and
  claims nothing either way. `anyAssertionFailed` excludes it explicitly; `assertionFailureVerdict`
  gives it its own bucket so "which assertions earn nothing" has one definition, which the runner
  reads rather than deriving a second time.

**The author-facing half**, which the ticket weights as heavily as the mechanism. Every assertion —
in the test editor and beside every verdict on run detail, including the passing ones — carries an
**Exact** or **Approximate** badge (`MODE_META` in `components/PinnedAssertion`, the one place both
surfaces read from). An approximate one also carries `PINNABLE_CHECK_HELP`, generated FROM the
vocabulary schemas rather than written beside the editor, so it names the coercions and relations
that actually exist and cannot fall behind the day one is added. That is the "enough detail to
rephrase it" criterion: the badge is a route to a fix rather than a shrug.

**The boundary the ticket draws** — a judge reading `$1,203,441` off an image and summing a 40-row
column is exactly where a model hallucinates — lives in `ASSERTION_JUDGE_SYSTEM` and, deliberately,
in `ASSERTION_JUDGE_TOOL_SCHEMA`'s enum descriptions too, so a model that reads only the forced-tool
definition still declines. Asked to do arithmetic, the rubric FAILS and says the check should be
pinned instead.

## Flags raised

- **The quantitative boundary is enforced by rubric wording, not structurally.** Nothing stops an
  author from writing "the total equals the sum of the column" with no pinned form and having it
  judged imperfectly rather than refused at declare-time. The rubric tells the judge to fail such a
  check and say it needs pinning, and the tool schema repeats it — but a model that ignores both
  produces a confident wrong answer. A structural guard (detect a quantitative-sounding check at
  authoring time and refuse it) is slice 12's territory, where Claude is doing the pinning and has
  the page in front of it. Worth confirming that is the intended division.

- **The judged screenshot is FULL PAGE, and that was my call.** Neither the ticket nor the PRD says
  which. A claim like "the chart looks reasonable" is about the page, and answering it against only
  what is above the fold would be wrong in the direction that looks right — so full page. The cost
  is a larger image per judged assertion on a long page. One capture is taken per RUN and shared by
  every judged assertion (they are all asking about the same final state), and a fully-pinned test
  takes no capture and makes no model call at all — there is an E2E asserting exactly that.

- **`run_assertions` gains `mode` (NOT NULL DEFAULT 'pinned') and `reasoning`.** Rows written before
  this slice read as `pinned`, which is what they were: the fallback did not exist. No backfill.

- **Precedence: a real failure outranks an unreachable judge on the same run.** A run carrying both a
  judged fail and an unavailable judge on another assertion is `failed`, not `needs_review`. The
  reverse would let one flaky judge call downgrade a genuine red to amber. Unit-tested.

- **The web surface is unverified by hand**, per house practice (no UI tests, and this session did
  not drive the SPA). Someone frontend-literate should confirm two badges on one row (`Approximate`
  + `Judged false`) reads as intended rather than as clutter, and that the `pinningHelp` paragraph
  under an unpinned assertion in the editor is welcome rather than a wall of text.

- **Outcome→behaviour mapping now spans five places** (`assertionRepairability`,
  `summarizeAssertionFailures`, `OUTCOME_META`, `consequenceOf`, and the AssertionsCard SCSS), all of
  which had to change together for this slice and will again for the next outcome. Raised by review
  as a Repeated Switches / Shotgun Surgery smell. Not acted on: the spread follows the package
  boundaries (pure engine → contract → React → CSS) and collapsing it would mean the engine owning
  presentation. Flagging so a reviewer can disagree.

## Promotion candidates

None. `MODE_META` joins `OUTCOME_META` and `consequenceOf` in `components/PinnedAssertion` — two
callers and purely presentational, but its vocabulary is assertion vocabulary, so it is this
feature's component and must not go to `@varys/ui`. Slice 09 placed that file correctly.
