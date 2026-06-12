import { captureFingerprint } from "@varys/capture";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { parseTestDefinition, type TestDefinition } from "@varys/step-schema";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRecorder } from "./index";

// Inject capture + recorder (both self-contained) and start a session on the page.
const INJECT = `
  ${captureFingerprint.toString()}
  ${startRecorder.toString()}
  window.__rec = startRecorder(captureFingerprint);
`;

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
});
