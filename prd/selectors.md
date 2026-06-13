The two capture paths

  The recorder injects a script into every page (injected-recording-script.ts, injected via addInitScript in live-recorder.ts:97). That script listens for clicks/inputs and reports steps back to Node through window.__recordStep. There are two different element-targeting 
  strategies, and they're deliberately different:

  ┌──────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────┬─────────────────────────────────────────────────────────┐
  │                   What you do                    │                      What gets recorded                       │                        Strategy                         │
  ├──────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Click an element (normal interaction)            │ { action: 'click', locator } or { action: 'click', selector } │ Semantic role-based locator first, CSS path as fallback │
  ├──────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Ctrl+Shift+S then click (capture for screenshot) │ { action: 'screenshot', screenshotName, selector }            │ Always a CSS selector, never a role locator             │
  └──────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────┘

  Screenshots always use CSS because the screenshot target is "this exact box of pixels" — a region — not "the thing named Save", so a structural selector is the right tool. Clicks prefer semantic locators because the intent ("click the Save button") survives DOM
  restructuring better than a brittle path.

  ---
  Part 1 — How a screenshot element is selected
  
  Pressing Ctrl+Shift+S sets window.__vrhCaptureNextClick = true and draws a full-viewport transparent overlay (createCaptureOverlay, line 425). As you move the mouse, the overlay momentarily turns off its own pointer-events to ask the browser what's underneath:

  function getElementUnder(x, y) {
    overlay.style.pointerEvents = 'none';
    var el = document.elementFromPoint(x, y);   // real element under cursor
    overlay.style.pointerEvents = 'auto';
    return el;
  }

  That element gets a highlight box + label (color-coded by kind — amber for buttons, blue for links, etc., vrhKind at line 284). When you click, the overlay swallows the click (preventDefault/stopImmediatePropagation, so nothing actually activates) and records:

  var sel = el && el !== document.body ? getSelector(el) : null;
  if (sel && window.__recordStep)
    window.__recordStep({ action: 'screenshot', screenshotName: 'section-N', selector: sel });

  The Node side (live-recorder.ts:89) renumbers the placeholder positionally:

  if (payload.action === 'screenshot' && payload.screenshotName === 'section-N') {
    payload = { ...payload, screenshotName: `section-${++screenshotSectionIndex}` };
  }

  So the first capture is section-1, the second section-2, and so on. This is gotcha #8 in CLAUDE.md: baselines are keyed by (flowId, env, screenshotName), and these names are purely positional — re-recording with sections in a different order silently compares the wrong
  regions.

  ---
  Part 2 — getSelector(): the CSS fallback ladder (and your "no data-testid" question)

  getSelector (line 19) is the single CSS-selector builder, used by screenshots always and by clicks/fills when no semantic locator can be built. It tries three things, in order:

  Rung 1 — a stable, unique id:

  var stableId = id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)   // starts with a letter, no weird chars
    && !/^tippy-\d+$/.test(id)                               // not a generated tooltip id
    && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1;  // actually unique
  if (stableId) return '#' + el.id;

  Note the checks: an id like tippy-347 (tooltip libraries generate these with a counter — different every session) or :r1: (React useId) is rejected, because it would never match on rerun.

  Rung 2 — data-testid:

  if (el.getAttribute('data-testid'))
    return '[data-testid="' + ... + '"]';

  Rung 3 — and this answers your question — when there's no id and no data-testid, it builds a structural DOM path from the element up toward <body>:

  var path = [];
  var current = el;
  while (current && current !== document.body) {
    var part = current.tagName.toLowerCase();

    // If any ancestor has a stable id, anchor the path there and stop climbing
    if (useId) { part += '#' + curId; path.unshift(part); break; }

    // Add classes — but only "real" ones, max 2
    var classes = current.className.trim().split(/\s+/).filter(function(c) {
      return c && !/^\d+$/.test(c)                          // not purely numeric
        && !/__[a-zA-Z0-9]+___[a-zA-Z0-9]+$/.test(c);       // not a hashed CSS-module class
    });
    if (classes.length > 0 && classes.length <= 2) part += '.' + classes.slice(0, 2).join('.');

    // Disambiguate among same-tag siblings positionally
    if (sameTag.length > 1) part += ':nth-of-type(' + idx + ')';

    path.unshift(part);
    current = current.parentElement;
  }
  return path.join(' > ');

  So clicking a card deep in a sidebar with no test ids records something like:

  div#app > main.layout > aside > ul.flow-list > li:nth-of-type(3) > div.card

  Three stabilizing tricks are baked in:

  1. Anchor at the nearest stable id — if #app exists three levels up, the path starts there instead of going all the way to <body>, shortening the brittle portion.
  2. Class filtering — hashed CSS-module classes like card__title___x7Yq2 change on every build, so they're stripped; and if an element has more than 2 classes (utility-class soup, e.g. Tailwind), classes are skipped entirely for that segment rather than recording 9
  fragile ones.
  3. :nth-of-type only when actually needed — added solely when same-tag siblings exist.

  The honest trade-off: this path is positional. If someone inserts a new <li> above your target, li:nth-of-type(3) now points at a different row, and the rerun clicks/screenshots the wrong thing — often without erroring. That's exactly why clicks try hard to avoid this
  rung (next section), and why the file's header comment says "prefer role/label locators … over CSS selectors."

  ---
  Part 3 — How a click is resolved (the semantic ladder)

  The document-level click listener (line 501) does:

  var loc = getPreferredClickLocator(el);          // try semantic first
  if (loc) window.__recordStep({ action: 'click', locator: loc });
  else {
    var sel = getSelector(el);                     // CSS fallback (Part 2)
    window.__recordStep({ action: 'click', selector: sel });
  }

  getPreferredClickLocator (line 276) is a priority chain — first non-null wins:

  return getButtonLocator(el) || getOptionLocator(el) || getLinkLocator(el) || getAriaLabelRoleLocator(el);

  Each walks up the ancestor chain from e.target, because the thing you physically clicked is usually an <svg> or <span> inside the button, not the button itself.

  3a. Buttons — the most elaborate case (getButtonLocator, line 184)

  First it finds the nearest button-ish ancestor (<button>, role="button", or input[type=button|submit|image]). Then it computes an accessible name via getAccessibleName (line 80), which tries in order: aria-label → aria-labelledby (resolving the referenced elements'
  text) → title → an aria-label on a child (icon buttons often label the inner svg) → <svg><title> → img[alt] → finally the first non-empty line of innerText. The result carries a fromAttr flag marking whether the name came from a stable attribute vs. volatile visible
  text.

  Then four cases:

  Volatile name — the name came from innerText and looks data-driven (/[\d%\[\]]/ — digits, percent, brackets, e.g. a button labeled "42%" or "[3 items]"):

  if (name && !acc.fromAttr && isVolatileName(name)) {
    var vScope = getRowScope(current);
    if (vScope) return { type: 'role', role: 'button', name: name, within: vScope };
    return null;   // → falls through to CSS selector
  }

  Unique name — the happy path. If exactly one button on the page has this accessible name:

  return { type: 'role', role: 'button', name: name };
  // recorded as: { "type": "role", "role": "button", "name": "Save changes" }

  Duplicated name — e.g. a "⋮ more options" button on every row of a list. Recording it bare would be ambiguous, so it gets pinned to a scope:

  if (countButtonsWithName(name) > 1) {
    var rowScope = getRowScope(current);          // nearest li/tr/listitem/row/article ancestor
    if (rowScope) return { type: 'role', role: 'button', name: name, within: rowScope };
    var cssScope = getUniqueAncestorSelector(current);  // else: nearest uniquely-CSS-selectable ancestor
    if (cssScope) return { type: 'role', role: 'button', name: name, within: cssScope };
    return null;                                  // ambiguous and unscopable → CSS fallback
  }

  getRowScope (line 150) is the clever bit: it climbs to the nearest li / tr / [role=listitem] / [role=row] / [role=article] ancestor, extracts a short distinguishing line of its visible text (2–60 chars, must contain letters), and verifies that text appears in exactly 
  one row on the page. The recorded step then reads like a sentence:

  {
    "action": "click",
    "locator": {
      "type": "role", "role": "button", "name": "More options",
      "within": { "selector": "li", "hasText": "Checkout flow" }
    }
  }

  — "the More options button inside the row that says Checkout flow". That survives reordering, insertion, and styling changes, which a :nth-of-type path would not.

  No name at all — a bare getByRole('button') would match every button on the page, so it's only emitted if a unique row contains exactly one button (rowHasSingleButton); otherwise null → CSS fallback.

  3b. Options, links, aria-labels

  - getOptionLocator (line 226): an ancestor with role="option" → {type:'role', role:'option', name: visibleText}. Otherwise, a direct child of a listbox/menu/list/combobox → a plain text locator {type:'text', text} — for custom dropdowns that skip ARIA roles on items.
  - getLinkLocator (line 245): <a> or role="link" ancestor → role locator named by aria-label or visible text.
  - getAriaLabelRoleLocator (line 261): last semantic resort — any ancestor with a non-empty aria-label and a usable role (explicit role=, or inferred from BUTTON/A tags; role="generic" rejected).

  If all four return null, the click is recorded with the CSS path from Part 2.

  Fills (line 525) skip the semantic ladder entirely — inputs/textareas/selects always record getSelector(el) plus the value, debounced 400ms so typing produces one step, not one per keystroke.

  ---
  Part 4 — What's persisted and how replay resolves it

  Each event becomes a FlowStep (core/src/types/flow.ts:22). The two targeting fields coexist, and the doc comment defines the precedence: "locator … takes precedence over selector."

  export type StepLocator =
    | { type: 'role'; role: string; name?: string; within?: string | WithinScope }
    | { type: 'label'; text: string; within?: string | WithinScope }
    | { type: 'text'; text: string; within?: string | WithinScope };

  On rerun, getLocator in engine/src/runner/run.ts:149 maps this straight onto Playwright's semantic locator API:

  function getLocator(page: Page, step: FlowStep): Locator | null {
    if (step.locator) {
      const scope = resolveScope(page, step.locator.within);   // Page if unscoped
      if (step.locator.type === "role")
        return scope.getByRole(step.locator.role, { name: step.locator.name });
      if (step.locator.type === "label") return scope.getByLabel(step.locator.text);
      if (step.locator.type === "text")  return scope.getByText(step.locator.text, { exact: true });
    }
    if (step.selector) return page.locator(step.selector);     // CSS fallback
    return null;
  }

  resolveScope (line 127) rebuilds the within container: {selector} → page.locator(sel), {role} → page.getByRole(role), and either gets .filter({ hasText }) applied, then .first(). A bare string within is treated as CSS for back-compat.

  Two replay behaviors worth knowing:

  - Ambiguity is tolerated, loudly. The runner counts matches first; if more than one, it warns ("click locator matched N elements; using the first. Re-record or add a 'within' scope") and proceeds with .first() (run.ts:57). So a degraded selector doesn't fail the run —
  it risks acting on the wrong element instead.
  - Clicks use { force: true }, skipping Playwright's actionability checks (visible/stable/receives-events) — it won't hang on an element covered by an overlay, but it also won't catch "this element isn't actually clickable anymore."

  The screenshot step at replay (run.ts:106) is the simplest consumer — pure CSS, first match:

  if (step.selector) {
    await page.locator(step.selector).first().screenshot({ path: fullPath });
  } else {
    await page.screenshot({ path: fullPath });   // no selector = full page
  }

  ---
  TL;DR resolution order

  Click recording: button-by-accessible-name → option → link → anything with aria-label — each scoped to a unique text-identified row when the name is ambiguous/volatile — and only if all of that fails, a CSS path.

  CSS path (and all screenshots): stable unique #id → [data-testid] → ancestor-anchored structural path with filtered classes and :nth-of-type.

  So when there's no data-testid: for clicks it usually doesn't matter — the role/name locator is preferred anyway and is the more durable artifact. The fragile case is a screenshot target (or an unnamed, unscopeable clickable) on a page with no stable ids either: you get
  a positional div > ul > li:nth-of-type(3) > div.card path, which reruns fine as long as the DOM shape holds, but silently retargets if siblings are inserted or reordered. The replay side then compounds that silence by warning-and-using-.first() rather than failing on
  ambiguity.
