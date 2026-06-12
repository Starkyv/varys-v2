import { captureFingerprint } from "@varys/capture";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { parseTestDefinition, type Step, type TestDefinition } from "@varys/step-schema";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Fingerprint } from "@varys/step-schema";
import {
  applySelectorRemedy,
  classifyTypedValue,
  isWeakFingerprint,
  selectorDependsOnVariable,
  startRecorder,
  variableNameFor,
  variablesFromSteps,
} from "./index";

// Inject capture + recorder + the helpers it references (all self-contained), then
// start a session on the page. The helpers must be injected because `startRecorder`
// is run via `.toString()` and references them by name in the page's global scope.
const INJECT = `
  ${classifyTypedValue.toString()}
  ${variableNameFor.toString()}
  ${variablesFromSteps.toString()}
  ${captureFingerprint.toString()}
  ${startRecorder.toString()}
  window.__rec = startRecorder(captureFingerprint);
`;

describe("isWeakFingerprint", () => {
  const longText = "DEC 25 MORNING INCIDENT ".repeat(10); // > 180 chars, a content dump

  it("treats a durable anchor (testId / id / role+short name / short text) as strong", () => {
    expect(isWeakFingerprint({ tag: "div", testId: "briefing-card" })).toBe(false);
    expect(isWeakFingerprint({ tag: "div", attributes: { id: "hero" } })).toBe(false);
    expect(isWeakFingerprint({ tag: "button", role: "button", accessibleName: "Log in" })).toBe(
      false,
    );
    expect(isWeakFingerprint({ tag: "div", text: "Submit" })).toBe(false);
  });

  it("flags an element whose only signals are hashed module classes / long volatile text", () => {
    // The briefings-card case: a div with no testId/id/role, hashed classes, long text.
    expect(
      isWeakFingerprint({
        tag: "div",
        text: longText,
        accessibleName: longText,
        moduleClasses: ["BriefsView__bc___1-sZV", "BriefsView__fresh___Rj4Ac"],
      }),
    ).toBe(true);
    expect(isWeakFingerprint({ tag: "div" })).toBe(true);
    // A role without an accessible name, or with a long volatile one, is still weak.
    expect(isWeakFingerprint({ tag: "section", role: "region" })).toBe(true);
    expect(isWeakFingerprint({ tag: "main", role: "main", accessibleName: longText })).toBe(true);
  });
});

describe("recorder", () => {
  let browser: Browser;
  let fixture: FixtureServer;

  beforeAll(async () => {
    browser = await chromium.launch();
    fixture = await startFixtureServer();
    fixture.setVariant("login");
  });
  afterAll(async () => {
    await browser.close();
    await fixture.close();
  });

  it("records interactions into a valid step definition", async () => {
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    // Fill the login fields (password becomes a {{secret}}).
    await page.evaluate(() => {
      const u = document.querySelector("#username") as HTMLInputElement;
      u.value = "alice";
      u.dispatchEvent(new Event("change", { bubbles: true }));
      const p = document.querySelector("#password") as HTMLInputElement;
      p.value = "hunter2";
      p.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.click("#submit");
    await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.checkpoint("app", { el: document.querySelector("#app") }),
    );

    const def = (await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.getDefinition("login flow", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      }),
    )) as TestDefinition;
    await page.close();

    expect(() => parseTestDefinition(def)).not.toThrow();

    const steps = def.steps;
    expect(steps[0].type).toBe("navigate");
    expect((steps[0] as { url: string }).url.startsWith("{{baseUrl}}")).toBe(true);
    expect(steps.some((s) => s.type === "type" && (s as { value: string }).value === "alice")).toBe(true);
    expect(
      steps.some((s) => s.type === "type" && (s as { value: string }).value === "{{secret:password}}"),
    ).toBe(true);
    expect(steps.some((s) => s.type === "click")).toBe(true);
    expect(
      steps.some((s) => s.type === "screenshot" && (s as { name: string }).name === "app"),
    ).toBe(true);
  });

  it("streams each step to onStep as it is recorded (for navigation-surviving capture)", async () => {
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    // Re-start the recorder with an onStep sink that records every emitted step.
    // Reference the eval-injected globals (not the imports) so Vitest's SSR
    // transform can't rewrite them to module refs that don't exist in the page.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      w.__shipped = [];
      w.__rec = w.startRecorder(w.captureFingerprint, document, undefined, (s: unknown) =>
        w.__shipped.push(s),
      );
    });

    await page.evaluate(() => {
      const u = document.querySelector("#username") as HTMLInputElement;
      u.value = "alice";
      u.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.click("#submit");
    await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.checkpoint("app", { el: document.querySelector("#app") }),
    );

    const shipped = (await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__shipped,
    )) as Array<{ type: string }>;
    await page.close();

    // The initial navigate is shipped on construction; then the type, click, and screenshot.
    expect(shipped[0].type).toBe("navigate");
    expect(shipped.map((s) => s.type)).toEqual(["navigate", "type", "click", "screenshot"]);
  });

  it("emits element, region, and full-page checkpoints with the right capture mode", async () => {
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rec = (window as any).__rec;
      rec.checkpoint("el", { el: document.querySelector("#app") });
      rec.checkpoint("area", { mode: "region", rect: { x: 0, y: 0, width: 100, height: 50 } });
      rec.checkpoint("page", { mode: "fullpage" });
    });

    const def = (await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.getDefinition("modes", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      }),
    )) as TestDefinition;
    await page.close();

    expect(() => parseTestDefinition(def)).not.toThrow();
    const shots = def.steps.filter((s) => s.type === "screenshot") as Array<{
      name: string;
      captureMode?: string;
      target?: unknown;
      rect?: unknown;
    }>;

    const el = shots.find((s) => s.name === "el");
    expect(el).toMatchObject({ captureMode: "element" });
    expect(el?.target).toBeDefined();

    expect(shots.find((s) => s.name === "area")).toMatchObject({
      captureMode: "region",
      rect: { x: 0, y: 0, width: 100, height: 50 },
    });

    const page_ = shots.find((s) => s.name === "page");
    expect(page_).toMatchObject({ captureMode: "fullpage" });
    expect(page_?.target).toBeUndefined();
  });

  it("carries per-checkpoint masks drawn while designating the checkpoint", async () => {
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rec = (window as any).__rec;
      rec.checkpoint("masked", {
        el: document.querySelector("#app"),
        masks: [{ x: 4, y: 4, width: 20, height: 10 }],
      });
      rec.checkpoint("clean", { el: document.querySelector("#app") });
    });

    const def = (await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.getDefinition("masks", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      }),
    )) as TestDefinition;
    await page.close();

    expect(() => parseTestDefinition(def)).not.toThrow();
    const shots = def.steps.filter((s) => s.type === "screenshot") as Array<{
      name: string;
      masks?: { x: number; y: number; width: number; height: number }[];
    }>;

    // Each checkpoint keeps its own masks; a checkpoint drawn without masks has none.
    expect(shots.find((s) => s.name === "masked")?.masks).toEqual([
      { x: 4, y: 4, width: 20, height: 10 },
    ]);
    expect(shots.find((s) => s.name === "clean")?.masks).toBeUndefined();
  });

  // Slice 6 — a data-shaped typed value is parameterized as a {{variable}} and the
  // emitted definition declares the test's variables (origin url + the data var).
  it("parameterizes a data-shaped typed value and declares variables", async () => {
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    await page.evaluate(() => {
      const u = document.querySelector("#username") as HTMLInputElement;
      u.value = "Q3 sales report"; // multi-word ⇒ data-shaped ⇒ variable
      u.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const def = (await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.getDefinition("vars", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      }),
    )) as TestDefinition;
    await page.close();

    expect(() => parseTestDefinition(def)).not.toThrow();
    const typed = def.steps.find((s) => s.type === "type") as { value: string };
    expect(typed.value).toBe("{{username}}");
    expect(def.variables).toEqual(
      expect.arrayContaining([
        { name: "baseUrl", kind: "url" },
        { name: "username", kind: "data" },
      ]),
    );
  });
});

describe("classifyTypedValue", () => {
  it("defaults short, single-token / enumerable values to static", () => {
    for (const v of ["alice", "Submit", "active", "", "ab12", "USD"]) {
      expect(classifyTypedValue(v)).toBe("static");
    }
  });

  it("defaults data-shaped values to variable", () => {
    for (const v of [
      "Q3 sales", // multi-word
      "hello world report", // free text
      "2026-06-12", // date
      "550e8400-e29b-41d4-a716-446655440000", // GUID
      "1234567", // long id
      "a-very-long-identifier-value", // long token
    ]) {
      expect(classifyTypedValue(v)).toBe("variable");
    }
  });
});

describe("variablesFromSteps", () => {
  it("declares url / secret / data variables from the steps' tokens, once each", () => {
    const steps = [
      { type: "navigate", url: "{{baseUrl}}/app" },
      { type: "type", target: { tag: "input" }, value: "alice" },
      { type: "type", target: { tag: "input" }, value: "{{secret:password}}" },
      { type: "type", target: { tag: "input" }, value: "{{dataset}}" },
      { type: "type", target: { tag: "input" }, value: "{{dataset}}" }, // dup ⇒ once
    ] as unknown as Step[];
    expect(variablesFromSteps(steps)).toEqual([
      { name: "baseUrl", kind: "url" },
      { name: "password", kind: "secret" },
      { name: "dataset", kind: "data" },
    ]);
  });

  it("returns no variables for a token-free recording", () => {
    const steps = [
      { type: "navigate", url: "http://localhost/" },
      { type: "type", target: { tag: "input" }, value: "alice" },
    ] as unknown as Step[];
    expect(variablesFromSteps(steps)).toEqual([]);
  });
});

describe("variableNameFor", () => {
  it("prefers id, then name, then a safe default; strips unsafe chars", () => {
    expect(variableNameFor({ id: "dataset" })).toBe("dataset");
    expect(variableNameFor({ name: "account" })).toBe("account");
    expect(variableNameFor({})).toBe("value");
    expect(variableNameFor({ id: "a b!c" })).toBe("abc");
  });
});

describe("selectorDependsOnVariable", () => {
  const vars = [{ name: "dataset", value: "Q3 sales" }];

  it("fires when a fingerprint's visible text equals a variable value", () => {
    expect(selectorDependsOnVariable({ tag: "h1", text: "Q3 sales" }, vars)).toEqual({
      signal: "text",
      value: "Q3 sales",
      variable: "dataset",
    });
    expect(
      selectorDependsOnVariable({ tag: "button", accessibleName: "Q3 sales" }, vars),
    ).toEqual({ signal: "accessibleName", value: "Q3 sales", variable: "dataset" });
  });

  it("stays quiet for structural-only fingerprints or non-matching text", () => {
    expect(
      selectorDependsOnVariable({ tag: "div", testId: "hero", attributes: { id: "hero" } }, vars),
    ).toBeNull();
    expect(selectorDependsOnVariable({ tag: "h1", text: "Welcome" }, vars)).toBeNull();
    expect(selectorDependsOnVariable({ tag: "h1", text: "" }, [{ name: "x", value: "" }])).toBeNull();
  });
});

describe("applySelectorRemedy", () => {
  const fp: Fingerprint = { tag: "h1", text: "Q3 sales", testId: "title" };
  const hit = { signal: "text", value: "Q3 sales", variable: "dataset" } as const;

  it("bind replaces the offending signal with the variable token", () => {
    expect(applySelectorRemedy(fp, "bind", hit)).toEqual({
      tag: "h1",
      text: "{{dataset}}",
      testId: "title",
    });
  });

  it("structural drops the visible-text signals, keeping structural ones", () => {
    const out = applySelectorRemedy({ ...fp, accessibleName: "Q3 sales" }, "structural", hit);
    expect(out).toEqual({ tag: "h1", testId: "title" });
    expect(out.text).toBeUndefined();
    expect(out.accessibleName).toBeUndefined();
  });
});
