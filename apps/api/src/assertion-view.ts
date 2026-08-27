import { PINNABLE_CHECK_HELP } from "@varys/assertion-engine";
import type { PinnedAssertionView, TestConfigAssertion } from "@varys/review-contract";
import type { Assertion, PinnedAssertion } from "@varys/step-schema";
import { summarizeFingerprint } from "./fingerprint-summary";

/**
 * Render a pinned assertion for a reader (Slice 19, slice 09).
 *
 * The pinned form is data, so it can be SHOWN — which is the point: an author looking at "the
 * total equals the sum of the line items" has to be able to see which elements that reads and what
 * it compares, or the check is a black box they cannot review. Both the test editor and run detail
 * render this same shape, so they cannot describe the same assertion differently.
 */
export function summarizePinnedAssertion(pinned: PinnedAssertion | undefined): PinnedAssertionView | null {
  if (!pinned) return null;
  return {
    left: {
      target: summarizeFingerprint(pinned.left.target),
      as: pinned.left.as,
      literal: null,
    },
    right:
      "literal" in pinned.right
        ? { target: null, as: null, literal: pinned.right.literal }
        : { target: summarizeFingerprint(pinned.right.target), as: pinned.right.as, literal: null },
    relation: pinned.relation,
    tolerance: pinned.tolerance ?? null,
  };
}

/**
 * One declared assertion as the test editor shows it.
 *
 * `mode` and `pinningHelp` are the author-facing half of slice 11: an author has to be able to see
 * which of their checks are exact and which are approximate, and — for an approximate one — what
 * would make it exact. Learning months later that "the totals are right" was only ever being
 * eyeballed by a model is the failure this exists to prevent.
 */
export function summarizeAssertion(declared: Assertion): TestConfigAssertion {
  return {
    id: declared.id,
    check: declared.check,
    mode: declared.pinned ? "pinned" : "judged",
    pinned: summarizePinnedAssertion(declared.pinned),
    unpinnableReason: declared.unpinnableReason ?? null,
    pinningHelp: declared.pinned ? null : PINNABLE_CHECK_HELP,
  };
}
