import {
  type AssertionResult,
  type Coercion,
  type ExtractedSide,
  evaluateAssertion,
  unresolved,
  values,
} from "@varys/assertion-engine";
import { resolve, searchRootFor } from "@varys/locator-engine";
import type { Assertion, Fingerprint } from "@varys/step-schema";
import type { Page } from "playwright";

/**
 * Assertion EXTRACTION — the half of an assertion that needs a browser.
 *
 * `@varys/assertion-engine` decides whether a relation holds; this file decides what the two sides
 * read. The split is deliberate: everything here needs a live page and can only be covered by an
 * E2E, so it is kept as thin as it can be and holds no comparison logic at all.
 *
 * The extraction contract, which is a real part of the assertion vocabulary:
 *
 *  - `text` / `number`  — the scored matcher, exactly as a click or a checkpoint resolves. One
 *                          element, identified by the whole fingerprint bundle. No match ⇒ the side
 *                          is `unresolved`, which the engine reports as **extraction failed** — a
 *                          locator problem, never the app disagreeing with itself.
 *  - `exists`           — the same matcher, but "no match" is the ANSWER (`false`), not a failure.
 *                          That is the entire point of the coercion.
 *  - `count` /          — a SET, which the scored matcher cannot express: it marks a single winner
 *    `sum-number`         by design. So these read the target's author-written selector
 *                          (`selectorOverride`, else the recorder's `cssPath`) inside the
 *                          fingerprint's frame, and take every match's text. A target with neither
 *                          selector is `unresolved` with a message that says what to add — silently
 *                          summing one element would be a wrong answer wearing a right one's clothes.
 */

/** How long a side's matcher waits for its element. Deliberately shorter than a step's: by the time
 *  assertions run the page has already settled through every step's own waits. */
const EXTRACT_TIMEOUT_MS = 2_000;

/** The coercions that read a SET of elements rather than a single identified one. */
const SET_COERCIONS: readonly Coercion[] = ["count", "sum-number"];

/** A short handle for a target, so an extraction failure names what it was looking for. */
function targetLabel(fp: Fingerprint): string {
  if (fp.testId) return `[data-testid="${fp.testId}"]`;
  if (fp.selectorOverride) return fp.selectorOverride;
  if (fp.accessibleName) return `"${fp.accessibleName}"`;
  if (fp.text) return `"${fp.text}"`;
  if (fp.attributes?.id) return `#${fp.attributes.id}`;
  if (fp.cssPath) return fp.cssPath;
  if (fp.role) return `<${fp.role}>`;
  return `<${fp.tag}>`;
}

/** Read one side of a comparison off the page. Never throws: a failure to read IS a result. */
export async function extractSide(
  page: Page,
  target: Fingerprint,
  as: Coercion,
): Promise<ExtractedSide> {
  try {
    if (SET_COERCIONS.includes(as)) {
      const selector = target.selectorOverride?.trim() || target.cssPath?.trim();
      if (!selector) {
        return unresolved(
          `${targetLabel(target)} has no set selector — a ${as} side reads EVERY matching element, so it needs a selectorOverride (or a recorded cssPath) that addresses the set`,
        );
      }
      // Frame descent still applies: matching a set against the top-level document when the target
      // lives in an iframe reads nothing and would report it as a legitimate zero.
      const root = await searchRootFor(page, target, EXTRACT_TIMEOUT_MS);
      if (!root) {
        return unresolved(`could not reach the iframe ${targetLabel(target)} lives in`);
      }
      const texts = await root.locator(selector).allInnerTexts();
      return values(texts);
    }

    const found = await resolve(page, target, { timeoutMs: EXTRACT_TIMEOUT_MS });
    if (!found) {
      // `exists` asked whether it is there; "it is not" is the answer, not a broken locator.
      if (as === "exists") return values([]);
      return unresolved(`could not locate ${targetLabel(target)} — no fingerprint signal matched`);
    }
    if (as === "exists") return values([""]);
    return values([await found.locator.innerText()]);
  } catch (err) {
    // A page-level error (a detached element, a closed frame) is an extraction failure like any
    // other — the run must not die because an assertion could not read something.
    return unresolved(
      `couldn't read ${targetLabel(target)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Evaluate every PINNED assertion of a definition against the page as it stands, with no model
 * call. An assertion with no pinned form is documentation and is skipped (it produces no result
 * row, so it can never colour a run).
 */
export async function evaluateAssertions(
  page: Page,
  assertions: Assertion[] | undefined,
): Promise<AssertionResult[]> {
  const out: AssertionResult[] = [];
  for (const declared of assertions ?? []) {
    const pinned = declared.pinned;
    if (!pinned) continue;
    const left = await extractSide(page, pinned.left.target, pinned.left.as);
    const right =
      "literal" in pinned.right
        ? undefined
        : await extractSide(page, pinned.right.target, pinned.right.as);
    out.push(evaluateAssertion(declared, { left, right }));
  }
  return out;
}

