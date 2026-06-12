import { fingerprint } from "@varys/step-schema";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureFingerprint } from "./index";

// Run the (self-contained) capture function inside the page against a selector.
async function captureInPage(page: Page, selector: string): Promise<unknown> {
  const src = captureFingerprint.toString();
  return page.evaluate(
    ([fnSrc, sel]) => {
      // eslint-disable-next-line no-eval
      const fn = eval(`(${fnSrc})`);
      return fn(document.querySelector(sel));
    },
    [src, selector] as const,
  );
}

describe("captureFingerprint", () => {
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

  it("captures the element's signals as a valid fingerprint", async () => {
    await page.setContent(
      `<main><div id="hero" data-testid="hero-card" class="Card_root__a3f9">Hero</div></main>`,
    );

    const fp = (await captureInPage(page, "#hero")) as Record<string, unknown>;

    expect(fp.tag).toBe("div");
    expect(fp.testId).toBe("hero-card");
    expect((fp.attributes as Record<string, string>).id).toBe("hero");
    expect(fp.text).toBe("Hero");
    expect(fp.boundingBox).toBeTruthy();

    // It must conform to the shared contract the extension emits.
    expect(() => fingerprint.parse(fp)).not.toThrow();
  });
});
