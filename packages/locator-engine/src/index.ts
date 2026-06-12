import type { Fingerprint } from "@varys/step-schema";
import type { Locator, Page } from "playwright";

export interface ResolveResult {
  locator: Locator;
  /** Which signal tier matched: testId | id | role+name | text. */
  matchedSignal: string;
  /** True when a lower-priority signal matched (the top tiers missed). */
  healed: boolean;
}

type Candidate = { signal: string; build: () => Locator };

/**
 * Resolve a fingerprint against a live page using a ranked matcher. Tries each
 * available signal in priority order and returns the first that uniquely
 * matches; a non-top match is flagged `healed`. Returns null if nothing
 * matches (the run should hard-fail and surface the step for repair).
 *
 * Ranked tiers (MVP): testId → id → role+accessibleName → text. The bundle is
 * stored whole so a confidence-scored matcher can replace this later without
 * re-recording.
 */
export async function resolve(
  page: Page,
  fp: Fingerprint,
): Promise<ResolveResult | null> {
  const candidates: Candidate[] = [];

  if (fp.testId) {
    candidates.push({
      signal: "testId",
      build: () => page.locator(`[data-testid="${fp.testId}"]`),
    });
  }
  if (fp.attributes?.id) {
    candidates.push({
      signal: "id",
      build: () => page.locator(`#${fp.attributes!.id}`),
    });
  }
  if (fp.role && fp.accessibleName) {
    candidates.push({
      signal: "role+name",
      build: () =>
        page.getByRole(fp.role as Parameters<Page["getByRole"]>[0], {
          name: fp.accessibleName!,
          exact: true,
        }),
    });
  }
  if (fp.text) {
    candidates.push({
      signal: "text",
      build: () => page.getByText(fp.text!, { exact: true }),
    });
  }

  for (let i = 0; i < candidates.length; i++) {
    const { signal, build } = candidates[i];
    const locator = build();
    if ((await locator.count()) === 1) {
      return { locator, matchedSignal: signal, healed: i > 0 };
    }
  }
  return null;
}
