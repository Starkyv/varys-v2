import type { Fingerprint } from "@varys/step-schema";
import { describe, expect, it } from "vitest";
import {
  breakerVerdict,
  classifyThrownFailure,
  clusterFailures,
  DEFAULT_BREAKER_THRESHOLD,
  deriveClusterKey,
  type FailureRecord,
  isRepairPolicy,
  isTriageFailureKind,
  normalizeBreakerThreshold,
  REPAIR_POLICIES,
  type RepairPolicy,
  TRIAGE_FAILURE_KINDS,
  triageClusterKey,
} from "./index";

/** A minimal fingerprint — `tag` is the one required signal. */
function fp(over: Partial<Fingerprint> = {}): Fingerprint {
  return { tag: "button", ...over } as Fingerprint;
}

describe("repair policy vocabulary", () => {
  it("admits exactly manual and auto", () => {
    expect(REPAIR_POLICIES).toEqual(["manual", "auto"]);
  });

  it("recognises the two policies and rejects anything else", () => {
    for (const p of REPAIR_POLICIES) expect(isRepairPolicy(p)).toBe(true);
    for (const bad of ["Auto", "AUTO", "off", "", "agentic", null, undefined, 1]) {
      expect(isRepairPolicy(bad)).toBe(false);
    }
  });

  it("narrows to RepairPolicy so a caller can store it", () => {
    const raw: unknown = "auto";
    if (!isRepairPolicy(raw)) throw new Error("expected auto to be a policy");
    const policy: RepairPolicy = raw;
    expect(policy).toBe("auto");
  });
});

describe("deriveClusterKey — strongest signal wins", () => {
  it("prefers a test id over everything else", () => {
    const key = deriveClusterKey(
      fp({
        testId: "save-btn",
        attributes: { id: "save" },
        role: "button",
        accessibleName: "Save changes",
      }),
    );
    expect(key).toBe("testid:save-btn");
  });

  it("falls to a usable element id when there is no test id", () => {
    expect(deriveClusterKey(fp({ attributes: { id: "save" }, role: "button" }))).toBe("id:save");
  });

  it("ignores an id the matcher itself cannot address", () => {
    // Same predicate the locator engine uses: a leading digit is not addressable, and
    // `tippy-<n>` ids are generated per render. Neither may key a cluster.
    expect(deriveClusterKey(fp({ attributes: { id: "9lives" }, accessibleName: "Save" }))).toBe(
      "name:Save",
    );
    expect(deriveClusterKey(fp({ attributes: { id: "tippy-14" }, accessibleName: "Save" }))).toBe(
      "name:Save",
    );
  });

  it("uses role+name when neither id is available", () => {
    expect(deriveClusterKey(fp({ role: "button", accessibleName: "Save changes" }))).toBe(
      "role+name:button|Save changes",
    );
  });

  it("uses the row scope ahead of a bare name", () => {
    expect(
      deriveClusterKey(fp({ scope: { container: "[role=\"row\"]", text: "Acme Inc" }, accessibleName: "Delete" })),
    ).toBe('scope:[role="row"]|Acme Inc');
  });

  it("uses a bare accessible name, then stable classes", () => {
    expect(deriveClusterKey(fp({ accessibleName: "Save changes" }))).toBe("name:Save changes");
    expect(deriveClusterKey(fp({ stableClasses: ["toolbar", "primary"] }))).toBe(
      "class:primary.toolbar",
    );
  });

  it("orders stable classes so recording order cannot split a cluster", () => {
    expect(deriveClusterKey(fp({ stableClasses: ["primary", "toolbar"] }))).toBe(
      deriveClusterKey(fp({ stableClasses: ["toolbar", "primary"] })),
    );
  });
});

describe("deriveClusterKey — one app change, one cluster", () => {
  it("collapses the same recorded signature across different tests", () => {
    // Two tests that recorded the same button: identical strong signal, different
    // page position, different build-hashed classes, different bounding box.
    const a = fp({
      testId: "primary-cta",
      boundingBox: { x: 10, y: 20, width: 100, height: 40 },
      moduleClasses: ["Btn__abc123"],
      domIndex: 0,
      cssPath: "main > div:nth-of-type(1) > button",
    });
    const b = fp({
      testId: "primary-cta",
      boundingBox: { x: 900, y: 4, width: 220, height: 64 },
      moduleClasses: ["Btn__zzz999"],
      domIndex: 3,
      cssPath: "aside > form > button",
    });
    expect(deriveClusterKey(a)).toBe(deriveClusterKey(b));
  });

  it("keeps genuinely different targets in different clusters", () => {
    expect(deriveClusterKey(fp({ testId: "save-btn" }))).not.toBe(
      deriveClusterKey(fp({ testId: "cancel-btn" })),
    );
    expect(deriveClusterKey(fp({ role: "button", accessibleName: "Save" }))).not.toBe(
      deriveClusterKey(fp({ role: "link", accessibleName: "Save" })),
    );
  });

  it("normalises whitespace inside a signal, since a reflow can rewrap a label", () => {
    expect(deriveClusterKey(fp({ accessibleName: "Save   all\n changes" }))).toBe(
      deriveClusterKey(fp({ accessibleName: "Save all changes" })),
    );
  });

  it("does not confuse a name with a role+name of the same rendering", () => {
    expect(deriveClusterKey(fp({ accessibleName: "button|Save" }))).not.toBe(
      deriveClusterKey(fp({ role: "button", accessibleName: "Save" })),
    );
  });
});

describe("deriveClusterKey — no strong signal at all", () => {
  it("still produces a key, deterministically", () => {
    const weak = fp({ tag: "div", text: "Hero", cssPath: "body > div" });
    const key = deriveClusterKey(weak);
    expect(key).toMatch(/^weak:div:[0-9a-f]{12}$/);
    expect(deriveClusterKey(weak)).toBe(key);
  });

  it("separates two weak targets that differ", () => {
    expect(deriveClusterKey(fp({ tag: "div", text: "Hero" }))).not.toBe(
      deriveClusterKey(fp({ tag: "div", text: "Footer" })),
    );
  });

  it("is unaffected by signals that rotate every build or every render", () => {
    const base = { tag: "div", text: "Hero", cssPath: "body > div" } as const;
    expect(
      deriveClusterKey(
        fp({ ...base, moduleClasses: ["x__a1"], boundingBox: { x: 0, y: 0, width: 1, height: 1 } }),
      ),
    ).toBe(
      deriveClusterKey(
        fp({ ...base, moduleClasses: ["x__b2"], boundingBox: { x: 9, y: 9, width: 9, height: 9 } }),
      ),
    );
  });

  it("is bounded in length however long the recorded signals are", () => {
    const key = deriveClusterKey(fp({ accessibleName: "n".repeat(5_000) }));
    expect(key.length).toBeLessThanOrEqual(200);
  });
});

/** A failure record: `t1` broke on `save`. */
const f = (testId: string, clusterKey: string, runId: string | null = null): FailureRecord => ({
  testId,
  runId,
  clusterKey,
});

describe("clusterFailures", () => {
  it("collapses failures sharing a locator signature into one cluster", () => {
    // The load-bearing case: one renamed button, many tests.
    const failures = Array.from({ length: 38 }, (_, i) => f(`t${i}`, "testid:save-btn", `r${i}`));
    const clusters = clusterFailures(failures);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].clusterKey).toBe("testid:save-btn");
    expect(clusters[0].testIds).toHaveLength(38);
    expect(clusters[0].failures).toHaveLength(38);
  });

  it("keeps unrelated failures apart", () => {
    const clusters = clusterFailures([
      f("t1", "testid:save-btn"),
      f("t2", "role+name:button|Apply filter"),
      f("t3", "id:new-report"),
    ]);
    expect(clusters.map((c) => c.clusterKey)).toEqual([
      "testid:save-btn",
      "role+name:button|Apply filter",
      "id:new-report",
    ]);
    for (const c of clusters) expect(c.testIds).toHaveLength(1);
  });

  it("clusters a MIXED set — two shared locators and two one-offs — without cross-contamination", () => {
    const clusters = clusterFailures([
      f("t1", "testid:save-btn", "r1"),
      f("t2", "id:new-report", "r2"),
      f("t3", "testid:save-btn", "r3"),
      f("t4", "weak:div:abc123", "r4"),
      f("t5", "id:new-report", "r5"),
      f("t6", "testid:save-btn", "r6"),
    ]);
    expect(clusters).toHaveLength(3);
    const byKey = new Map(clusters.map((c) => [c.clusterKey, c]));
    expect(byKey.get("testid:save-btn")?.testIds).toEqual(["t1", "t3", "t6"]);
    expect(byKey.get("id:new-report")?.testIds).toEqual(["t2", "t5"]);
    expect(byKey.get("weak:div:abc123")?.testIds).toEqual(["t4"]);
    // First-seen order, so the oldest failure of each cluster is its natural anchor.
    expect(clusters.map((c) => c.clusterKey)).toEqual([
      "testid:save-btn",
      "id:new-report",
      "weak:div:abc123",
    ]);
    expect(byKey.get("testid:save-btn")?.failures.map((x) => x.runId)).toEqual(["r1", "r3", "r6"]);
  });

  it("counts a test that failed twice on the same locator once, and keeps both records", () => {
    const cluster = clusterFailures([
      f("t1", "testid:save-btn", "r1"),
      f("t1", "testid:save-btn", "r2"),
    ])[0];
    expect(cluster.testIds).toEqual(["t1"]);
    expect(cluster.failures).toHaveLength(2);
  });

  it("has no clusters when there are no failures", () => {
    expect(clusterFailures([])).toEqual([]);
  });
});

describe("normalizeBreakerThreshold", () => {
  it("accepts a positive integer", () => {
    expect(normalizeBreakerThreshold(1)).toBe(1);
    expect(normalizeBreakerThreshold(25)).toBe(25);
  });

  it("accepts the stored string form an app_settings row holds", () => {
    expect(normalizeBreakerThreshold("7")).toBe(7);
  });

  it("floors a fraction rather than rejecting it", () => {
    expect(normalizeBreakerThreshold(7.9)).toBe(7);
  });

  it("falls back rather than let a corrupt setting disable the guard", () => {
    // Every one of these would, taken literally, mean "never trip" or "always trip".
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "", "lots", null, undefined, {}]) {
      expect(normalizeBreakerThreshold(bad)).toBe(DEFAULT_BREAKER_THRESHOLD);
    }
  });
});

describe("breakerVerdict", () => {
  /** `n` distinct tests, all broken on the same locator. */
  const oneCluster = (n: number) =>
    Array.from({ length: n }, (_, i) => f(`t${i}`, "testid:save-btn", `r${i}`));

  it("does not trip UNDER the threshold", () => {
    const v = breakerVerdict(oneCluster(9), 10);
    expect(v.tripped).toBe(false);
    expect(v).toMatchObject({ threshold: 10, failingTests: 9, clusters: 1 });
  });

  it("does not trip AT the threshold — ten simultaneous failures are still repaired", () => {
    const v = breakerVerdict(oneCluster(10), 10);
    expect(v.tripped).toBe(false);
    expect(v.failingTests).toBe(10);
  });

  it("trips OVER the threshold — the eleventh is not", () => {
    const v = breakerVerdict(oneCluster(11), 10);
    expect(v.tripped).toBe(true);
    expect(v.failingTests).toBe(11);
  });

  it("counts distinct TESTS, not clusters — one huge cluster is exactly what must not slip through", () => {
    // Counting clusters would read this as "1 ≤ 10, carry on" and let the single most
    // consequential rewrite in the product past the guard.
    const v = breakerVerdict(oneCluster(40), 10);
    expect(v.clusters).toBe(1);
    expect(v.tripped).toBe(true);
  });

  it("counts a test once however many times it failed", () => {
    const v = breakerVerdict(
      [f("t1", "testid:a", "r1"), f("t1", "testid:a", "r2"), f("t1", "testid:b", "r3")],
      10,
    );
    expect(v.failingTests).toBe(1);
    expect(v.clusters).toBe(2);
    expect(v.tripped).toBe(false);
  });

  it("reports the cluster spread, so a human can tell a mass rename from a broken app", () => {
    const rename = breakerVerdict(oneCluster(20), 10);
    const brokenApp = breakerVerdict(
      Array.from({ length: 20 }, (_, i) => f(`t${i}`, `testid:btn-${i}`, `r${i}`)),
      10,
    );
    expect(rename).toMatchObject({ tripped: true, failingTests: 20, clusters: 1 });
    expect(brokenApp).toMatchObject({ tripped: true, failingTests: 20, clusters: 20 });
  });

  it("uses the documented default when no threshold is given", () => {
    expect(breakerVerdict(oneCluster(DEFAULT_BREAKER_THRESHOLD)).tripped).toBe(false);
    expect(breakerVerdict(oneCluster(DEFAULT_BREAKER_THRESHOLD + 1)).tripped).toBe(true);
  });

  it("normalizes a corrupt threshold rather than trusting it", () => {
    const v = breakerVerdict(oneCluster(11), 0);
    expect(v.threshold).toBe(DEFAULT_BREAKER_THRESHOLD);
    expect(v.tripped).toBe(true);
  });

  it("never trips on no failures", () => {
    expect(breakerVerdict([], 10)).toMatchObject({ tripped: false, failingTests: 0, clusters: 0 });
  });
});

describe("triage failure classes", () => {
  it("covers every red class EXCEPT the repairable one", () => {
    expect(TRIAGE_FAILURE_KINDS).toEqual(["pixel", "judge", "assertion", "timeout", "crash"]);
    // The load-bearing absence: `locator` is the one class a repair may touch, so it can never be
    // a triage kind. If this ever passes, a locator failure has become un-repairable.
    expect(TRIAGE_FAILURE_KINDS as readonly string[]).not.toContain("locator");
  });

  it("recognises the classes and rejects anything else", () => {
    for (const k of TRIAGE_FAILURE_KINDS) expect(isTriageFailureKind(k)).toBe(true);
    for (const bad of ["locator", "Pixel", "", "flake", null, undefined, 3]) {
      expect(isTriageFailureKind(bad)).toBe(false);
    }
  });
});

describe("triageClusterKey", () => {
  it("is stable for the same test and class — one open job to diagnose, not one per run", () => {
    expect(triageClusterKey("t1", "pixel")).toBe(triageClusterKey("t1", "pixel"));
  });

  it("separates classes within one test — a crash and a pixel diff are different diagnoses", () => {
    expect(triageClusterKey("t1", "crash")).not.toBe(triageClusterKey("t1", "pixel"));
  });

  it("is scoped to the TEST, unlike a repair cluster key", () => {
    // The asymmetry that matters: a locator key is test-blind so one renamed button collapses
    // across every test that used it. Two tests that both CRASHED did not necessarily crash for
    // the same reason, and the queued-unique index is over the cluster key alone — a test-blind
    // `triage:crash` would silently merge two unrelated diagnoses into one job.
    expect(triageClusterKey("t1", "crash")).not.toBe(triageClusterKey("t2", "crash"));
  });

  it("never collides with a repair cluster key", () => {
    const repairKeys = new Set([
      deriveClusterKey(fp({ testId: "save-btn" })),
      deriveClusterKey(fp({ attributes: { id: "save" } })),
      deriveClusterKey(fp({ role: "button", accessibleName: "Save" })),
      deriveClusterKey(fp({ accessibleName: "Save" })),
      deriveClusterKey(fp({ stableClasses: ["btn"] })),
      deriveClusterKey(fp({ text: "x" })),
    ]);
    for (const kind of TRIAGE_FAILURE_KINDS) {
      expect(repairKeys.has(triageClusterKey("t1", kind))).toBe(false);
    }
  });
});

describe("classifyThrownFailure", () => {
  it("reads Playwright's timeout off the error's TYPE, not its message", () => {
    const timeout = new Error("locator.click: Timeout 30000ms exceeded");
    timeout.name = "TimeoutError";
    expect(classifyThrownFailure(timeout)).toBe("timeout");
  });

  it("distinguishes a judge that could not run from a crash", () => {
    const judge = new Error("no judge provider is configured");
    judge.name = "JudgeUnavailableError";
    // "Crashed" would send whoever reads the queue looking at the app; the app is fine.
    expect(classifyThrownFailure(judge)).toBe("judge");
  });

  it("calls everything else a crash", () => {
    expect(classifyThrownFailure(new Error("net::ERR_CONNECTION_REFUSED"))).toBe("crash");
    expect(classifyThrownFailure(new TypeError("undefined is not a function"))).toBe("crash");
    // A message that merely SAYS timeout is not one — that is the point of reading the type.
    expect(classifyThrownFailure(new Error("the request timed out upstream"))).toBe("crash");
    expect(classifyThrownFailure("a bare string")).toBe("crash");
    expect(classifyThrownFailure(undefined)).toBe("crash");
  });
});
