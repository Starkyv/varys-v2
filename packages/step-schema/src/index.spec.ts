import { describe, expect, it } from "vitest";
import { parseTestDefinition } from "./index";

const base = {
  name: "t",
  viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
};

describe("screenshot captureMode", () => {
  it("defaults a screenshot step with no captureMode to element (back-compat)", () => {
    const def = parseTestDefinition({
      ...base,
      steps: [
        { type: "navigate", url: "http://x/" },
        { type: "screenshot", name: "hero", target: { tag: "div" } },
      ],
    });
    const shot = def.steps.find((s) => s.type === "screenshot");
    expect(shot).toMatchObject({ captureMode: "element" });
  });

  it("accepts a region checkpoint carrying a rect and no target", () => {
    const def = parseTestDefinition({
      ...base,
      steps: [
        { type: "navigate", url: "http://x/" },
        {
          type: "screenshot",
          name: "area",
          captureMode: "region",
          rect: { x: 0, y: 0, width: 100, height: 50 },
        },
      ],
    });
    const shot = def.steps.find((s) => s.type === "screenshot");
    expect(shot).toMatchObject({
      captureMode: "region",
      rect: { x: 0, y: 0, width: 100, height: 50 },
    });
  });

  it("accepts a full-page checkpoint with neither target nor rect", () => {
    const def = parseTestDefinition({
      ...base,
      steps: [
        { type: "navigate", url: "http://x/" },
        { type: "screenshot", name: "page", captureMode: "fullpage" },
      ],
    });
    const shot = def.steps.find((s) => s.type === "screenshot");
    expect(shot).toMatchObject({ captureMode: "fullpage" });
  });

  it("rejects a region checkpoint with no rect", () => {
    expect(() =>
      parseTestDefinition({
        ...base,
        steps: [
          { type: "navigate", url: "http://x/" },
          { type: "screenshot", name: "area", captureMode: "region" },
        ],
      }),
    ).toThrow();
  });

  it("rejects an element checkpoint with no target", () => {
    expect(() =>
      parseTestDefinition({
        ...base,
        steps: [
          { type: "navigate", url: "http://x/" },
          { type: "screenshot", name: "el", captureMode: "element" },
        ],
      }),
    ).toThrow();
  });
});
