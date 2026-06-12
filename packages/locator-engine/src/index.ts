import type { Fingerprint } from "@varys/step-schema";
import type { Locator, Page } from "playwright";

export interface ResolveResult {
  locator: Locator;
  /** Which signal tier matched: testId | id | role+name | moduleClasses | text. */
  matchedSignal: string;
  /** True when a lower-priority signal matched (the top tiers missed). */
  healed: boolean;
}

type Candidate = { signal: string; build: () => Locator };

/** An exact-text match only works when we hold the element's *whole* text. capture
 *  caps text at 200 chars, so a string at/near that length is a truncated container
 *  dump — exact-matching it is a guaranteed miss, so the text tier skips it. */
const TEXT_EXACT_MAX = 180;

/**
 * Resolve a fingerprint against a live page using a ranked matcher. Tries each
 * available signal in priority order and returns the first that uniquely
 * matches; a non-top match is flagged `healed`. Returns null if nothing
 * matches (the run should hard-fail and surface the step for repair).
 *
 * Ranked tiers: testId → id → role+accessibleName → moduleClasses → text. The
 * bundle is stored whole so a confidence-scored matcher can replace this later
 * without re-recording.
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
  // CSS-module classes (e.g. `BriefsView__b-page___6nHPr`) are the only stable signal
  // for structural containers with no testId/id/role — a common screenshot-checkpoint
  // target. Build a compound class selector; the uniqueness+visibility check below
  // rejects shared classes, so this is safe even for generic class names. (Build-hashed
  // suffixes mean it's stable within a deployment, not across rebuilds — hence a low tier.)
  const safeClasses = (fp.moduleClasses ?? []).filter((c) => /^[\w-]+$/.test(c));
  if (safeClasses.length) {
    const sel = safeClasses.map((c) => `.${c}`).join("");
    candidates.push({ signal: "moduleClasses", build: () => page.locator(sel) });
  }
  // Exact text is only trustworthy for a real (short) label, never a truncated dump.
  if (fp.text && fp.text.length <= TEXT_EXACT_MAX) {
    candidates.push({
      signal: "text",
      build: () => page.getByText(fp.text!, { exact: true }),
    });
  }

  for (let i = 0; i < candidates.length; i++) {
    const { signal, build } = candidates[i];
    // Restrict to visible elements: a click/type/screenshot target is something the
    // user can see, never a hidden node. This also stops the text tier from resolving
    // to non-rendered text like an inline SVG's <metadata>/<dc:format> ("image/svg+xml")
    // or <script>/<style> content, which would otherwise match and then hang on click.
    const locator = build().filter({ visible: true });
    if ((await locator.count()) === 1) {
      return { locator, matchedSignal: signal, healed: i > 0 };
    }
  }
  return null;
}
