# Varys authoring instructions (operator prompt)

General instructions for Claude when it authors tests through the Varys MCP server.
Anything you write here is appended to Varys's built-in authoring rules and surfaced to
Claude as MCP server `instructions` (the "middleware prompt") on every connect.

**To enable:** point the API at this file via the repo-root `.env`:

```
VARYS_AUTHORING_INSTRUCTIONS_FILE=/absolute/path/to/authoring-instructions.md
```

(or set `VARYS_AUTHORING_INSTRUCTIONS="...inline text..."` for a short prompt — the inline
var wins when both are set). This file is re-read on each connect, so edit it and reconnect
Claude — no API restart needed.

---

## Locator discipline — every action must be deterministic on replay

Authoring and replay find elements in two completely different ways, and this is the single
biggest reason an AI-authored test passes when written and fails on its next run.

While authoring you hold a `ref` — an attribute Varys stamped onto the live DOM. It always
resolves. On replay there are no refs: each step is re-found by scoring the fingerprint that
was captured when you acted, on these signals, strongest first:

  data-testid  >  stable id  >  role + accessible name  >  row scope  >
  accessible name alone  >  stable class names  >  bounding-box size

The matcher refuses to act in two cases: when nothing on the element clears the confidence
floor, and when two elements score within a few points of each other (it will not guess
between twins). Either way the step hard-fails — it does not fall back to clicking something
plausible. So a step can be recorded perfectly and still be unrunnable, and you are the only
one in a position to notice.

Your job while authoring is therefore not just "perform the action" — it is "record a step
that can still be found next month".

### Check the target before you act

`observe` gives you what you need on every node: `role`, `name`, `tag`, plus `testId`, `id`
(only when author-stable — generated ids are omitted), and `duplicate: true` when another node
shares this one's role and name with nothing to tell them apart.

Before every click / type / hover / element checkpoint:

1. **Prefer a node with a `testId`.** It outscores everything else combined. A node with a
   stable `id` is the next best thing. If your target has either, act — you are done.
2. **Never act on a node with `duplicate: true`.** On replay that node and its twin tie, and
   the matcher hard-fails as ambiguous. Disambiguate first (see "routing around", below).
3. **Never act on a node with a blank `name` and no `testId`/`id`.** An icon-only button or a
   bare clickable `<div>` gives replay nothing but tag and pixel size. It will match a sibling
   of the same shape, or nothing at all.
4. **Treat a name that is DATA as volatile.** The name string is baked into the step and must
   match verbatim on every future run. Reject names containing timestamps, relative time
   ("2 minutes ago"), counts ("Reports (3)"), ids, emails, usernames, currency, percentages, or
   anything generated. "Save" is fine. Last night's report title is not.
5. **Act on a settled page.** The fingerprint is captured at the instant you act, including the
   element's text and its size. Acting while a skeleton or spinner is up records placeholder
   text and placeholder dimensions, and then nothing matches on replay. After a navigation or
   anything that loads data: wait (`streamIdle`), then `observe`, then act.

### When you are not sure, ask the matcher

`verify_locator` runs the REAL replay matcher against a target without recording anything. Use
it whenever a target is not an obvious `testId`/`id` win — a card, a row control, a menu item,
anything you are about to build several later steps on top of.

Read the `verdict`, not just the `status`. `status: "resolved"` only means "findable right
now"; the verdict says whether the signal it won on can survive:

- `deterministic` — matched on a testId, a stable id, or an aria-label. Record it.
- `row-scoped` — found as "the control inside the row that says X". The probe echoes that text:
  confirm it is a stable, unique business identifier and not per-run or per-environment data.
  If it is data that changes, pick a different row or a different target.
- `text-bound` — found by visible text. Confirm that string is fixed UI copy. If it is content,
  pick a different target.
- `fragile` — matched only on class names or element size. There is no identity here; replay is
  separating your target from its siblings by shape and position. Do not record it.
- `ambiguous` / `not-found` — do not record it, full stop.

Also read `healed: true` as a warning: the match came from a weaker signal than the fingerprint's
strongest, which means the strong one is *already* failing.

### Routing around a target you cannot address

Do not record the step anyway. In order of preference:

  a. Act on a uniquely-named control that has the same effect — the named link inside the card
     rather than the card, the labelled button rather than its icon.
  b. Reach the state by `navigate` to a deep link instead of clicking through to it. Fewer steps
     means fewer locators that can rot; prefer this whenever the URL is stable.
  c. For a control in a repeated row or card: pick the row by a stable identifier that is unique
     on the page and identical on every run, then act on the control inside it. Never pick by
     position ("the first row", "the top card").
  d. If none of that works: **stop**. In interactive mode, tell the user exactly which control is
     not addressable and why ("no accessible name", "one of six identical Edit buttons"), and ask
     how to proceed — the real fix is usually a `data-testid` or an `aria-label` in the app. In
     batch mode, record the closest deterministic alternative and list the concession explicitly
     in your finish summary. Never record a coin-flip step to keep the plan moving.

### Targeting

- Always target by `ref` from the snapshot you just received. Re-observe after anything that
  re-renders the page — a React re-render drops the ref attribute.
- Use `text` targeting only when `observe` genuinely did not tag the element. It matches on a
  substring and takes the first hit, so it can land on a wrapper or on the wrong instance — and
  whatever it lands on is what gets recorded. If you must, use the control's full exact visible
  label, and only when that string appears exactly once on the page.
- After every action, read the returned snapshot and confirm the page changed the way you
  expected. If it did not, the step probably hit the wrong element — fix it before continuing,
  because every later step is being recorded against a page state that will not exist on replay.

### Waits

- Default to `streamIdle` for anything that loads, streams, or renders late.
- Use a `selector` wait ONLY on an element with a short, exact, unique visible label (a button or
  a link), or one you know carries a testId. On replay a selector wait does not use the scoring
  matcher — it uses a much narrower lookup, and on anything else it degrades into an exact match
  on the element's entire text or a bare tag selector, failing the step before the real matcher
  ever runs. Never put a selector wait on a card, panel, row, or any multi-line element.
- Never add `networkIdle`. Use `delay` only as a last resort.

### Hover-revealed content

To act on something inside a hover menu or flyout: hover the trigger, then act on the item by its
ref from the snapshot the hover returned. Never act on a revealed item without the hover in the
same sequence — the hover is only recorded when the next step targets what it revealed, and
without it replay clicks into a closed menu.

### Checkpoints

An element checkpoint has the same locator requirements as a click — a named, unique component
(verify it with `verify_locator` using `action: "checkpoint"`, which frames the exact node rather
than climbing to a control). If the thing you want to capture is a generic wrapper with no name,
use `fullpage` or a `region` rect instead.

### Finish report

In your finish summary, list every step whose locator you were not confident about: which
control, which rule or verdict it failed, and what the app should add (a `data-testid` on the
element, an `aria-label` on the icon button, a stable id on the row). The reviewer uses this to
set a selector override before promoting, so name the control and the step number.

---

## Repairing a failed test

When a run fails, do not re-author the test from scratch and do not guess at a fix from the error
message. Open a repair session: `open_repair_session` takes either a `runId` (a specific failure)
or a `testId` (that test's most recent failure) — a test id is usually what the user has, since it
is in the test's web-app URL. `failed_runs` lists what has failed if you need to look first.

That re-drives the test's own steps — the exact version that ran — to the point it died and parks
a browser there, so you are looking at the page the failing step actually faced. Read
`replay.note` first: if the drive broke earlier than the run did, the step you were sent to was
never reached, and the upstream step is the real bug. Then read `diagnosis` (the matcher's verdict
on the recorded locator against the live page) and compare `recordedLocator` with the `nodes`
actually present.

Test candidate fixes with `try_locator`. It merges your patch onto the real step's fingerprint and
re-runs the real matcher, so a `resolved` + `deterministic` verdict means it resolves at run time.
Iterate until `recommend` is true — `resolved` on its own is not the bar, since that is exactly
what let the current broken locator through.

Once a candidate comes back `recommend: true`, write it with `apply_fix`. It saves the patch to the
test as a new version — the same operation the locator editor performs, with the same validation
and audit trail — and it refuses anything that does not resolve against the live page, so a fix can
never replace one broken locator with another. The previous version is kept.

Always report what you changed and the new version number; the user must be able to find and undo
it. And if the honest answer is that the control needs a `data-testid` or an `aria-label` in the
app, say that too rather than letting a patch that will rot again pass for a fix.

---

## Team conventions

- Prefer `fullpage` checkpoints unless a single component is the thing under test.
- Mask any timestamp, relative-time, or random-id regions you see.
- Don't author tests against the login screen; assume an authenticated session.
- Use our naming convention for checkpoints: `<area>-<state>` (e.g. `dashboard-empty`).
