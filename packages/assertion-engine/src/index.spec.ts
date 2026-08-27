import { describe, expect, it } from "vitest";
import {
  type Assertion,
  type Coercion,
  type ExtractedSide,
  type PinnedAssertion,
  type Relation,
  anyAssertionFailed,
  assertion,
  assertionFailureVerdict,
  assertionRepairability,
  isRepairableAssertionFailure,
  pinnedSideTarget,
  coerce,
  evaluateAssertion,
  evaluateJudgedAssertion,
  evaluatePinned,
  PINNABLE_CHECK_HELP,
  parseNumeric,
  pinnedAssertion,
  summarizeAssertionFailures,
  summarizeUncheckedAssertions,
  unresolved,
  values,
} from "./index";

/** A pinned assertion over opaque targets — the engine never looks at them. */
function pin(
  leftAs: Coercion,
  relation: Relation,
  right: PinnedAssertion["right"],
  tolerance?: number,
): PinnedAssertion {
  return {
    kind: "relation",
    left: { target: { pretend: "left" }, as: leftAs },
    right,
    relation,
    ...(tolerance === undefined ? {} : { tolerance }),
  };
}

const literal = (v: string | number) => ({ literal: v });

describe("the pinned form is data, and the schema is the vocabulary", () => {
  it("accepts a fully pinned relation", () => {
    const parsed = pinnedAssertion.parse({
      kind: "relation",
      left: { target: { testId: "total" }, as: "number" },
      right: { target: { testId: "row-amount" }, as: "sum-number" },
      relation: "eq",
      tolerance: 0.01,
    });
    expect(parsed.relation).toBe("eq");
  });

  it("rejects a relation, coercion or tolerance outside the vocabulary Varys owns", () => {
    expect(() => pinnedAssertion.parse({ ...basePinned(), relation: "roughly" })).toThrow();
    expect(() =>
      pinnedAssertion.parse({ ...basePinned(), left: { target: {}, as: "average" } }),
    ).toThrow();
    expect(() => pinnedAssertion.parse({ ...basePinned(), tolerance: -1 })).toThrow();
  });

  it("refuses a tolerance on a relation that would silently ignore it", () => {
    expect(() =>
      pinnedAssertion.parse({ ...basePinned(), relation: "contains", tolerance: 2 }),
    ).toThrow(/numeric relations only/);
    expect(() =>
      pinnedAssertion.parse({ ...basePinned(), relation: "non-empty", tolerance: 2 }),
    ).toThrow(/numeric relations only/);
  });

  it("requires a stable, boring assertion id and some plain-language check text", () => {
    expect(assertion.parse({ id: "total-matches-sum", check: "the total adds up" }).pinned).toBeUndefined();
    expect(() => assertion.parse({ id: "", check: "x" })).toThrow();
    expect(() => assertion.parse({ id: "has spaces", check: "x" })).toThrow();
    expect(() => assertion.parse({ id: "ok", check: "" })).toThrow();
  });

  function basePinned() {
    return {
      kind: "relation",
      left: { target: {}, as: "number" },
      right: { literal: 1 },
      relation: "eq",
    };
  }
});

// ---- the matrix ---------------------------------------------------------------------------

/** One extracted left side per coercion, each producing a known value. */
const LEFT: Record<Coercion, { side: ExtractedSide; value: string | number | boolean }> = {
  text: { side: values(["60"]), value: "60" },
  number: { side: values(["$60.00"]), value: 60 },
  "sum-number": { side: values(["10", "20", "30"]), value: 60 },
  count: { side: values(["row", "row", "row"]), value: 3 },
  exists: { side: values(["anything"]), value: true },
};

/**
 * For each (coercion, relation): a right-hand side that makes the relation HOLD, and one that
 * makes it false. `unusable: true` marks the four pairings that cannot be applied at all —
 * ordering an `exists` boolean — which are reported as extraction failures, never as the app
 * being wrong.
 */
const MATRIX: Record<
  Coercion,
  Record<Relation, { holds: PinnedAssertion["right"]; fails: PinnedAssertion["right"]; unusable?: true }>
> = {
  text: {
    eq: { holds: literal("60"), fails: literal("61") },
    neq: { holds: literal("61"), fails: literal("60") },
    gt: { holds: literal(59), fails: literal(61) },
    gte: { holds: literal(60), fails: literal(61) },
    lt: { holds: literal(61), fails: literal(59) },
    lte: { holds: literal(60), fails: literal(59) },
    contains: { holds: literal("6"), fails: literal("7") },
    "non-empty": { holds: literal(""), fails: literal("") },
  },
  number: {
    eq: { holds: literal(60), fails: literal(61) },
    neq: { holds: literal(61), fails: literal(60) },
    gt: { holds: literal(59), fails: literal(60) },
    gte: { holds: literal(60), fails: literal(61) },
    lt: { holds: literal(61), fails: literal(60) },
    lte: { holds: literal(60), fails: literal(59) },
    contains: { holds: literal("6"), fails: literal("7") },
    "non-empty": { holds: literal(""), fails: literal("") },
  },
  "sum-number": {
    eq: { holds: literal(60), fails: literal(59) },
    neq: { holds: literal(59), fails: literal(60) },
    gt: { holds: literal(59), fails: literal(60) },
    gte: { holds: literal(60), fails: literal(61) },
    lt: { holds: literal(61), fails: literal(60) },
    lte: { holds: literal(60), fails: literal(59) },
    contains: { holds: literal("60"), fails: literal("61") },
    "non-empty": { holds: literal(""), fails: literal("") },
  },
  count: {
    eq: { holds: literal(3), fails: literal(4) },
    neq: { holds: literal(4), fails: literal(3) },
    gt: { holds: literal(2), fails: literal(3) },
    gte: { holds: literal(3), fails: literal(4) },
    lt: { holds: literal(4), fails: literal(3) },
    lte: { holds: literal(3), fails: literal(2) },
    contains: { holds: literal("3"), fails: literal("4") },
    "non-empty": { holds: literal(""), fails: literal("") },
  },
  exists: {
    eq: { holds: literal("true"), fails: literal("false") },
    neq: { holds: literal("false"), fails: literal("true") },
    gt: { holds: literal(0), fails: literal(0), unusable: true },
    gte: { holds: literal(0), fails: literal(0), unusable: true },
    lt: { holds: literal(0), fails: literal(0), unusable: true },
    lte: { holds: literal(0), fails: literal(0), unusable: true },
    contains: { holds: literal("present"), fails: literal("absent") },
    "non-empty": { holds: literal(""), fails: literal("") },
  },
};

const COERCIONS = Object.keys(MATRIX) as Coercion[];
const RELATIONS = Object.keys(MATRIX.text) as Relation[];

describe("every coercion × relation pairing", () => {
  for (const as of COERCIONS) {
    for (const relation of RELATIONS) {
      const cell = MATRIX[as][relation];
      it(`${as} ${relation}`, () => {
        const held = evaluatePinned(pin(as, relation, cell.holds), { left: LEFT[as].side });
        if (cell.unusable) {
          // An ordering comparison on "does it exist" is a DEFINITION mistake, so it reports as an
          // extraction failure — never as the application disagreeing with itself.
          expect(held.outcome).toBe("extraction-failed");
          expect(held.cause).toBe("coercion");
          return;
        }
        expect(held).toMatchObject({ outcome: "passed", cause: null, left: LEFT[as].value });

        if (relation === "non-empty") return; // unary: there is no falsifying right-hand side here
        const broken = evaluatePinned(pin(as, relation, cell.fails), { left: LEFT[as].side });
        // Both values were read and they disagree: evidence about the APP.
        expect(broken.outcome).toBe("relation-false");
        expect(broken.cause).toBeNull();
        expect(broken.left).toEqual(LEFT[as].value);
        expect(broken.right).not.toBeNull();
        expect(broken.detail).toContain("it does not");
      });
    }
  }

  it("fails `non-empty` for each coercion's empty value", () => {
    const empty: Record<Coercion, ExtractedSide> = {
      text: values([" "]),
      number: values(["0"]),
      "sum-number": values(["0", "0"]),
      count: values([]),
      exists: values([]),
    };
    for (const as of COERCIONS) {
      const r = evaluatePinned(pin(as, "non-empty", literal("")), { left: empty[as] });
      expect({ as, outcome: r.outcome }).toEqual({ as, outcome: "relation-false" });
    }
  });
});

// ---- tolerance ---------------------------------------------------------------------------

describe("a numeric comparison within tolerance passes; just outside it fails", () => {
  const total = (n: string) => ({ left: values([n]) });

  it("holds eq at exactly the tolerance and fails a hair outside it", () => {
    const eq = (n: string, t: number) => evaluatePinned(pin("number", "eq", literal(100), t), total(n));
    expect(eq("100.5", 0.5).outcome).toBe("passed");
    expect(eq("99.5", 0.5).outcome).toBe("passed");
    expect(eq("100.51", 0.5).outcome).toBe("relation-false");
    expect(eq("99.49", 0.5).outcome).toBe("relation-false");
    // Exact by default — no implicit slack.
    expect(eq("100.0001", undefined as unknown as number).outcome).toBe("relation-false");
  });

  it("makes neq the exact negation of eq, so a pair inside the slack is NOT unequal", () => {
    expect(evaluatePinned(pin("number", "neq", literal(100), 0.5), total("100.4")).outcome).toBe(
      "relation-false",
    );
    expect(evaluatePinned(pin("number", "neq", literal(100), 0.5), total("100.6")).outcome).toBe(
      "passed",
    );
  });

  it("widens the passing side of each ordering relation by the tolerance", () => {
    // gt: left > right - t → 99.6 > 100 - 0.5 passes, 99.4 does not.
    expect(evaluatePinned(pin("number", "gt", literal(100), 0.5), total("99.6")).outcome).toBe("passed");
    expect(evaluatePinned(pin("number", "gt", literal(100), 0.5), total("99.4")).outcome).toBe(
      "relation-false",
    );
    // gte: the boundary itself is inside.
    expect(evaluatePinned(pin("number", "gte", literal(100), 0.5), total("99.5")).outcome).toBe("passed");
    expect(evaluatePinned(pin("number", "gte", literal(100), 0.5), total("99.49")).outcome).toBe(
      "relation-false",
    );
    // lt / lte widen upward.
    expect(evaluatePinned(pin("number", "lt", literal(100), 0.5), total("100.4")).outcome).toBe("passed");
    expect(evaluatePinned(pin("number", "lt", literal(100), 0.5), total("100.5")).outcome).toBe(
      "relation-false",
    );
    expect(evaluatePinned(pin("number", "lte", literal(100), 0.5), total("100.5")).outcome).toBe("passed");
    expect(evaluatePinned(pin("number", "lte", literal(100), 0.5), total("100.51")).outcome).toBe(
      "relation-false",
    );
  });

  it("says the slack out loud in the detail line", () => {
    expect(evaluatePinned(pin("number", "eq", literal(100), 0.5), total("100.2")).detail).toContain(
      "± 0.5",
    );
  });
});

// ---- the distinction the slice exists for -------------------------------------------------

describe("extraction failed is not the same result as relation false", () => {
  it("reports an unresolved LEFT target as extraction-failed / unresolved, comparing nothing", () => {
    const r = evaluatePinned(pin("number", "eq", literal(60)), {
      left: unresolved('could not locate "the total" — no fingerprint signal matched'),
    });
    expect(r).toMatchObject({ outcome: "extraction-failed", cause: "unresolved", left: null, right: null });
    expect(r.detail).toContain("no fingerprint signal matched");
  });

  it("reports an unresolved RIGHT target the same way, keeping the left value it did read", () => {
    const r = evaluatePinned(
      pin("number", "eq", { target: { pretend: "right" }, as: "sum-number" }),
      { left: values(["60"]), right: unresolved("the rows are gone") },
    );
    expect(r).toMatchObject({ outcome: "extraction-failed", cause: "unresolved", left: 60, right: null });
  });

  it("reports a right-hand side the runner never extracted rather than passing on a null", () => {
    const r = evaluatePinned(pin("number", "eq", { target: { pretend: "right" }, as: "number" }), {
      left: values(["60"]),
    });
    expect(r).toMatchObject({ outcome: "extraction-failed", cause: "unresolved" });
    expect(r.detail).toContain("never extracted");
  });

  it("distinguishes a value that was READ but is not a number (a definition problem)", () => {
    const r = evaluatePinned(pin("number", "eq", literal(60)), { left: values(["n/a"]) });
    expect(r).toMatchObject({ outcome: "extraction-failed", cause: "coercion" });
    expect(r.detail).toContain("not a number");
  });

  it("refuses to read 'the total' off a fingerprint that matched three elements", () => {
    for (const as of ["text", "number"] as const) {
      const r = evaluatePinned(pin(as, "eq", literal(60)), { left: values(["10", "20", "30"]) });
      expect(r.outcome).toBe("extraction-failed");
      expect(r.cause).toBe("coercion");
      expect(r.detail).toContain("3 elements matched");
    }
  });

  it("fails a sum loudly when ONE row is unreadable, rather than summing the rest", () => {
    const r = evaluatePinned(pin("sum-number", "eq", literal(30)), {
      left: values(["10", "—", "20"]),
    });
    expect(r).toMatchObject({ outcome: "extraction-failed", cause: "coercion" });
    expect(r.detail).toContain('read "—"');
  });

  it("treats zero matches as a real answer for count and exists, and a failure for the rest", () => {
    expect(coerce(values([]), "count")).toEqual({ ok: true, value: 0 });
    expect(coerce(values([]), "exists")).toEqual({ ok: true, value: false });
    for (const as of ["text", "number", "sum-number"] as const) {
      expect(coerce(values([]), as)).toMatchObject({ ok: false, cause: "unresolved" });
    }
    // …but a side the runner could not even ask about is never "it doesn't exist".
    expect(coerce(unresolved("frame unreachable"), "exists")).toMatchObject({
      ok: false,
      cause: "unresolved",
    });
  });
});

// ---- reading numbers off a page ----------------------------------------------------------

describe("numbers as pages actually render them", () => {
  it.each([
    ["1,234.50", 1234.5],
    ["$1,234", 1234],
    ["12%", 12],
    ["(45)", -45],
    ["-45", -45],
    ["  60  ", 60],
    [".5", 0.5],
    ["1 234", 1234],
  ])("reads %s as %s", (raw, expected) => {
    expect(parseNumeric(raw as string)).toBe(expected);
  });

  it.each(["n/a", "", "—", "12abc", "1.2.3", "-"])("refuses %s", (raw) => {
    expect(parseNumeric(raw)).toBeNull();
  });

  it("compares a page's text against a typed literal without pedantry", () => {
    // The page is text; the literal is typed. "60" meaning 60 is the author's obvious intent.
    expect(evaluatePinned(pin("text", "eq", literal(60)), { left: values(["60"]) }).outcome).toBe(
      "passed",
    );
    expect(evaluatePinned(pin("text", "eq", literal("60")), { left: values(["60 "]) }).outcome).toBe(
      "passed",
    );
  });
});

// ---- results carried back to the run -----------------------------------------------------

describe("an evaluated assertion carries its identity", () => {
  const declared: Assertion = {
    id: "total-matches-sum",
    check: "The total equals the sum of the line items",
    pinned: pin("sum-number", "eq", literal(60)),
  };

  it("names the assertion in the result, so a run can key its history off the id", () => {
    const r = evaluateAssertion(declared, { left: values(["10", "20", "30"]) });
    expect(r).toMatchObject({
      assertionId: "total-matches-sum",
      check: "The total equals the sum of the line items",
      outcome: "passed",
    });
  });

  it("throws rather than inventing a verdict for an unpinned assertion", () => {
    expect(() => evaluateAssertion({ id: "unpinned", check: "someday" }, { left: values([]) })).toThrow(
      /no pinned form/,
    );
  });

  it("summarises the failures for the run, and stays silent when there are none", () => {
    const failed = evaluateAssertion(declared, { left: values(["10", "20"]) });
    const passed = evaluateAssertion(declared, { left: values(["10", "20", "30"]) });
    expect(anyAssertionFailed([failed, passed])).toBe(true);
    expect(anyAssertionFailed([passed])).toBe(false);
    expect(summarizeAssertionFailures([passed])).toBeNull();
    const summary = summarizeAssertionFailures([failed, passed]) ?? "";
    expect(summary).toContain("1 assertion failed");
    expect(summary).toContain("The total equals the sum of the line items");
    expect(summary).toContain("is false");
    // An extraction failure reads as "couldn't be checked", never as the app being wrong.
    const unreadable = evaluateAssertion(declared, { left: unresolved("rows are gone") });
    expect(summarizeAssertionFailures([unreadable]) ?? "").toContain("couldn't be checked");
  });
});

// ---- repairability: the safety property (slice 10) ----------------------------------------

describe("a failing assertion's repairability", () => {
  const declared: Assertion = {
    id: "total-matches-sum",
    check: "The total equals the sum of the line items",
    pinned: pin("number", "eq", { target: { pretend: "right" }, as: "sum-number" }),
  };
  const evaluate = (sides: { left: ExtractedSide; right?: ExtractedSide }) =>
    evaluateAssertion(declared, sides);

  it("records WHICH side failed to extract, so the repair knows which target to re-pin", () => {
    const leftGone = evaluate({ left: unresolved("no match"), right: values(["10"]) });
    expect(leftGone).toMatchObject({ outcome: "extraction-failed", cause: "unresolved", side: "left" });

    const rightGone = evaluate({ left: values(["10"]), right: unresolved("no match") });
    expect(rightGone).toMatchObject({ outcome: "extraction-failed", cause: "unresolved", side: "right" });

    // A right side the runner never extracted at all is still the right side's failure.
    const never = evaluate({ left: values(["10"]) });
    expect(never).toMatchObject({ outcome: "extraction-failed", side: "right" });
  });

  it("leaves `side` null for every outcome that names no single target", () => {
    expect(evaluate({ left: values(["60"]), right: values(["60"]) }).side).toBeNull();
    expect(evaluate({ left: values(["70"]), right: values(["60"]) })).toMatchObject({
      outcome: "relation-false",
      side: null,
    });
    // A value that isn't a number is the DEFINITION's problem, and blames neither target.
    expect(evaluate({ left: values(["n/a"]), right: values(["60"]) })).toMatchObject({
      outcome: "extraction-failed",
      cause: "coercion",
    });
  });

  it("calls an unresolved target repairable, and a false relation never", () => {
    const missing = evaluate({ left: unresolved("no match"), right: values(["10"]) });
    const wrong = evaluate({ left: values(["70"]), right: values(["60"]) });
    const unusable = evaluate({ left: values(["n/a"]), right: values(["60"]) });
    const passed = evaluate({ left: values(["60"]), right: values(["60"]) });

    expect(assertionRepairability(missing)).toBe("repairable");
    expect(assertionRepairability(wrong)).toBe("app-failure");
    expect(assertionRepairability(unusable)).toBe("definition-failure");
    expect(assertionRepairability(passed)).toBeNull();

    expect(isRepairableAssertionFailure(missing)).toBe(true);
    // The one line the whole slice rests on.
    expect(isRepairableAssertionFailure(wrong)).toBe(false);
    expect(isRepairableAssertionFailure(unusable)).toBe(false);
  });

  it("earns a repair only when EVERY failure is an unresolved target", () => {
    const missing = evaluate({ left: unresolved("no match"), right: values(["10"]) });
    const wrong = evaluate({ left: values(["70"]), right: values(["60"]) });
    const passed = evaluate({ left: values(["60"]), right: values(["60"]) });

    expect(assertionFailureVerdict([passed]).consequence).toBe("none");
    expect(assertionFailureVerdict([]).consequence).toBe("none");
    expect(assertionFailureVerdict([missing, passed])).toMatchObject({
      consequence: "repair",
      repairable: [missing],
      unrepairable: [],
    });
    expect(assertionFailureVerdict([wrong])).toMatchObject({
      consequence: "triage",
      repairable: [],
      unrepairable: [wrong],
    });
    // Mixed: the false relation wins. A run whose app is known to be wrong is not a run to
    // repair, however repairable its other failure looks in isolation.
    expect(assertionFailureVerdict([missing, wrong])).toMatchObject({
      consequence: "triage",
      repairable: [missing],
      unrepairable: [wrong],
    });
  });
});

describe("the target a repair re-pins", () => {
  const declared: Assertion[] = [
    {
      id: "total-matches-sum",
      check: "The total equals the sum of the line items",
      pinned: pin("number", "eq", { target: { pretend: "right" }, as: "sum-number" }),
    },
    {
      id: "total-is-positive",
      check: "The total is greater than zero",
      pinned: pin("number", "gt", literal(0)),
    },
    { id: "someday", check: "Someday this will be checked" },
  ];

  it("walks to the named side's target", () => {
    expect(pinnedSideTarget(declared, "total-matches-sum", "left")).toEqual({ pretend: "left" });
    expect(pinnedSideTarget(declared, "total-matches-sum", "right")).toEqual({ pretend: "right" });
  });

  it("has nothing to re-pin for a literal, an unpinned assertion, or no side at all", () => {
    // A literal has no locator by construction.
    expect(pinnedSideTarget(declared, "total-is-positive", "right")).toBeUndefined();
    // Documentation, never evaluated.
    expect(pinnedSideTarget(declared, "someday", "left")).toBeUndefined();
    expect(pinnedSideTarget(declared, "invented", "left")).toBeUndefined();
    expect(pinnedSideTarget(undefined, "total-matches-sum", "left")).toBeUndefined();
  });

  it("refuses a side that is not one, so an untrusted column cannot become a guess", () => {
    // Every caller holds `side` as text off a database column or the wire. A `coercion` failure
    // names no side, and defaulting that to `left` would derive a cluster key for a target that
    // was never the problem.
    expect(pinnedSideTarget(declared, "total-matches-sum", null)).toBeUndefined();
    expect(pinnedSideTarget(declared, "total-matches-sum", "")).toBeUndefined();
    expect(pinnedSideTarget(declared, "total-matches-sum", "LEFT")).toBeUndefined();
  });
});

/**
 * The judge fallback (Slice 19, slice 11).
 *
 * The engine never calls a judge — it turns an ANSWER (or the absence of one) into a result, which
 * is what keeps the whole thing unit-testable with no network and no browser. Every property this
 * slice rests on is decided here: that a judged pass is marked approximate, that a judged fail is
 * a failure like any other, and — the one that matters most — that a judge which could not answer
 * produces neither a pass nor a failure.
 */
describe("an assertion with no pinned form is judged, not skipped", () => {
  const chartLooksRight: Assertion = { id: "chart-ok", check: "The chart looks reasonable" };

  it("marks a judged pass as APPROXIMATE, so it can never be read as an exact one", () => {
    const r = evaluateJudgedAssertion(chartLooksRight, {
      ok: true,
      verdict: "pass",
      reasoning: "bars are rendered and the axis is labelled",
    });
    expect(r.outcome).toBe("passed");
    expect(r.mode).toBe("judged");
    expect(r.reasoning).toBe("bars are rendered and the axis is labelled");
    expect(r.detail).toContain("approximate");
    // Nothing was compared, so there are no values to show and no side to blame.
    expect(r.left).toBeNull();
    expect(r.right).toBeNull();
    expect(r.side).toBeNull();
    expect(r.cause).toBeNull();
    // It carries the assertion's own identity, exactly as a pinned result does — the history strip
    // must span a check that gets pinned later without restarting.
    expect(r.assertionId).toBe("chart-ok");
    expect(r.check).toBe("The chart looks reasonable");
  });

  it("fails the run on a judged fail, and never lets a repair touch it", () => {
    const r = evaluateJudgedAssertion(chartLooksRight, {
      ok: true,
      verdict: "fail",
      reasoning: "the chart area is empty",
    });
    expect(r.outcome).toBe("judge-failed");
    expect(r.mode).toBe("judged");
    expect(r.reasoning).toBe("the chart area is empty");
    // A failing assertion fails the run, whichever machinery reached the verdict.
    expect(anyAssertionFailed([r])).toBe(true);
    expect(assertionFailureVerdict([r]).unavailable.length > 0).toBe(false);
    // …and it is the APP's, approximately — so re-pinning until a model agrees is refused, for the
    // same reason a false relation is.
    expect(assertionRepairability(r)).toBe("app-failure");
    expect(isRepairableAssertionFailure(r)).toBe(false);
  });

  it("turns a judge that could not answer into NEITHER a pass nor a failure", () => {
    const r = evaluateJudgedAssertion(chartLooksRight, { ok: false, error: "429 rate limited" });
    expect(r.outcome).toBe("judge-unavailable");
    expect(r.mode).toBe("judged");
    // The three properties that matter, together: not a pass…
    expect(r.outcome).not.toBe("passed");
    // …not a failure (nothing was checked, so there is nothing to be red about)…
    expect(anyAssertionFailed([r])).toBe(false);
    // …and loud enough that the run cannot quietly go green on it.
    expect(assertionFailureVerdict([r]).unavailable.length > 0).toBe(true);
    // The transport's own words survive, so a reviewer can tell an outage from a misconfiguration.
    expect(r.detail).toContain("429 rate limited");
    expect(r.reasoning).toBeNull();
  });

  it("earns no job of either kind when the judge was unreachable", () => {
    const unavailable = evaluateJudgedAssertion(chartLooksRight, { ok: false, error: "no key" });
    const verdict = assertionFailureVerdict([unavailable]);
    // Nothing to repair (no locator broke) and nothing to diagnose (no verdict was reached). The
    // run goes needs-review and a human looks; manufacturing a triage job here would file a bug
    // report about an application nobody examined.
    expect(verdict.consequence).toBe("none");
    expect(verdict.repairable).toEqual([]);
    expect(verdict.unrepairable).toEqual([]);
    expect(verdict.unavailable).toEqual([unavailable]);
    expect(assertionRepairability(unavailable)).toBe("unavailable");
  });

  it("sends a judged FAIL to triage, exactly as a false relation goes", () => {
    const judged = evaluateJudgedAssertion(chartLooksRight, {
      ok: true,
      verdict: "fail",
      reasoning: "empty",
    });
    const verdict = assertionFailureVerdict([judged]);
    expect(verdict.consequence).toBe("triage");
    expect(verdict.unrepairable).toEqual([judged]);
    expect(verdict.unavailable).toEqual([]);
  });

  it("lets a pinned and a judged assertion on one test both run, and either fail the run", () => {
    const pinnedPass = evaluateAssertion(
      { id: "total", check: "The total adds up", pinned: pin("number", "eq", literal(60.5)) },
      { left: values(["60.50"]) },
    );
    const judgedFail = evaluateJudgedAssertion(chartLooksRight, {
      ok: true,
      verdict: "fail",
      reasoning: "the chart area is empty",
    });
    expect(pinnedPass.outcome).toBe("passed");
    expect(pinnedPass.mode).toBe("pinned");
    // The exact one is green and the approximate one is red, and the run is red: neither kind of
    // check is a second-class one.
    expect(anyAssertionFailed([pinnedPass, judgedFail])).toBe(true);
    const summary = summarizeAssertionFailures([pinnedPass, judgedFail]) ?? "";
    expect(summary).toContain("The chart looks reasonable");
    expect(summary).toContain("was judged false");
    // …and the pinned one that passed is not named as a failure.
    expect(summary).not.toContain("The total adds up");

    // The reverse pairing holds too: an exact failure alongside an approximate pass.
    const pinnedFail = evaluateAssertion(
      { id: "total", check: "The total adds up", pinned: pin("number", "eq", literal(1)) },
      { left: values(["60.50"]) },
    );
    const judgedPass = evaluateJudgedAssertion(chartLooksRight, {
      ok: true,
      verdict: "pass",
      reasoning: "looks fine",
    });
    expect(anyAssertionFailed([pinnedFail, judgedPass])).toBe(true);
  });

  it("summarises unchecked assertions as NOT CHECKED, never as failed", () => {
    const a = evaluateJudgedAssertion(chartLooksRight, { ok: false, error: "timeout" });
    const b = evaluateJudgedAssertion(
      { id: "legend", check: "The legend is readable" },
      { ok: false, error: "timeout" },
    );
    expect(summarizeAssertionFailures([a, b])).toBeNull();
    const note = summarizeUncheckedAssertions([a, b]) ?? "";
    expect(note).toContain("2 assertions could not be judged");
    expect(note).toContain("The chart looks reasonable");
    expect(note).toContain("The legend is readable");
    expect(note).not.toContain("failed");
    // A run with nothing unchecked has nothing to say.
    expect(summarizeUncheckedAssertions([])).toBeNull();
  });

  it("lets a real failure outrank an unreachable judge on the same run", () => {
    // A run carrying both a finding and a gap is a run with a finding: "a failing assertion fails
    // the run" wins over "nothing was checked". The reverse precedence would let one flaky judge
    // call downgrade a genuine red to amber, which is the direction that loses bugs.
    const failed = evaluateJudgedAssertion(chartLooksRight, {
      ok: true,
      verdict: "fail",
      reasoning: "empty",
    });
    const unchecked = evaluateJudgedAssertion(
      { id: "legend", check: "The legend is readable" },
      { ok: false, error: "timeout" },
    );
    expect(anyAssertionFailed([failed, unchecked])).toBe(true);
    expect(assertionFailureVerdict([failed, unchecked]).unavailable.length > 0).toBe(true);
    // …and the summary names only the one a verdict was actually reached on.
    const summary = summarizeAssertionFailures([failed, unchecked]) ?? "";
    expect(summary).toContain("1 assertion failed");
    expect(summary).not.toContain("The legend is readable");
  });

  it("still refuses to evaluate an unpinned assertion down the PINNED path", () => {
    // The two paths are not interchangeable, and a caller that reaches for the wrong one is a bug
    // rather than something to paper over with a default.
    expect(() => evaluateAssertion(chartLooksRight, { left: values(["x"]) })).toThrow(
      /no pinned form/,
    );
  });

  it("tells an author what the vocabulary can express, in terms it actually owns", () => {
    // The help text is generated from the vocabulary rather than written beside the editor, so it
    // cannot fall behind the day a coercion or relation is added.
    for (const c of ["text", "number", "sum-number", "count", "exists"]) {
      expect(PINNABLE_CHECK_HELP).toContain(c);
    }
    for (const r of ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "non-empty"]) {
      expect(PINNABLE_CHECK_HELP).toContain(r);
    }
    expect(PINNABLE_CHECK_HELP).toContain("tolerance");
  });
});

/**
 * `unpinnableReason` (Slice 19, slice 12) — the difference between "nobody tried" and "this was
 * examined and cannot be pinned".
 *
 * Both are the same absent `pinned` field, and they ask opposite things of an author: one is a
 * to-do, the other is a decision they may want to argue with. The field exists so a surface can
 * tell them apart, and the schema exists so it can never claim both at once.
 */
describe("an assertion records WHY it could not be pinned", () => {
  it("accepts a reason on an unpinned assertion", () => {
    const parsed = assertion.parse({
      id: "chart-ok",
      check: "The chart looks reasonable",
      unpinnableReason:
        "'looks reasonable' is a judgement about the whole chart, not a comparison between two values on the page",
    });
    expect(parsed.unpinnableReason).toContain("not a comparison");
    expect(parsed.pinned).toBeUndefined();
  });

  it("leaves it absent for an assertion nobody has examined", () => {
    // Legal, and different: this one is simply unpinned. A surface that showed a reason here would
    // be inventing one.
    const parsed = assertion.parse({ id: "someday", check: "Someday this will be checked" });
    expect(parsed.unpinnableReason).toBeUndefined();
  });

  it("REFUSES an assertion that is both pinned and unpinnable", () => {
    // Two contradictory claims in one record. Refused at the schema, so no surface downstream ever
    // has to decide which half to believe.
    const both = assertion.safeParse({
      id: "total",
      check: "The total adds up",
      pinned: {
        kind: "relation",
        left: { target: { anything: true }, as: "number" },
        right: { literal: 1 },
        relation: "eq",
      },
      unpinnableReason: "could not pin it",
    });
    expect(both.success).toBe(false);
    expect(JSON.stringify(both.error?.issues)).toMatch(/cannot be both pinned and unpinnable/);
  });

  it("refuses an empty reason, which says nothing an author can act on", () => {
    expect(assertion.safeParse({ id: "x", check: "y", unpinnableReason: "" }).success).toBe(false);
  });
});
