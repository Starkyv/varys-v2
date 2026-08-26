import type { Fingerprint } from "@varys/step-schema";
import { describe, expect, it } from "vitest";
import { deriveClusterKey, isRepairPolicy, REPAIR_POLICIES, type RepairPolicy } from "./index";

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
