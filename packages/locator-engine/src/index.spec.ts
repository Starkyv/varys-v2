import type { Fingerprint } from "@varys/step-schema";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "./index";

describe("locator resolve", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
  });
  afterEach(async () => {
    await page.close();
  });

  // Same captured fingerprint reused across the scenarios below.
  const fp: Fingerprint = {
    tag: "div",
    testId: "hero-card",
    attributes: { id: "hero" },
    text: "Hero",
  };

  it("resolves by the top available signal", async () => {
    await page.setContent(`<div id="hero" data-testid="hero-card">Hero</div>`);
    const r = await resolve(page, fp);
    expect(r).not.toBeNull();
    expect(r!.matchedSignal).toBe("testId");
    expect(r!.healed).toBe(false);
    expect(await r!.locator.textContent()).toBe("Hero");
  });

  it("heals to a lower-priority signal when the top one is gone", async () => {
    await page.setContent(`<div id="hero">Hero</div>`); // no data-testid
    const r = await resolve(page, fp);
    expect(r).not.toBeNull();
    expect(r!.matchedSignal).not.toBe("testId");
    expect(r!.healed).toBe(true);
  });

  it("returns null when nothing matches", async () => {
    await page.setContent(`<section>Different</section>`);
    expect(await resolve(page, fp)).toBeNull();
  });
});
