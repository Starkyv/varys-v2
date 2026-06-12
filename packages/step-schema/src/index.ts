import { z } from "zod";

/**
 * Step schema — the record ↔ replay ↔ diff ↔ DB contract.
 *
 * Issue 1 (walking skeleton) subset only: navigate + screenshot with a plain
 * selector. The real multi-signal Fingerprint, waits, masks, and variables
 * arrive in later slices (Issues 3–5). Keep this the single source of truth
 * for the definition shape; widen it as those slices land.
 */

export const navigateStep = z.object({
  type: z.literal("navigate"),
  url: z.string().min(1),
});

/**
 * Multi-signal element fingerprint captured at record time. The ranked matcher
 * (MVP) and the confidence-scored matcher (later) both resolve against these
 * signals — capturing the bundle, not a single selector, is what lets the
 * matcher evolve without re-recording.
 */
export const fingerprint = z.object({
  testId: z.string().optional(),
  role: z.string().optional(),
  accessibleName: z.string().optional(),
  text: z.string().optional(),
  tag: z.string(),
  attributes: z.record(z.string()).optional(),
  ancestors: z
    .array(z.object({ tag: z.string(), role: z.string().optional() }))
    .optional(),
  domIndex: z.number().int().nonnegative().optional(),
  neighborText: z.array(z.string()).optional(),
  moduleClasses: z.array(z.string()).optional(),
  boundingBox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
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
  z.object({
    kind: z.literal("selector"),
    target: fingerprint,
    state: z.enum(["visible", "hidden"]),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);
export type Wait = z.infer<typeof wait>;

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
  /** Regions (in screenshot pixel space) the diff ignores. */
  masks: z.array(rect).optional(),
  /** Max mismatched-pixel ratio (0..1) tolerated before a diff is flagged. */
  threshold: z.number().positive().max(1).optional(),
});

export const clickStep = z.object({
  type: z.literal("click"),
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

export const testDefinition = z
  .object({
    name: z.string().min(1),
    viewport,
    steps: z.array(step).min(1),
    /** The test's declared variables. Optional for back-compat — old definitions
     *  (recorded before this slice) carry none. */
    variables: z.array(variable).optional(),
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
    case "type":
      return `type into ${fingerprintLabel(step.target)}`;
    case "screenshot":
      return `checkpoint "${step.name}" (${step.captureMode ?? "element"})`;
  }
}
