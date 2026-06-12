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

export const screenshotStep = z.object({
  type: z.literal("screenshot"),
  name: z.string().min(1),
  selector: z.string().min(1),
  /** Max mismatched-pixel ratio (0..1) tolerated before a diff is flagged. */
  threshold: z.number().positive().max(1).optional(),
});

export const step = z.discriminatedUnion("type", [navigateStep, screenshotStep]);

export const viewport = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive().default(1),
});

export const testDefinition = z.object({
  name: z.string().min(1),
  viewport,
  steps: z.array(step).min(1),
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
