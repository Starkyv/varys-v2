import { describe, expect, it } from "vitest";
import { describeStep, parseTestDefinition, type Step } from "./index";

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

describe("declared variables", () => {
  const steps = [
    { type: "navigate", url: "{{baseUrl}}/" },
    { type: "screenshot", name: "hero", target: { tag: "div" } },
  ];

  it("parses a definition carrying declared variables", () => {
    const def = parseTestDefinition({
      ...base,
      steps,
      variables: [
        { name: "baseUrl", kind: "url" },
        { name: "dataset", kind: "data" },
        { name: "password", kind: "secret" },
      ],
    });
    expect(def.variables).toEqual([
      { name: "baseUrl", kind: "url" },
      { name: "dataset", kind: "data" },
      { name: "password", kind: "secret" },
    ]);
  });

  it("is optional — a definition with no variables still parses (back-compat)", () => {
    const def = parseTestDefinition({ ...base, steps });
    expect(def.variables).toBeUndefined();
  });

  it("rejects a variable with an unknown kind", () => {
    expect(() =>
      parseTestDefinition({
        ...base,
        steps,
        variables: [{ name: "dataset", kind: "nope" }],
      }),
    ).toThrow();
  });
});

describe("describeStep", () => {
  it("labels each step type for failed-run reporting", () => {
    const cases: [Step, string][] = [
      [{ type: "navigate", url: "{{baseUrl}}/" }, 'navigate to "{{baseUrl}}/"'],
      [{ type: "click", target: { tag: "button", text: "Submit" } }, 'click "Submit"'],
      [{ type: "type", target: { tag: "input", attributes: { id: "search" } }, value: "x" }, "type into #search"],
      [
        { type: "screenshot", name: "hero", captureMode: "element", target: { tag: "div" } },
        'checkpoint "hero" (element)',
      ],
    ];
    for (const [step, label] of cases) {
      expect(describeStep(step)).toBe(label);
    }
  });

  it("prefers a testid over text in the label", () => {
    expect(describeStep({ type: "click", target: { tag: "button", testId: "go", text: "Go" } })).toBe(
      'click [data-testid="go"]',
    );
  });
});
