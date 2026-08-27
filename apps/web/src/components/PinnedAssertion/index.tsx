import type {
  AssertionMode,
  AssertionOutcome,
  AssertionSideView,
  Coercion,
  ExtractionCause,
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
    // No pinned form, so every run judges this one instead (slice 11). Worth saying out loud:
    // a reader would otherwise assume every declared check is evaluated exactly.
    return (
      <p className={styles.unpinned}>
        Nothing pinned — a model reads the page and answers this check in prose, so the verdict is
        approximate rather than exact.
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
  "judge-failed": {
    label: "Judged false",
    tone: "danger",
    blurb:
      "A model read the page and said this check does not hold — evidence about the app, though an approximate reading rather than an exact comparison.",
  },
  "judge-unavailable": {
    label: "Not checked",
    tone: "neutral",
    blurb:
      "This check has no pinned form and the judge couldn’t be reached, so nothing was checked. The run claims nothing about it either way — which is why it is amber and not green.",
  },
};

/**
 * What FOLLOWS from the verdict (Slice 19, slice 10) — one sentence, so the reader learns the
 * consequence from the run rather than by noticing which jobs turned up in the queue.
 *
 * The distinction is the whole slice: a target that no longer resolves is a broken locator and is
 * repaired like any other, while a false relation is never repaired by anything, because re-pinning
 * an assertion until its numbers agree is a machine for hiding the bugs assertions exist to catch.
 */
export function consequenceOf(
  outcome: AssertionOutcome,
  cause: ExtractionCause | null,
): string | null {
  if (outcome === "relation-false") {
    return "Varys never repairs this. Fix the app, or change the check by hand if the check itself is wrong.";
  }
  if (outcome === "judge-failed") {
    return "Varys never repairs this either — re-pinning until a model agrees hides the same bugs. Fix the app, or pin the check so it is evaluated exactly instead of judged.";
  }
  if (outcome === "judge-unavailable") {
    return "Nothing to repair and nothing to diagnose: configure a judge on the Configurations page, or pin this check so it never needs one.";
  }
  if (outcome !== "extraction-failed") return null;
  return cause === "unresolved"
    ? "The target no longer resolves — a locator problem, and repairable like any other. Under an automatic Repair Policy this queues a repair job."
    : "The value was read but couldn’t be used as this check asked. That is the assertion’s definition, not its locator, so re-pinning wouldn’t help — edit the check.";
}

/**
 * Exact or approximate, as a badge (Slice 19, slice 11).
 *
 * The one thing an author must never have to infer. A judged check is a real check — "the chart
 * looks reasonable" is worth asserting and cannot be pinned — but it is a model's reading of a
 * screenshot, and mistaking it for arithmetic is how someone discovers months later that a total
 * was never really being verified. So the two are labelled, always, everywhere a check is shown.
 */
export const MODE_META: Record<AssertionMode, { label: string; tone: Intent; blurb: string }> = {
  pinned: {
    label: "Exact",
    tone: "info",
    blurb:
      "Pinned: the worker reads the values off the page and applies the comparison itself, with no model call.",
  },
  judged: {
    label: "Approximate",
    tone: "warning",
    blurb:
      "Judged: nothing is pinned, so a model looks at the page and answers this check. It still fails the run when it says no — but it is a reading, not arithmetic.",
  },
};
