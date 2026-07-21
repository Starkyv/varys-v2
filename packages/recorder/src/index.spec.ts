import { captureFingerprint } from "@varys/capture";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { parseTestDefinition, type Step, type TestDefinition } from "@varys/step-schema";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Fingerprint } from "@varys/step-schema";
import {
  buildClick,
  buildEntryNavigate,
  buildHover,
  buildType,
  createRecording,
  isWeakFingerprint,
  sanitizeEntryUrl,
  variablesFromSteps,
} from "./index";
import { startRecorder } from "./dom";

// Inject capture + recorder + the helpers it references (all self-contained), then
// start a session on the page. The helpers must be injected because `startRecorder`
// is run via `.toString()` and references them by name in the page's global scope.
const INJECT = `
  ${variablesFromSteps.toString()}
  ${sanitizeEntryUrl.toString()}
  ${buildClick.toString()}
  ${buildHover.toString()}
  ${buildType.toString()}
  ${buildEntryNavigate.toString()}
  ${createRecording.toString()}
  ${captureFingerprint.toString()}
  ${startRecorder.toString()}
  // startRecorder lives in ./dom and references the core via cross-module imports, which
  // vitest's SSR transform rewrites to \`__vite_ssr_import_0__.X\`. Those bindings don't
  // exist in the page, so shim the namespace to the injected globals. (In the real
  // extension build these imports are bundled — this is purely a unit-test artifact.)
  var __vite_ssr_import_0__ = { buildClick, buildHover, buildType, buildEntryNavigate, createRecording };
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
    // The recorder core records every typed value LITERALLY (no variables/secrets) — password
    // handling lives in the extension layer, not here. (Was previously asserting a stale
    // "{{secret:password}}" that predates the secrets removal.)
    expect(
      steps.some((s) => s.type === "type" && (s as { value: string }).value === "hunter2"),
    ).toBe(true);
    expect(steps.some((s) => s.type === "click")).toBe(true);
    expect(
      steps.some((s) => s.type === "screenshot" && (s as { name: string }).name === "app"),
    ).toBe(true);
  });

  it("records a hover step when a hover reveals a menu that is then clicked", async () => {
    fixture.setVariant("hovermenu");
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    // Hover the trigger (reveals #flyout), then click the revealed item — a flow a click-only
    // recorder would capture as a lone click that can't be replayed (the menu is closed at run).
    await page.hover("#more");
    await page.click("#explorer");

    const def = (await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.getDefinition("hover flow", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      }),
    )) as TestDefinition;
    await page.close();
    fixture.setVariant("login"); // restore for the other tests

    expect(() => parseTestDefinition(def)).not.toThrow();

    // A hover on the trigger is recorded immediately before the click on the revealed item.
    const hoverIdx = def.steps.findIndex((s) => s.type === "hover");
    expect(hoverIdx).toBeGreaterThanOrEqual(0);
    expect(def.steps[hoverIdx + 1]?.type).toBe("click");
    // The hover targets the trigger; the click targets the revealed menu item.
    expect((def.steps[hoverIdx] as { target: Fingerprint }).target.testId).toBe("more-trigger");
    expect((def.steps[hoverIdx + 1] as { target: Fingerprint }).target.testId).toBe("fly-explorer");
  });

  it("does not record a hover for an ordinary click (no reveal)", async () => {
    fixture.setVariant("login");
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    // Hovering + clicking a plain button that reveals nothing must NOT synthesize a hover step.
    await page.hover("#submit");
    await page.click("#submit");

    const def = (await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.getDefinition("plain click", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      }),
    )) as TestDefinition;
    await page.close();

    expect(def.steps.some((s) => s.type === "hover")).toBe(false);
  });

  it("records a checkbox toggle as a single click, never an un-fillable type step", async () => {
    fixture.setVariant("checkbox");
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    // Click the label (fires the label click + a synthetic click on the control + one change).
    await page.click("#internal-label");

    const def = (await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.getDefinition("checkbox flow", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      }),
    )) as TestDefinition;
    await page.close();
    fixture.setVariant("login"); // restore for the other tests

    expect(() => parseTestDefinition(def)).not.toThrow();
    // A checkbox can't be filled — there must be NO type step for it.
    expect(def.steps.some((s) => s.type === "type")).toBe(false);
    // Exactly ONE click step for the toggle (no double-record from the label's synthetic click),
    // targeting the label (its visible text is the durable locator).
    const clicks = def.steps.filter((s) => s.type === "click");
    expect(clicks.length).toBe(1);
    expect((clicks[0] as { target: Fingerprint }).target.testId).toBe("chk-internal-label");
  });

  it("captures a typed value even when the field never blurs (flushed into the definition)", async () => {
    fixture.setVariant("checkbox");
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    // Type without ever blurring the field — no native `change` fires. (This is the popover
    // case: the input would unmount on outside-click before it ever blurs.)
    await page.locator("#also").pressSequentially("ttest");

    // getDefinition is what "Save" calls — it must flush the in-progress value into a type step.
    const def = (await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.getDefinition("typing flow", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      }),
    )) as TestDefinition;
    await page.close();
    fixture.setVariant("login"); // restore for the other tests

    expect(() => parseTestDefinition(def)).not.toThrow();
    const typed = def.steps.filter(
      (s) => s.type === "type" && (s as { value: string }).value === "ttest",
    );
    // Exactly one type step for the field, with the final value — not one per keystroke.
    expect(typed.length).toBe(1);
    expect((typed[0] as { target: Fingerprint }).target.testId).toBe("also-input");
  });

  it("captures typing into a contenteditable (rich-text / markdown) editor", async () => {
    fixture.setVariant("editor");
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    // Rich-text editors are contenteditable divs, not <input>/<textarea>.
    await page.locator("#editor").pressSequentially("hello world notes");

    const def = (await page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__rec.getDefinition("editor flow", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      }),
    )) as TestDefinition;
    await page.close();
    fixture.setVariant("login"); // restore for the other tests

    expect(() => parseTestDefinition(def)).not.toThrow();
    const typed = def.steps.filter(
      (s) => s.type === "type" && (s as { value: string }).value === "hello world notes",
    );
    // The contenteditable's content is recorded as a single type step targeting the editor host.
    expect(typed.length).toBe(1);
    expect((typed[0] as { target: Fingerprint }).target.testId).toBe("dk-editor");
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

  // A typed value is always recorded as a LITERAL (there are no variables/secrets); the only
  // token is the entry navigate's {{baseUrl}}.
  it("records a typed value literally, declaring only baseUrl", async () => {
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.evaluate((src) => {
      (0, eval)(src);
    }, INJECT);

    await page.evaluate(() => {
      const u = document.querySelector("#username") as HTMLInputElement;
      u.value = "Q3 sales report"; // multi-word, but not auto-promoted — stays literal
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
    expect(typed.value).toBe("Q3 sales report");
    // No data variable declared for the typed value; only the navigation origin is parameterized.
    expect(def.variables).toEqual([{ name: "baseUrl", kind: "url" }]);
  });
});

describe("variablesFromSteps", () => {
  it("declares baseUrl when the entry navigate uses {{baseUrl}} (the only token left)", () => {
    const steps = [
      { type: "navigate", url: "{{baseUrl}}/app" },
      { type: "type", target: { tag: "input" }, value: "alice" },
    ] as unknown as Step[];
    expect(variablesFromSteps(steps)).toEqual([{ name: "baseUrl", kind: "url" }]);
  });

  it("returns no variables when nothing uses {{baseUrl}}", () => {
    const steps = [
      { type: "navigate", url: "http://localhost/" },
      { type: "type", target: { tag: "input" }, value: "alice" },
    ] as unknown as Step[];
    expect(variablesFromSteps(steps)).toEqual([]);
  });
});

// Slice 1 — the shared step-building core, exercised directly in Node (no browser).
describe("shared core — step factories", () => {
  const fp: Fingerprint = { tag: "input", attributes: { id: "q" } };

  it("buildClick wraps a fingerprint into a click step", () => {
    expect(buildClick(fp)).toEqual({ type: "click", target: fp });
  });

  it("buildType records the value literally — no variables/secrets, even a password", () => {
    expect(buildType(fp, "Q3 sales report")).toEqual({ type: "type", target: fp, value: "Q3 sales report" });
    expect(buildType(fp, "hunter2")).toEqual({ type: "type", target: fp, value: "hunter2" });
  });

  it("buildEntryNavigate strips volatile auth params and parameterizes the origin", () => {
    expect(
      buildEntryNavigate("https://app.example.com/login?next=/dash&tab=2", "https://app.example.com"),
    ).toEqual({ type: "navigate", url: "{{baseUrl}}/login?tab=2" });
  });
});

describe("createRecording accumulator", () => {
  const fp: Fingerprint = { tag: "button", role: "button", accessibleName: "Save" };

  it("accumulates steps, derives baseUrl, and counts steps + checkpoints", () => {
    const rec = createRecording();
    rec.push(buildEntryNavigate("https://app.example.com/", "https://app.example.com"));
    rec.push(buildType({ tag: "input", attributes: { id: "u" } }, "Q3 sales"));
    rec.push(buildType({ tag: "input" }, "hunter2"));
    rec.push(buildClick(fp));
    rec.checkpoint("after-login", { mode: "fullpage" });

    expect(rec.stepCount()).toBe(5);
    expect(rec.checkpointCount()).toBe(1);

    const def = rec.getDefinition("login flow", { width: 800, height: 600, deviceScaleFactor: 1 });
    expect(() => parseTestDefinition(def)).not.toThrow();
    // Only baseUrl is a variable; typed values stay literal (no secret/variable tokens).
    expect(def.variables).toEqual([{ name: "baseUrl", kind: "url" }]);
    const typed = def.steps.filter((s) => s.type === "type") as Array<{ value: string }>;
    expect(typed.map((s) => s.value)).toEqual(["Q3 sales", "hunter2"]);
  });

  it("shapes element / region / fullpage checkpoints and keeps masks only when present", () => {
    const rec = createRecording();
    rec.checkpoint("el", { mode: "element", target: fp, masks: [{ x: 1, y: 2, width: 3, height: 4 }] });
    rec.checkpoint("area", { mode: "region", rect: { x: 0, y: 0, width: 10, height: 10 } });
    rec.checkpoint("page", { mode: "fullpage" });
    const def = rec.getDefinition("modes", { width: 800, height: 600, deviceScaleFactor: 1 });
    const shots = def.steps.filter((s) => s.type === "screenshot") as Array<{
      name: string;
      captureMode?: string;
      target?: unknown;
      rect?: unknown;
      masks?: unknown;
    }>;
    expect(shots.find((s) => s.name === "el")).toMatchObject({
      captureMode: "element",
      masks: [{ x: 1, y: 2, width: 3, height: 4 }],
    });
    expect(shots.find((s) => s.name === "el")?.target).toEqual(fp);
    expect(shots.find((s) => s.name === "area")).toMatchObject({
      captureMode: "region",
      rect: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(shots.find((s) => s.name === "area")?.masks).toBeUndefined();
    expect(shots.find((s) => s.name === "page")).toMatchObject({ captureMode: "fullpage" });
    expect(shots.find((s) => s.name === "page")?.target).toBeUndefined();
  });
});

describe("human <-> agent parity", () => {
  // The divergence guarantee: the same (fingerprint, value) inputs produce identical steps
  // whichever driver supplies them — because both call the same factory (ADR 0001).
  it("both drivers build identical type steps from the same fingerprint + value", () => {
    const fp: Fingerprint = { tag: "input", attributes: { id: "password" } };
    expect(buildType(fp, "hunter2")).toEqual(buildType(fp, "hunter2"));
    expect((buildType(fp, "hunter2") as { value: string }).value).toBe("hunter2");
  });
});
