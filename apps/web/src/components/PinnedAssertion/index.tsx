import type {
  AssertionOutcome,
  AssertionSideView,
  Coercion,
  FingerprintSummary,
  PinnedAssertionView,
  Relation,
} from "@varys/review-contract";
import type { Intent } from "@varys/ui";
import styles from "./styles.module.scss";

/**
 * The pinned form of an assertion, rendered for a human (Slice 19, slice 09).
 *
 * A pinned assertion is data, not code — so it can be SHOWN, and showing it is the point: an
 * author who cannot see which elements "the total equals the sum of the line items" reads has no
 * way to review the check, and a reviewer looking at a red run has no way to tell whether the
 * assertion or the app is at fault. The test editor and run detail both render this one component
 * so they cannot describe the same assertion differently.
 */

/** How each coercion reads in a sentence, rather than as a vocabulary token. */
const COERCION_LABEL: Record<Coercion, string> = {
  text: "text of",
  number: "number in",
  "sum-number": "sum of every",
  count: "number of",
  exists: "presence of",
};

/** The comparison, as an operator a reader recognises. */
const RELATION_LABEL: Record<Relation, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  "non-empty": "is non-empty",
};

/** A short handle for an element, preferring the most durable signal — the same order the
 *  matcher itself prefers, so the label names the signal that will actually find it. */
export function targetLabel(t: FingerprintSummary): string {
  if (t.selectorOverride) return t.selectorOverride;
  if (t.testId) return `[data-testid="${t.testId}"]`;
  if (t.accessibleName) return `“${t.accessibleName}”`;
  if (t.elementId) return `#${t.elementId}`;
  if (t.text) return `“${t.text.slice(0, 40)}”`;
  if (t.role) return `<${t.role}>`;
  return `<${t.tag}>`;
}

function Side({ side }: { side: AssertionSideView }) {
  if (side.target === null || side.as === null) {
    return (
      <span className={styles.literal}>
        {typeof side.literal === "string" ? `“${side.literal}”` : side.literal}
      </span>
    );
  }
  return (
    <span className={styles.side}>
      <span className={styles.coercion}>{COERCION_LABEL[side.as]}</span>{" "}
      <code className={styles.target}>{targetLabel(side.target)}</code>
    </span>
  );
}

export function PinnedAssertion({ pinned }: { pinned: PinnedAssertionView | null }) {
  if (!pinned) {
    // Declared but unpinned. Legal — and worth saying out loud, because a reader would otherwise
    // assume every declared check is being enforced.
    return (
      <p className={styles.unpinned}>
        Not pinned yet — this is a note about what should be true, and no run evaluates it.
      </p>
    );
  }
  const unary = pinned.relation === "non-empty";
  return (
    <div className={styles.pinned}>
      <Side side={pinned.left} />
      <span className={styles.relation}>{RELATION_LABEL[pinned.relation]}</span>
      {!unary && <Side side={pinned.right} />}
      {pinned.tolerance != null && <span className={styles.tolerance}>± {pinned.tolerance}</span>}
    </div>
  );
}

/**
 * The vocabulary for an assertion's verdict.
 *
 * `extraction-failed` is deliberately NOT rendered as another flavour of "failed": it says Varys
 * could not read one of the values, which is a statement about the test, not about the app. Giving
 * it the same red as a false relation would tell the reader the application is broken when nobody
 * has established that yet.
 */
export const OUTCOME_META: Record<AssertionOutcome, { label: string; tone: Intent; blurb: string }> = {
  passed: {
    label: "Passed",
    tone: "success",
    blurb: "Both values were read, and they agree.",
  },
  "relation-false": {
    label: "False",
    tone: "danger",
    blurb: "Both values were read, and they disagree — the app is wrong, not the locator.",
  },
  "extraction-failed": {
    label: "Couldn’t read",
    tone: "warning",
    blurb:
      "A value couldn’t be read, so nothing was compared — this says the test needs attention, not that the app is wrong.",
  },
};
