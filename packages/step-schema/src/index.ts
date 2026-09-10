import { assertionSchema } from "@varys/assertion-engine";
import { z } from "zod";

/**
 * Step schema — the record ↔ replay ↔ diff ↔ DB contract.
 *
 * Issue 1 (walking skeleton) subset only: navigate + screenshot with a plain
 * selector. The real multi-signal Fingerprint, waits, masks, and variables
 * arrive in later slices (Issues 3–5). Keep this the single source of truth
 * for the definition shape; widen it as those slices land.
 */

/**
 * Multi-signal element fingerprint captured at record time. The ranked matcher
 * (MVP) and the confidence-scored matcher (later) both resolve against these
 * signals — capturing the bundle, not a single selector, is what lets the
 * matcher evolve without re-recording.
 */
/**
 * Identifies one `<iframe>` to descend into on the way to a target. A target's element can live
 * inside a (possibly nested) iframe — e.g. a DataGenie Brief report or a Wisdom visualization,
 * both rendered into a same-origin `<iframe srcDoc>`. The matcher tries these signals in order to
 * locate the frame element (testId → id → name → src substring → nth iframe). Only same-origin
 * frames are reachable; an unresolvable frame fails the step loudly rather than capturing empty.
 */
export const frameRef = z.object({
  testId: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  /** A substring of the iframe's `src` (stable slice), for frames identified by URL. */
  urlContains: z.string().optional(),
  /** 0-based index among the iframes of its parent document — the last-resort fallback when the
   *  frame carries no stable attribute. */
  index: z.number().int().nonnegative().optional(),
});
export type FrameRef = z.infer<typeof frameRef>;

export const fingerprint = z.object({
  testId: z.string().optional(),
  /** Ordered iframes to descend (outermost first) before matching the target inside the innermost
   *  frame's document. Absent/empty ⇒ the target is in the top-level page (today's behavior). */
  frameChain: z.array(frameRef).optional(),
  role: z.string().optional(),
  accessibleName: z.string().optional(),
  /** True when `accessibleName` came from a stable attribute (aria-label, title, …)
   *  rather than volatile visible text — a durable-name signal for the matcher. */
  nameFromAttr: z.boolean().optional(),
  text: z.string().optional(),
  tag: z.string(),
  attributes: z.record(z.string()).optional(),
  /** Ancestor chain (nearest first). `id`/`testId` let a structural path anchor at
   *  the nearest *stable* ancestor instead of climbing to <body>. */
  ancestors: z
    .array(
      z.object({
        tag: z.string(),
        role: z.string().optional(),
        id: z.string().optional(),
        testId: z.string().optional(),
      }),
    )
    .optional(),
  domIndex: z.number().int().nonnegative().optional(),
  neighborText: z.array(z.string()).optional(),
  /** Scope to a repeated container — "the element inside the row that says <text>".
   *  `container` is a row selector (li / tr / [role="row"] / …); `text` is a line of
   *  the container's visible text verified unique among such containers. */
  scope: z.object({ container: z.string(), text: z.string() }).optional(),
  /** All raw classes (weak corroboration only — includes build-hashed ones). */
  moduleClasses: z.array(z.string()).optional(),
  /** The durable subset: build-hashed (e.g. `Name__x___hash`), purely-numeric, and
   *  utility-class-soup classes removed. Preferred over `moduleClasses` for matching. */
  stableClasses: z.array(z.string()).optional(),
  boundingBox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
  /** A deterministic structural CSS path (classic getSelector ladder: stable unique
   *  `#id` → `[data-testid]` → ancestor-anchored path with filtered classes +
   *  `:nth-of-type`). A last-resort fallback the runner uses ONLY for element
   *  screenshots when the scored matcher can't confidently resolve — a wrong region
   *  is far cheaper than a wrong click, so screenshots tolerate a positional `.first()`
   *  match the click path deliberately refuses. */
  cssPath: z.string().optional(),
  /** An AUTHOR-supplied raw selector override (Slice 16.2), distinct from the recorder's
   *  `cssPath`. When set, the matcher tries it FIRST and uses it as-is iff it resolves to
   *  exactly one element (`matchedSignal: "override"`); a stale / non-unique / malformed
   *  override is ignored and the scored multi-signal bundle takes over (self-heal). Edited
   *  in the test-detail locator editor; never written by the recorder. */
  selectorOverride: z.string().optional(),
});

export type Fingerprint = z.infer<typeof fingerprint>;

export const rect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Rect = z.infer<typeof rect>;

/** Per-step wait primitives applied before the step runs. */
export const wait = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delay"), ms: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("networkIdle"),
    timeoutMs: z.number().int().positive().optional(),
  }),
  /** Wait until streamed/late-rendering content (Wisdom answers, late d3 layout) has SETTLED —
   *  the DOM has been mutation-free for `quietMs` AND no loading indicator (skeleton / spinner /
   *  progressbar / `aria-busy`) remains — and, in the drivers, while any app request is still in
   *  flight (see `waitForStreamIdle`, which is what holds through a stream that pauses
   *  mid-answer) — capped at `timeoutMs`. Best-effort: proceeds at the cap
   *  even if the page never fully quiesces. `busySelector` overrides the built-in loading-indicator
   *  selector for an app whose marker the default doesn't catch. */
  z.object({
    kind: z.literal("streamIdle"),
    quietMs: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    busySelector: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("selector"),
    target: fingerprint,
    state: z.enum(["visible", "hidden"]),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);
export type Wait = z.infer<typeof wait>;

/** `streamIdle` defaults, shared by every driver so "settled" means one thing everywhere.
 *  `timeoutMs` is a generous cap, not a target: with the loading gate below the wait resolves
 *  as soon as content finishes, and the cap only bites if a busy marker never clears (an
 *  LLM answer with tool calls can legitimately run past a minute). */
export const STREAM_IDLE_DEFAULTS = {
  quietMs: 800,
  timeoutMs: 120_000,
  /** How long to wait for a loading marker to APPEAR before concluding nothing async is
   *  coming. Covers the submit→skeleton latency; any DOM mutation in this window also counts
   *  as activity. */
  graceMs: 6_000,
  /** Common "still working" markers. `data-testid*="skeleton"` catches answer/section
   *  skeletons (testids survive CSS-module hashing, unlike class names) — but plenty of apps
   *  ship no testids at all, so the class forms are matched too. A hashed CSS-modules class
   *  (`Skeleton_root__a3f9`) still CONTAINS the word, which is why the substring match earns
   *  its keep. Over-matching is safe because `busy()` ignores elements that aren't actually
   *  rendered: a permanently-mounted, hidden spinner is not a busy signal. */
  busySelector:
    '[aria-busy="true"],[role="progressbar"],[data-loading="true"],[data-state="loading"],[data-testid*="skeleton" i],[data-testid*="spinner" i],[data-testid*="loading" i],[class*="skeleton" i],[class*="spinner" i],[class*="animate-pulse"]',
} as const;

/**
 * The canonical in-page implementation of a `streamIdle` wait, as a raw JS expression string
 * to hand to `page.evaluate`.
 *
 * It lives here, beside the schema that DEFINES the primitive, because two drivers must agree
 * on it: the runner performs it on replay, and the authoring server performs it live so the
 * model's next observation sees settled content. A second, drifting copy would mean Claude
 * authors against one notion of "settled" and replay asserts against another.
 *
 * Why a state machine rather than "quiet for `quietMs`": the work usually hasn't STARTED when
 * the wait begins (the click that submits a query is the previous step; the skeleton appears a
 * beat later). A naive quiet check fires in that pre-work calm and captures the skeleton. So:
 *   • `busy()`  — a loading marker is present (skeleton / spinner / progressbar / aria-busy).
 *   • activity  — a loading marker OR any DOM mutation (streaming text, late chart) resets idle.
 * We settle only when idle for `quietMs` AND either a loading state was seen and has since
 * cleared (`sawBusy` — content finished), or `graceMs` elapsed with nothing async happening
 * (a static page — nothing to wait for). Reads only signals the app already renders; no
 * app-side markup required. Best-effort: it resolves at the cap even if the page never quiesces.
 *
 * Emitted as a raw STRING (not a serialized function) so esbuild/tsx `keepNames` can't inject a
 * `__name` helper that doesn't exist in the page.
 */
export function streamIdleExpression(opts?: {
  quietMs?: number;
  timeoutMs?: number;
  busySelector?: string;
  /** The caller already KNOWS async work ran and finished — it watched the request, which the
   *  page cannot see (see `waitForStreamIdle`). Skips the grace window: with the "did anything
   *  actually happen?" question already answered, a quiet DOM means rendered, not idle-so-far. */
  sawWork?: boolean;
}): string {
  const quiet = opts?.quietMs ?? STREAM_IDLE_DEFAULTS.quietMs;
  const max = opts?.timeoutMs ?? STREAM_IDLE_DEFAULTS.timeoutMs;
  const grace = STREAM_IDLE_DEFAULTS.graceMs;
  const sel = opts?.busySelector?.trim() || STREAM_IDLE_DEFAULTS.busySelector;
  return `(function () {
  return new Promise(function (resolve) {
    var quiet = ${quiet}, max = ${max}, grace = ${grace}, sel = ${JSON.stringify(sel)}, obs = null;
    var start = Date.now(), lastActivity = Date.now(), sawBusy = ${opts?.sawWork ? "true" : "false"};
    var hard = setTimeout(finish, max);
    // Busy = a loading marker that is actually RENDERED. Presence in the DOM is not enough:
    // apps keep spinners/skeletons mounted and hidden, and treating one as "still working"
    // would hang the wait until its cap on every page that has one.
    function busy() {
      try {
        var nodes = document.querySelectorAll(sel);
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].getClientRects().length > 0) return true;
        }
        return false;
      } catch (e) { return false; }
    }
    function finish() { try { if (obs) obs.disconnect(); } catch (e) {} clearTimeout(hard); resolve(true); }
    function tick() {
      var now = Date.now();
      if (busy()) { sawBusy = true; lastActivity = now; return setTimeout(tick, 150); }
      if (now - lastActivity < quiet) return setTimeout(tick, 150);
      // Idle long enough. Settle if a loading state came and went (content finished), or the
      // grace window elapsed with nothing async ever happening (a static page).
      if (sawBusy || (now - start) >= grace) return finish();
      return setTimeout(tick, 150);
    }
    try {
      obs = new MutationObserver(function () { lastActivity = Date.now(); });
      obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    } catch (e) {}
    setTimeout(tick, 150);
  });
})()`;
}

export const screenshotStep = z.object({
  type: z.literal("screenshot"),
  name: z.string().min(1),
  /** How the checkpoint is captured. Absent ⇒ `element` (back-compat). */
  captureMode: z.enum(["element", "fullpage", "region"]).default("element"),
  /** Required for `element` capture (enforced on the definition); the resolved
   *  locator is screenshotted. */
  target: fingerprint.optional(),
  /** Required for `region` capture; the clipped rectangle (screenshot-pixel space). */
  rect: rect.optional(),
  waitBefore: z.array(wait).optional(),
  /** How the captured screenshot is compared against its baseline. Absent ⇒ `pixel`
   *  (back-compat): the classic `diffPng` pixel comparison. `context` sends the baseline
   *  + current screenshots + `prompt` to an LLM judge that returns pass/fail + reasoning —
   *  for non-deterministic, LLM-generated content (Briefs, Wisdom) that pixel-diff can't
   *  handle. `compareMode` is orthogonal to `captureMode`. */
  compareMode: z.enum(["pixel", "context"]).default("pixel"),
  /** The author-written instruction/checklist the `context` judge follows (e.g. "both are
   *  AI-generated briefs; ignore that words/numbers differ; is the CURRENT one broken or
   *  degraded vs the baseline?"). Required when `compareMode` is `context`; unused for
   *  `pixel`. */
  prompt: z.string().min(1).optional(),
  /** Regions (in screenshot pixel space) the diff ignores. Pixel-mode only — ignored when
   *  `compareMode` is `context`. */
  masks: z.array(rect).optional(),
  /** Max mismatched-pixel ratio (0..1) tolerated before a diff is flagged. Pixel-mode only —
   *  ignored when `compareMode` is `context`. */
  threshold: z.number().positive().max(1).optional(),
});

/**
 * A navigation to a URL. Replayed as `page.goto(url, { waitUntil: "networkidle" })`.
 *
 * `waitBefore` runs BEFORE the navigation — the page you are leaving, not the one you arrive at
 * (network idle covers the arrival). It is how an author settles a page whose in-flight work would
 * otherwise be abandoned mid-flight by the `goto`. Unlike the other step types, the test-level
 * `defaults.waitBefore` do NOT apply to a navigate: a global settle exists for the steps that
 * resolve an element, and applying it to every navigation would change how every stored test
 * replays.
 */
export const navigateStep = z.object({
  type: z.literal("navigate"),
  url: z.string().min(1),
  waitBefore: z.array(wait).optional(),
});

export const clickStep = z.object({
  type: z.literal("click"),
  target: fingerprint,
  waitBefore: z.array(wait).optional(),
});

/** A hover over an element — replayed as `locator.hover()`. Recorded when hovering a trigger
 *  reveals content (a menu/flyout/tooltip) the user then interacts with; a subsequent click on
 *  that revealed content would be unreachable at replay without first re-hovering the trigger. */
export const hoverStep = z.object({
  type: z.literal("hover"),
  target: fingerprint,
  waitBefore: z.array(wait).optional(),
});

export const typeStep = z.object({
  type: z.literal("type"),
  target: fingerprint,
  value: z.string(),
  waitBefore: z.array(wait).optional(),
});

export const step = z.discriminatedUnion("type", [
  navigateStep,
  clickStep,
  hoverStep,
  typeStep,
  screenshotStep,
]);

export const viewport = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive().default(1),
});

/**
 * A variable the test references via a `{{token}}`. Declared once per token so the
 * environment editor and the resolver both know what the test needs (DESIGN §3):
 *  - `url`    — the navigation origin → `{{baseUrl}}`
 *  - `data`   — an environment-specific typed value → `{{name}}`
 *  - `secret` — a credential → `{{secret:name}}` (resolved only inside the worker)
 */
export const variable = z.object({
  name: z.string().min(1),
  kind: z.enum(["url", "data", "secret"]),
});
export type Variable = z.infer<typeof variable>;

/**
 * A named check on a RELATIONSHIP between things on the page (Slice 19, slice 09) — the total vs
 * the sum of its rows, the row count vs the badge — evaluated on every run with no model call.
 *
 * The vocabulary (coercions, relations, tolerance) and the evaluator belong to
 * `@varys/assertion-engine`; the TARGET of each side is a Fingerprint, which is this package's, so
 * the definition-level schema is built here from the engine's factory. That direction matters: the
 * engine stays pure and browser-free because it never sees a target, only the values the runner
 * already extracted.
 */
export const assertion = assertionSchema(fingerprint);
export type Assertion = z.infer<typeof assertion>;
export type PinnedAssertion = NonNullable<Assertion["pinned"]>;

export const testDefinition = z
  .object({
    name: z.string().min(1),
    viewport,
    steps: z.array(step).min(1),
    /** The test's declared variables. Optional for back-compat — old definitions
     *  (recorded before this slice) carry none. */
    variables: z.array(variable).optional(),
    /** Test-level defaults the runner applies before EVERY step that resolves an element
     *  (click / hover / type / screenshot — never a navigate, which carries only its own
     *  `waitBefore`). Merged AHEAD of each step's own
     *  `waitBefore`, so a global "wait for network idle before each checkpoint" lives
     *  here and per-step waits layer on top. Optional/back-compat — old definitions
     *  carry none, and the runner's hard-coded pre-screenshot settle remains a net. */
    defaults: z.object({ waitBefore: z.array(wait).optional() }).optional(),
    /** The test's declared Assertions (Slice 19, slice 09). Optional/back-compat — every
     *  definition recorded before this slice carries none, and a test may legitimately have no
     *  assertion at all. Ids are author-chosen and stable: they are the identity each assertion's
     *  history hangs off, so an edit to `check` keeps its id (and its past). */
    assertions: z.array(assertion).optional(),
  })
  // Per-mode requirements: element ⇒ target, region ⇒ rect, fullpage ⇒ neither.
  // (Refined here rather than on screenshotStep so it stays a discriminated-union
  // member on `type`.)
  .superRefine((def, ctx) => {
    def.steps.forEach((s, i) => {
      if (s.type !== "screenshot") return;
      if (s.captureMode === "element" && !s.target) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "target"],
          message: "element capture requires a target",
        });
      }
      if (s.captureMode === "region" && !s.rect) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", i, "rect"],
          message: "region capture requires a rect",
        });
      }
      // A `context` checkpoint's `prompt` is OPTIONAL: when omitted it inherits the global default
      // judge prompt from the Configurations page (enforced at run time, which knows that default).
    });
    // An assertion id is a history key, so a duplicate would silently merge two different checks'
    // pasts into one line. Rejected rather than de-duplicated.
    const ids = (def.assertions ?? []).map((a) => a.id);
    ids.forEach((id, i) => {
      if (ids.indexOf(id) !== i) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assertions", i, "id"],
          message: `assertion id "${id}" is used twice — ids identify an assertion's history and must be unique`,
        });
      }
    });
  });

export type Step = z.infer<typeof step>;
export type NavigateStep = z.infer<typeof navigateStep>;
export type ScreenshotStep = z.infer<typeof screenshotStep>;
export type Viewport = z.infer<typeof viewport>;
export type TestDefinition = z.infer<typeof testDefinition>;

/** Parse + validate an unknown value as a TestDefinition (throws ZodError on failure). */
export function parseTestDefinition(input: unknown): TestDefinition {
  return testDefinition.parse(input);
}

/** A short, human-readable handle for an element fingerprint (for step labels). */
function fingerprintLabel(fp: Fingerprint): string {
  if (fp.testId) return `[data-testid="${fp.testId}"]`;
  if (fp.accessibleName) return `"${fp.accessibleName}"`;
  if (fp.text) return `"${fp.text}"`;
  if (fp.attributes?.id) return `#${fp.attributes.id}`;
  if (fp.role) return `<${fp.role}>`;
  return `<${fp.tag}>`;
}

/**
 * A short human label for a step — used in failed-run reporting so a reviewer can see
 * *which* step failed (e.g. `click "Submit"`, `navigate to "{{baseUrl}}/"`). Labels the
 * recorded (tokenized) form, matching what the stored definition holds.
 */
export function describeStep(step: Step): string {
  switch (step.type) {
    case "navigate":
      return `navigate to "${step.url}"`;
    case "click":
      return `click ${fingerprintLabel(step.target)}`;
    case "hover":
      return `hover ${fingerprintLabel(step.target)}`;
    case "type":
      return `type into ${fingerprintLabel(step.target)}`;
    case "screenshot": {
      const mode = step.captureMode ?? "element";
      // Only annotate the comparison when it's the non-default `context` judge, so
      // existing pixel checkpoints keep their `(element)` / `(fullpage)` labels.
      return step.compareMode === "context"
        ? `checkpoint "${step.name}" (${mode}, context)`
        : `checkpoint "${step.name}" (${mode})`;
    }
  }
}
