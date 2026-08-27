import { z } from "zod";

/**
 * Assertion engine — a check on a RELATIONSHIP, not on an image.
 *
 * A pixel diff and an LLM judge both answer "does this look like it did before?". An Assertion
 * answers a different question: "do these two numbers on the page still agree?" — the total vs the
 * sum of its rows, the row count vs the badge, the header vs a literal. That is the class of bug a
 * screenshot cannot catch, because the page can be pixel-perfect and arithmetically wrong.
 *
 * A **pinned** assertion is data, never code: which fingerprints to read, how to coerce each, and
 * which relation to apply — all from a vocabulary this package owns. Nothing model-authored ever
 * executes in the worker. Claude may PROPOSE a pinned form (slice 12); it can only ever fill in
 * these fields.
 *
 * This package is pure and network-free, in the shape of `@varys/judge-engine`: it evaluates a
 * pinned form over **already-extracted values**. Resolving a fingerprint and reading text off the
 * page stays in the runner, behind {@link ExtractedSide}. That split is what makes every
 * coercion × relation pairing unit-testable with no browser.
 *
 * The distinction that carries the whole safety story lives in {@link AssertionOutcome}:
 * **extraction-failed** (a side produced no value — nothing was compared) is a different result
 * from **relation-false** (both values were read, and they disagree — the app is wrong). Only the
 * second is evidence about the application under test.
 */

/** How a side's extracted text is turned into a comparable value. */
export const coercionSchema = z.enum(["text", "number", "sum-number", "count", "exists"]);
export type Coercion = z.infer<typeof coercionSchema>;

/** The comparison applied to the two coerced values. */
export const relationSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "non-empty",
]);
export type Relation = z.infer<typeof relationSchema>;

/** Relations that compare NUMBERS, and are therefore the only ones `tolerance` means anything for. */
export const NUMERIC_RELATIONS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
/** Relations that read the LEFT side only — the right side is absent by construction. */
export const UNARY_RELATIONS = ["non-empty"] as const;

export function isNumericRelation(relation: Relation): boolean {
  return (NUMERIC_RELATIONS as readonly string[]).includes(relation);
}
export function isUnaryRelation(relation: Relation): boolean {
  return (UNARY_RELATIONS as readonly string[]).includes(relation);
}

/** One side of a comparison: an element to read, or a fixed value written by the author. */
export interface AssertionTargetSide<TTarget> {
  target: TTarget;
  as: Coercion;
}
export interface AssertionLiteralSide {
  literal: string | number;
}
export type AssertionSide<TTarget> = AssertionTargetSide<TTarget> | AssertionLiteralSide;

/**
 * The pinned form: fully determined data the worker executes with no model call.
 *
 * Generic in the TARGET type because this package does not own fingerprints — `@varys/step-schema`
 * builds the definition-level schema by passing its `fingerprint` into
 * {@link pinnedAssertionSchema}, and the engine itself never looks at a target at all (extraction
 * has already happened by the time it is called).
 */
export interface PinnedAssertion<TTarget = unknown> {
  kind: "relation";
  left: AssertionTargetSide<TTarget>;
  right: AssertionSide<TTarget>;
  relation: Relation;
  /**
   * Numeric slack, for numeric relations only. `eq`/`neq` pass when the two numbers are within
   * `tolerance` of each other; the ordering relations widen the boundary by it (see
   * {@link applyRelation}). Absent ⇒ exact.
   */
  tolerance?: number;
}

/** A named check on a test, with a stable author-chosen id and plain-language `check` text. */
export interface Assertion<TTarget = unknown> {
  /**
   * Author-chosen and STABLE — it is the identity the assertion's history hangs off, so editing
   * `check` or re-pinning must never change it.
   */
  id: string;
  /** Plain language: what this assertion is claiming about the app. */
  check: string;
  /** Absent ⇒ declared but not yet pinned; it is documentation, and no run evaluates it. */
  pinned?: PinnedAssertion<TTarget>;
}

/** Assertion ids are used in URLs, DB keys and history joins — keep them boring. */
export const ASSERTION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Build the pinned-assertion schema over a caller-supplied target schema. `@varys/step-schema`
 * passes its `fingerprint`; a caller that does not care about targets can use
 * {@link pinnedAssertion}.
 */
export function pinnedAssertionSchema<T extends z.ZodTypeAny>(target: T) {
  return z
    .object({
      kind: z.literal("relation"),
      left: z.object({ target, as: coercionSchema }),
      right: z.union([
        z.object({ target, as: coercionSchema }),
        z.object({ literal: z.union([z.string(), z.number()]) }),
      ]),
      relation: relationSchema,
      tolerance: z.number().nonnegative().optional(),
    })
    .superRefine((pinned, ctx) => {
      // `tolerance` on `contains` / `non-empty` would be silently ignored, which reads as a
      // configured slack that isn't there — reject it instead.
      if (pinned.tolerance !== undefined && !isNumericRelation(pinned.relation)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tolerance"],
          message: `tolerance applies to numeric relations only (${NUMERIC_RELATIONS.join(", ")}), not "${pinned.relation}"`,
        });
      }
    });
}

/** Build the assertion schema (id + check + optional pinned form) over a target schema. */
export function assertionSchema<T extends z.ZodTypeAny>(target: T) {
  return z.object({
    id: z
      .string()
      .min(1)
      .regex(
        ASSERTION_ID_PATTERN,
        "an assertion id must start alphanumeric and contain only letters, digits, - and _",
      ),
    check: z.string().min(1),
    pinned: pinnedAssertionSchema(target).optional(),
  });
}

/** The target-agnostic schemas, for callers that validate a pinned form without a fingerprint. */
export const pinnedAssertion = pinnedAssertionSchema(z.record(z.unknown()));
export const assertion = assertionSchema(z.record(z.unknown()));

// ---- extraction (performed by the runner, consumed here) ----------------------------------

/**
 * What the runner read for one side of a comparison.
 *
 * `values` carries the raw text of every element the side resolved to — one entry for a single
 * element, many for a `count` / `sum-number` set, and ZERO for a set that legitimately matched
 * nothing (which is a real answer for `count` and `exists`, not a failure).
 *
 * `unresolved` is the other thing entirely: the runner could not even ask the page — the locator
 * did not resolve, or a frame in the chain was unreachable. That is a locator problem, and it must
 * never be reported as the app disagreeing with itself.
 */
export type ExtractedSide =
  | { kind: "values"; texts: string[] }
  | { kind: "unresolved"; reason: string };

/** Convenience constructors, so a caller never hand-builds the union wrong. */
export const values = (texts: string[]): ExtractedSide => ({ kind: "values", texts });
export const unresolved = (reason: string): ExtractedSide => ({ kind: "unresolved", reason });

// ---- results ------------------------------------------------------------------------------

/**
 * The outcomes, and why no two of them are the same thing:
 *
 *  - `passed`            — the check holds. Exactly, for a pinned assertion; approximately, for a
 *                          judged one — {@link AssertionMode} is what says which.
 *  - `relation-false`    — both sides produced a value and the relation does NOT hold. Evidence
 *                          about the APP: the total really doesn't match its rows.
 *  - `extraction-failed` — a side produced no value, so no relation was ever evaluated. Evidence
 *                          about the TEST: a locator missed, or the text read was not a number.
 *  - `judge-failed`      — the fallback judge looked at the page and said the check does not hold
 *                          (slice 11). Evidence about the APP, like `relation-false`, but
 *                          APPROXIMATE — a model's reading, not arithmetic.
 *  - `judge-unavailable` — a judged assertion could not be judged at all: no provider configured,
 *                          or the transport threw. NOTHING was checked, so this must never read as
 *                          a pass and must never read as the app being wrong either. It marks the
 *                          run needs-review — a model outage is not a silent green.
 *
 * Slice 10 wires the consequence (an extraction failure is a repairable locator problem, a false
 * relation is not); this package's job is to make the distinction impossible to lose.
 */
export type AssertionOutcome =
  | "passed"
  | "relation-false"
  | "extraction-failed"
  | "judge-failed"
  | "judge-unavailable";

/**
 * HOW an assertion was evaluated — the author-facing half of slice 11.
 *
 * `pinned` is exact: two extractions and a relation, decided in the worker with no model call.
 * `judged` is approximate: a model looked at the page and answered the check in prose. Both can
 * fail a run, and an author has to be able to tell them apart at a glance — an approximate check
 * silently wearing an exact one's clothes is how someone discovers months later that "the totals
 * are right" was never really being verified.
 */
export type AssertionMode = "pinned" | "judged";

/** Why extraction failed — the sub-distinction slice 10 keys on. Null unless `extraction-failed`. */
export type ExtractionCause =
  /** The target did not resolve: nothing on the page to read. A LOCATOR problem. */
  | "unresolved"
  /** The text was read but could not become the value the coercion asked for (e.g. "n/a" as a
   *  number), or the relation needs a kind of value this side cannot supply. A DEFINITION problem. */
  | "coercion";

export type CoercedValue = string | number | boolean;

/** Which side of a comparison an extraction failure happened on. */
export type AssertionSideName = "left" | "right";

export interface AssertionEvaluation {
  outcome: AssertionOutcome;
  /** Which machinery produced this verdict — exact (`pinned`) or approximate (`judged`). */
  mode: AssertionMode;
  cause: ExtractionCause | null;
  /**
   * Which side failed to extract — the side whose TARGET slice 10 re-pins. Null for every other
   * outcome, and for a `coercion` failure the relation raised over both values at once.
   *
   * Recorded here rather than re-derived later, and that matters: the repair path needs the exact
   * fingerprint that missed to derive a cluster key, and "left or right?" recovered by guessing
   * would scatter one broken locator across two clusters.
   */
  side: AssertionSideName | null;
  /** The coerced values compared, or null for a side that produced none. */
  left: CoercedValue | null;
  right: CoercedValue | null;
  /** One line, always present: what was compared and what happened. Shown to a human verbatim. */
  detail: string;
  /**
   * The judge's own rationale for a `judged` verdict, shown beside the check text on run detail.
   * Null for every pinned evaluation — a pinned assertion's `detail` IS its reasoning, and there
   * is no second, softer account of it to give.
   */
  reasoning: string | null;
}

/** An evaluated assertion — its identity and text, plus the verdict. */
export interface AssertionResult extends AssertionEvaluation {
  assertionId: string;
  check: string;
}

// ---- coercion -----------------------------------------------------------------------------

type Coerced = { ok: true; value: CoercedValue } | { ok: false; cause: ExtractionCause; detail: string };

/**
 * Parse a number out of display text: `"1,234.50"`, `"$1,234"`, `"12%"`, `"(45)"` (accounting
 * negative) all read as numbers. Returns null when the text simply isn't one — `"n/a"`, `"—"`, "".
 *
 * Deliberately Anglophone: `,` is a thousands separator and `.` the decimal mark. A locale that
 * inverts them would need a declared locale on the assertion, which is not this slice.
 */
export function parseNumeric(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const accountingNegative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed
    .replace(/[()]/g, "")
    .replace(/[\s  ]/g, "")
    .replace(/[$£€¥%]/g, "")
    .replace(/,/g, "")
    // A unicode minus / en-dash used as a sign.
    .replace(/^[−‒–]/, "-");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return accountingNegative ? -Math.abs(n) : n;
}

/** Collapse the whitespace display text arrives with, so `eq` on text isn't a formatting lottery. */
function normalizeText(raw: string): string {
  return raw.replace(/[\s ]+/g, " ").trim();
}

/**
 * Apply a coercion to what the runner read.
 *
 * The asymmetry worth knowing: `count` and `exists` are TOTAL — zero matches is the answer `0` /
 * `false`, never a failure. Every other coercion needs at least one value, and `text` / `number`
 * need exactly one: a fingerprint that resolved to three elements has not identified "the total",
 * and quietly reading the first would be a wrong answer dressed as a right one.
 */
export function coerce(side: ExtractedSide, as: Coercion): Coerced {
  // `exists` and `count` are answers ABOUT resolution, so they still need the runner to have been
  // able to look. An unreachable frame is not "it doesn't exist".
  if (side.kind === "unresolved") {
    return { ok: false, cause: "unresolved", detail: side.reason };
  }
  const texts = side.texts;
  switch (as) {
    case "exists":
      return { ok: true, value: texts.length > 0 };
    case "count":
      return { ok: true, value: texts.length };
    case "text": {
      if (texts.length === 0) {
        return { ok: false, cause: "unresolved", detail: "nothing matched, so there is no text to read" };
      }
      if (texts.length > 1) {
        return {
          ok: false,
          cause: "coercion",
          detail: `${texts.length} elements matched — a text comparison needs exactly one (use count or sum-number for a set)`,
        };
      }
      return { ok: true, value: normalizeText(texts[0]) };
    }
    case "number": {
      if (texts.length === 0) {
        return { ok: false, cause: "unresolved", detail: "nothing matched, so there is no number to read" };
      }
      if (texts.length > 1) {
        return {
          ok: false,
          cause: "coercion",
          detail: `${texts.length} elements matched — a number comparison needs exactly one (use sum-number for a set)`,
        };
      }
      const n = parseNumeric(texts[0]);
      if (n == null) {
        return {
          ok: false,
          cause: "coercion",
          detail: `read "${normalizeText(texts[0])}", which is not a number`,
        };
      }
      return { ok: true, value: n };
    }
    case "sum-number": {
      if (texts.length === 0) {
        return { ok: false, cause: "unresolved", detail: "nothing matched, so there is nothing to sum" };
      }
      let total = 0;
      for (const t of texts) {
        const n = parseNumeric(t);
        if (n == null) {
          // One unparseable row makes the SUM wrong, so it fails loudly rather than summing the
          // rest — a total silently short by one row is the exact bug assertions exist to catch.
          return {
            ok: false,
            cause: "coercion",
            detail: `one of the ${texts.length} matched values read "${normalizeText(t)}", which is not a number`,
          };
        }
        total += n;
      }
      return { ok: true, value: total };
    }
  }
}

// ---- relations ----------------------------------------------------------------------------

/** Render a coerced value the way the detail line and the UI show it. */
export function displayValue(value: CoercedValue | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "present" : "absent";
  if (typeof value === "number") return String(value);
  return `"${value}"`;
}

/** Boolean-ish reading of a value, so `exists` can be compared to `true` / `"true"` / `1`. */
function asBoolean(value: CoercedValue): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  const t = value.trim().toLowerCase();
  if (t === "true" || t === "yes") return true;
  if (t === "false" || t === "no") return false;
  return null;
}

/** Text reading of a value, for `contains` and for text equality. */
function asText(value: CoercedValue): string {
  return typeof value === "boolean" ? (value ? "present" : "absent") : String(value);
}

const SYMBOL: Record<Relation, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  "non-empty": "is non-empty",
};

/** Is this value "non-empty" for the unary relation? */
function isNonEmpty(value: CoercedValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return value.trim().length > 0;
}

/**
 * Apply a relation to two coerced values.
 *
 * Tolerance semantics, stated once so the tests and the UI agree:
 *  - `eq`  passes when `|left - right| <= tolerance`; `neq` is its exact negation, so a pair
 *    WITHIN tolerance is "equal" to both relations — a `neq` inside the slack fails.
 *  - the ordering relations widen the passing side by `tolerance`: `gt` → `left > right - t`,
 *    `gte` → `left >= right - t`, `lt` → `left < right + t`, `lte` → `left <= right + t`. A
 *    measurement just barely on the wrong side of the boundary is not a failure.
 *
 * Returns `null` when the relation cannot be applied to these values at all (an ordering relation
 * on text) — a definition problem, reported as `extraction-failed` / `coercion` by the caller
 * rather than as the app being wrong.
 */
export function applyRelation(
  relation: Relation,
  left: CoercedValue,
  right: CoercedValue | null,
  tolerance = 0,
): { held: boolean } | { unusable: string } {
  if (relation === "non-empty") return { held: isNonEmpty(left) };
  if (right === null) return { unusable: `"${relation}" needs a right-hand side` };

  const ln = typeof left === "number" ? left : null;
  const rn = typeof right === "number" ? right : null;

  switch (relation) {
    case "eq":
    case "neq": {
      // Numbers compare numerically (with slack); booleans compare as booleans; anything else
      // compares as normalized text. A number vs its own text form ("60" vs 60) is deliberately
      // equal — the page is text and the literal is typed, and pedantry there is a false failure.
      let same: boolean;
      if (ln != null && rn != null) {
        same = Math.abs(ln - rn) <= tolerance;
      } else if (typeof left === "boolean" || typeof right === "boolean") {
        const lb = asBoolean(left);
        const rb = asBoolean(right);
        if (lb == null || rb == null) {
          return { unusable: `cannot compare ${displayValue(left)} with ${displayValue(right)}` };
        }
        same = lb === rb;
      } else if (ln != null || rn != null) {
        const other = ln != null ? right : left;
        const parsed = parseNumeric(asText(other));
        same =
          parsed != null
            ? Math.abs((ln ?? rn ?? 0) - parsed) <= tolerance
            : asText(left) === asText(right);
      } else {
        same = asText(left) === asText(right);
      }
      return { held: relation === "eq" ? same : !same };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      // Ordering is numeric only. A text side that happens to hold a number is accepted (a
      // literal is typed by hand, and `"60"` meaning 60 is the author's obvious intent).
      const l = ln ?? parseNumeric(asText(left));
      const r = rn ?? parseNumeric(asText(right));
      if (l == null || r == null) {
        return {
          unusable: `"${SYMBOL[relation]}" compares numbers, and ${
            l == null ? displayValue(left) : displayValue(right)
          } is not one`,
        };
      }
      if (relation === "gt") return { held: l > r - tolerance };
      if (relation === "gte") return { held: l >= r - tolerance };
      if (relation === "lt") return { held: l < r + tolerance };
      return { held: l <= r + tolerance };
    }
    case "contains":
      return { held: asText(left).includes(asText(right)) };
  }
}

// ---- evaluation ---------------------------------------------------------------------------

/** What the runner hands the engine: the extracted side(s) for one pinned assertion. */
export interface ExtractedSides {
  left: ExtractedSide;
  /** Absent for a literal right-hand side, and for a unary relation. */
  right?: ExtractedSide;
}

/**
 * Evaluate one pinned assertion over already-extracted values. Pure: no page, no network, no model.
 *
 * The order of checks is the safety story. Extraction is settled for BOTH sides first, and only if
 * both produced a value is the relation applied — so `relation-false` can only ever mean "both
 * values were read, and they disagree".
 */
export function evaluatePinned<T>(
  pinned: PinnedAssertion<T>,
  sides: ExtractedSides,
): AssertionEvaluation {
  const unary = isUnaryRelation(pinned.relation);
  const symbol = SYMBOL[pinned.relation];
  /** Everything a pinned verdict carries regardless of how it went: it was decided exactly, and
   *  there is no model prose to show. Factored for the same reason {@link evaluateJudged} factors
   *  its own — five return sites repeating two constants is five chances to disagree. */
  const base = { mode: "pinned" as const, reasoning: null };

  const leftCoerced = coerce(sides.left, pinned.left.as);
  if (!leftCoerced.ok) {
    return {
      ...base,
      outcome: "extraction-failed",
      cause: leftCoerced.cause,
      side: "left",
      left: null,
      right: null,
      detail: `couldn't read the left-hand value: ${leftCoerced.detail}`,
    };
  }

  // The right-hand side: a literal needs no extraction, a unary relation has none, and a target
  // side needs the runner to have supplied one.
  let right: CoercedValue | null = null;
  if (!unary) {
    if ("literal" in pinned.right) {
      right = pinned.right.literal;
    } else {
      if (!sides.right) {
        return {
          ...base,
          outcome: "extraction-failed",
          cause: "unresolved",
          side: "right",
          left: leftCoerced.value,
          right: null,
          detail: "couldn't read the right-hand value: it was never extracted",
        };
      }
      const rightCoerced = coerce(sides.right, pinned.right.as);
      if (!rightCoerced.ok) {
        return {
          ...base,
          outcome: "extraction-failed",
          cause: rightCoerced.cause,
          side: "right",
          left: leftCoerced.value,
          right: null,
          detail: `couldn't read the right-hand value: ${rightCoerced.detail}`,
        };
      }
      right = rightCoerced.value;
    }
  }

  const tolerance = isNumericRelation(pinned.relation) ? (pinned.tolerance ?? 0) : 0;
  const applied = applyRelation(pinned.relation, leftCoerced.value, right, tolerance);
  if ("unusable" in applied) {
    return {
      ...base,
      outcome: "extraction-failed",
      cause: "coercion",
      // The relation could not use the pair, so neither side is individually at fault — and a
      // `coercion` failure is not repairable anyway (slice 10), so there is no target to name.
      side: null,
      left: leftCoerced.value,
      right,
      detail: applied.unusable,
    };
  }

  const slack = tolerance > 0 ? ` (± ${tolerance})` : "";
  const comparison = unary
    ? `${displayValue(leftCoerced.value)} ${symbol}`
    : `${displayValue(leftCoerced.value)} ${symbol} ${displayValue(right)}${slack}`;
  return {
    ...base,
    outcome: applied.held ? "passed" : "relation-false",
    cause: null,
    side: null,
    left: leftCoerced.value,
    right,
    detail: applied.held ? comparison : `${comparison} — it does not`,
  };
}

/** {@link evaluatePinned} for a whole declared assertion, carrying its identity into the result. */
export function evaluateAssertion<T>(
  declared: Assertion<T>,
  sides: ExtractedSides,
): AssertionResult {
  if (!declared.pinned) {
    throw new Error(
      `assertion "${declared.id}" has no pinned form — evaluate it with evaluateJudged (slice 11), not as a pinned relation`,
    );
  }
  return {
    assertionId: declared.id,
    check: declared.check,
    ...evaluatePinned(declared.pinned, sides),
  };
}

// ---- the judge fallback (slice 11) ---------------------------------------------------------

/**
 * What the caller got back from the judge for an unpinnable assertion.
 *
 * Structural on purpose: this package stays free of `@varys/judge-engine` (and therefore of every
 * transport it can reach), exactly as it stays free of Playwright. The runner does the calling and
 * hands the answer — or the failure — back here to be turned into a result.
 */
export type JudgedVerdict =
  | { ok: true; verdict: "pass" | "fail"; reasoning: string }
  /** The judge could not answer: no provider configured, or the transport threw. */
  | { ok: false; error: string };

/**
 * Turn a judge's answer into an assertion evaluation (Slice 19, slice 11).
 *
 * Not every check reduces to two extractions and a relation. "The chart looks reasonable" cannot be
 * pinned, and the honest answer is to judge it rather than to pretend. This is where that honesty
 * is enforced, and the asymmetry is the whole point:
 *
 *  - `pass` → `passed`, with `mode: "judged"` so nothing downstream can mistake an approximate
 *    green for an exact one.
 *  - `fail` → `judge-failed`. It fails the run, like any other failing assertion.
 *  - a THROW → `judge-unavailable`, never a pass. A model outage must not manufacture a green, and
 *    it must not manufacture a red either — nothing was checked, so the run is needs-review and a
 *    human looks.
 *
 * Note the deliberate boundary the fallback lives inside: a judge reading `$1,203,441` off an image
 * and summing a 40-row column is exactly where a model hallucinates. The fallback is for
 * QUALITATIVE checks; the pinned vocabulary is for quantitative ones (see {@link PINNABLE_CHECK_HELP}).
 */
export function evaluateJudged(answer: JudgedVerdict): AssertionEvaluation {
  const base = { mode: "judged" as const, cause: null, side: null, left: null, right: null };
  if (!answer.ok) {
    return {
      ...base,
      outcome: "judge-unavailable",
      detail: `this check has no pinned form and could not be judged: ${answer.error}`,
      reasoning: null,
    };
  }
  return {
    ...base,
    outcome: answer.verdict === "pass" ? "passed" : "judge-failed",
    detail:
      answer.verdict === "pass"
        ? "judged: the check holds (approximate — no pinned form, so a model read the page)"
        : "judged: the check does not hold (approximate — no pinned form, so a model read the page)",
    reasoning: answer.reasoning,
  };
}

/** {@link evaluateJudged} for a whole declared assertion, carrying its identity into the result. */
export function evaluateJudgedAssertion<T>(
  declared: Assertion<T>,
  answer: JudgedVerdict,
): AssertionResult {
  return {
    assertionId: declared.id,
    check: declared.check,
    ...evaluateJudged(answer),
  };
}

/**
 * What the pinned vocabulary CAN express, in the words an author needs to rephrase a check that
 * fell back to the judge (Slice 19, slice 11).
 *
 * The surface that shows an assertion as "approximate" has to also say what would make it exact,
 * or the badge is a shrug. Lives here because the vocabulary lives here: a help string maintained
 * beside the editor would drift the first time a coercion is added.
 */
export const PINNABLE_CHECK_HELP =
  "A check can be pinned when it compares two things: something read off the page on the left, " +
  `against another element or a fixed value on the right. Each side is read as one of ${coercionSchema.options.join(", ")}, ` +
  `and the two are compared with one of ${relationSchema.options.join(", ")} (numeric comparisons may carry a tolerance). ` +
  "Rephrase towards that shape — \"the total equals the sum of the amount column\" pins; \"the page looks right\" " +
  "does not. A check that is genuinely qualitative is meant to be judged, and leaving it approximate is the honest answer.";

/**
 * Did this outcome FAIL — as in, the run is red because of it?
 *
 * `judge-unavailable` is deliberately not a failure: nothing was checked, so there is no finding to
 * be red about. It is the one outcome that is neither a pass nor a failure, and collapsing it into
 * either is how a model outage becomes a silent green (or a fake bug report).
 */
export function isAssertionFailure(outcome: AssertionOutcome): boolean {
  return outcome !== "passed" && outcome !== "judge-unavailable";
}

/** Did any assertion of this run fail? The one definition of "a failing assertion fails the run". */
export function anyAssertionFailed(results: AssertionResult[]): boolean {
  return results.some((r) => isAssertionFailure(r.outcome));
}

/**
 * One line summarising a run's assertion failures, for `runs.error` — what a reviewer sees before
 * they open anything. Names the assertions rather than dumping every detail.
 */
export function summarizeAssertionFailures(results: AssertionResult[]): string | null {
  const failed = results.filter((r) => isAssertionFailure(r.outcome));
  if (failed.length === 0) return null;
  const parts = failed.map((r) => {
    const what =
      r.outcome === "extraction-failed"
        ? "couldn't be checked"
        : r.outcome === "judge-failed"
          ? "was judged false"
          : "is false";
    return `"${r.check}" ${what} (${r.detail})`;
  });
  const head =
    failed.length === 1 ? "1 assertion failed" : `${failed.length} assertions failed`;
  return `${head}: ${parts.join("; ")}`;
}

/**
 * One line for the assertions that went UNCHECKED — what a reviewer sees on the amber run a judge
 * outage produces. Deliberately worded as "not checked" rather than "failed": the run is silent
 * about these, and a summary that implied otherwise would invent a verdict nobody reached.
 */
export function summarizeUncheckedAssertions(results: AssertionResult[]): string | null {
  const unchecked = results.filter((r) => r.outcome === "judge-unavailable");
  if (unchecked.length === 0) return null;
  const parts = unchecked.map((r) => `"${r.check}" (${r.detail})`);
  const head =
    unchecked.length === 1
      ? "1 assertion could not be judged"
      : `${unchecked.length} assertions could not be judged`;
  return `${head}: ${parts.join("; ")}`;
}

// ---- repairability (slice 10) --------------------------------------------------------------

/**
 * What a failing assertion may have DONE to it — the safety property slice 10 makes executable.
 *
 * The three values are not degrees of severity, they are three different owners:
 *
 *  - `repairable`   — the extraction target no longer resolves. That is a **locator** failure and
 *                     nothing else: the app was never asked a question, so it cannot have answered
 *                     wrongly. Repairable exactly like a broken step locator.
 *  - `app-failure`  — both sides were read and the relation is false. **Never** repairable: under
 *                     any policy, at any threshold, by any agent. Repairing it would mean re-pinning
 *                     until the numbers agree, which is a machine for hiding the exact bugs
 *                     assertions exist to catch.
 *  - `definition-failure` — a value was read but could not become what the coercion asked for
 *                     (`"n/a"` as a number), or the relation cannot use the pair. The ASSERTION is
 *                     wrong, not its locator and not the app — re-pinning would not address it, so
 *                     it is not repairable either. It earns a diagnosis.
 */
export type AssertionRepairability =
  | "repairable"
  | "app-failure"
  | "definition-failure"
  /**
   * The judge could not be reached, so the assertion has no verdict at all (slice 11). Not a
   * repair (nothing is broken about the locator), and not a diagnosis either (there is nothing to
   * diagnose — the model was down). It earns NO job; the run goes needs-review and a human looks.
   */
  | "unavailable";

/** The narrow shape the repairability question is asked of — so the runner (which holds full
 *  results) and the API (which holds `run_assertions` rows) ask it of the same predicate rather
 *  than growing two that can drift. */
export interface AssertionVerdictShape {
  outcome: AssertionOutcome;
  cause: ExtractionCause | null;
}

/** Where a failing assertion belongs. Null for one that passed. */
export function assertionRepairability(
  result: AssertionVerdictShape,
): AssertionRepairability | null {
  if (result.outcome === "passed") return null;
  if (result.outcome === "judge-unavailable") return "unavailable";
  // A judged `fail` is the app's, exactly as a false relation is — only approximately so. Repairing
  // it would mean re-pinning until the model agrees, which is the same machine for hiding bugs.
  if (result.outcome === "relation-false" || result.outcome === "judge-failed") return "app-failure";
  return result.cause === "unresolved" ? "repairable" : "definition-failure";
}

/** Whether this failing assertion is the ONE class a repair may touch. The single predicate the
 *  enqueue path, the manual-enqueue endpoint and the runner all decide from. */
export function isRepairableAssertionFailure(result: AssertionVerdictShape): boolean {
  return assertionRepairability(result) === "repairable";
}

/** What a run's assertion failures earn from the repair queue (slice 10). */
export type AssertionConsequence =
  /** Nothing failed. */
  | "none"
  /** Every failure is an unresolved extraction target: a locator problem, so a Repair Job. */
  | "repair"
  /** At least one failure is the app's or the definition's: a read-only Triage Job, never a repair. */
  | "triage";

export interface AssertionFailureVerdict {
  consequence: AssertionConsequence;
  /** Failures whose extraction target no longer resolves, in declaration order. */
  repairable: AssertionResult[];
  /** Failures no repair may ever touch — a false relation, a judged fail, or an unusable value. */
  unrepairable: AssertionResult[];
  /**
   * Assertions that reached no verdict because the judge was unreachable (slice 11). They earn no
   * job of either kind — there is nothing to repair and nothing to diagnose — but they are carried
   * here rather than dropped, because the run status turns on whether any exist.
   */
  unavailable: AssertionResult[];
}

/**
 * The run-level consequence of a run's assertion results (Slice 19, slice 10).
 *
 * **One unrepairable failure suppresses repair for the whole run, deliberately.** A run carrying
 * both a false relation and a missing target is a run whose app is known to be wrong; re-pinning
 * the missing target there would write a version, queue a re-run, and produce a repair whose
 * evidence is a still-red run — while the far more important finding (the numbers disagree) went
 * to the one job that is allowed to say so. Erring towards the read-only job costs a human an
 * override; erring the other way is how a corpus gets rewritten into agreement with a bug.
 */
export function assertionFailureVerdict(results: AssertionResult[]): AssertionFailureVerdict {
  const repairable: AssertionResult[] = [];
  const unrepairable: AssertionResult[] = [];
  const unavailable: AssertionResult[] = [];
  for (const r of results) {
    const where = assertionRepairability(r);
    if (where === "repairable") repairable.push(r);
    else if (where === "unavailable") unavailable.push(r);
    else if (where !== null) unrepairable.push(r);
  }
  const consequence: AssertionConsequence =
    unrepairable.length > 0 ? "triage" : repairable.length > 0 ? "repair" : "none";
  return { consequence, repairable, unrepairable, unavailable };
}

/**
 * The target of one side of one assertion's pinned form — the fingerprint a repair re-pins.
 *
 * Every consumer of the slice-10 distinction needs this same walk (the runner at enqueue time, the
 * breaker census, the by-hand enqueue endpoint, the cluster fan-out), and each of them holds `side`
 * as untrusted text: a `run_assertions` column, or a value off the wire. So the walk and the
 * left/right validation live here, once. Three copies of it is exactly the drift this package's
 * `AssertionOutcome` comment warns about — a side recovered differently in two places derives two
 * cluster keys for one broken element.
 *
 * Undefined when there is nothing to re-pin: no such assertion, no pinned form, no side named (a
 * `coercion` failure blames the definition rather than a target), or a side that is a LITERAL,
 * which has no locator by construction.
 *
 * Target-agnostic like the rest of the package: it navigates the pinned form and never looks INTO
 * a target.
 */
export function pinnedSideTarget<TTarget>(
  assertions: readonly Assertion<TTarget>[] | undefined,
  assertionId: string,
  side: string | null | undefined,
): TTarget | undefined {
  if (side !== "left" && side !== "right") return undefined;
  const pinned = (assertions ?? []).find((a) => a.id === assertionId)?.pinned;
  if (!pinned) return undefined;
  const which = side === "left" ? pinned.left : pinned.right;
  return "target" in which ? which.target : undefined;
}

/**
 * Why a false relation is refused a repair, in the words a human (or an agent that asked for one
 * by hand) reads. One string, in one place: the refusal is a property of the system, and three
 * call sites wording it three ways would read as three different rules.
 */
export const RELATION_FALSE_NEVER_REPAIRABLE =
  "both values were read and they disagree, which is evidence about the APP, not about the locator. " +
  "A false assertion is never repairable — under any policy, at any threshold, by any agent — because " +
  "repairing it would mean re-pinning until the numbers agree, and that hides the exact bugs assertions " +
  "exist to catch. Fix the application, or change the assertion by hand if the check itself is wrong.";

/** The same, for a judged assertion the model failed. Approximate evidence is still evidence
 *  about the APP, and a repair that re-pins until a model agrees hides the same bugs. */
export const JUDGE_FAILED_NEVER_REPAIRABLE =
  "this assertion has no pinned form, so a model read the page and answered the check — and it answered no. " +
  "That is (approximate) evidence about the APP, not about a locator, so no repair may touch it. Fix the " +
  "application, or pin the check so it is evaluated exactly instead of judged.";

/** The same, for a failure whose value could not be coerced: re-pinning addresses nothing. */
export const COERCION_NEVER_REPAIRABLE =
  "a value was read but could not be used as the assertion asked (a number that isn't one, or a relation " +
  "that cannot compare the pair). That is the assertion's definition, not its locator, so re-pinning would " +
  "not address it — edit the assertion instead.";
