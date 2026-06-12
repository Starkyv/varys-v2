import { fingerprint } from "@varys/step-schema";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureFingerprint } from "./index";

// Run the (self-contained) capture function inside the page against a selector.
async function captureInPage(
  page: Page,
  selector: string,
  opts?: { climb?: boolean },
): Promise<unknown> {
  const src = captureFingerprint.toString();
  return page.evaluate(
    ([fnSrc, sel, o]) => {
      // eslint-disable-next-line no-eval
      const fn = eval(`(${fnSrc})`);
      return fn(document.querySelector(sel), o ?? undefined);
    },
    [src, selector, opts ?? null] as const,
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

  it("anchors ancestors with their id / testId", async () => {
    await page.setContent(
      `<main id="app"><section data-testid="sec"><div id="hero">Hero</div></section></main>`,
    );
    const fp = (await captureInPage(page, "#hero")) as {
      ancestors: { tag: string; id?: string; testId?: string }[];
    };
    expect(fp.ancestors[0]).toMatchObject({ tag: "section", testId: "sec" });
    expect(fp.ancestors[1]).toMatchObject({ tag: "main", id: "app" });
  });

  it("keeps durable classes and drops build-hashed / numeric ones", async () => {
    await page.setContent(`<div id="x" class="Card_root__a3f9 card flow-list 123">Hi</div>`);
    const fp = (await captureInPage(page, "#x")) as {
      moduleClasses: string[];
      stableClasses?: string[];
    };
    expect(fp.stableClasses).toEqual(["card", "flow-list"]);
    expect(fp.moduleClasses).toContain("Card_root__a3f9"); // raw list kept for weak corroboration
  });

  it("computes the accessible name with provenance", async () => {
    await page.setContent(
      `<button id="b1" aria-label="Save changes"><svg></svg></button>` +
        `<button id="b2">Click me</button>` +
        `<a id="a1" title="Help">?</a>`,
    );
    expect(await captureInPage(page, "#b1")).toMatchObject({
      accessibleName: "Save changes",
      nameFromAttr: true,
    });
    expect(await captureInPage(page, "#b2")).toMatchObject({
      accessibleName: "Click me",
      nameFromAttr: false,
    });
    expect(await captureInPage(page, "#a1")).toMatchObject({
      accessibleName: "Help",
      nameFromAttr: true,
    });
  });

  it("rejects library-generated ids (tippy-N) as a usable id signal", async () => {
    await page.setContent(`<div data-testid="t1" id="tippy-347">x</div><div id="goodId">y</div>`);
    const generated = (await captureInPage(page, '[data-testid="t1"]')) as {
      attributes?: Record<string, string>;
    };
    expect(generated.attributes?.id).toBeUndefined();
    const good = (await captureInPage(page, "#goodId")) as { attributes: Record<string, string> };
    expect(good.attributes.id).toBe("goodId");
  });

  it("climbs to the actionable control for clicks, but keeps the exact element for screenshots", async () => {
    await page.setContent(
      `<button id="save" aria-label="Save"><span class="ico">x</span></button>`,
    );
    const click = (await captureInPage(page, ".ico", { climb: true })) as {
      tag: string;
      attributes?: Record<string, string>;
      accessibleName?: string;
    };
    expect(click.tag).toBe("button");
    expect(click.attributes?.id).toBe("save");
    expect(click.accessibleName).toBe("Save");

    const shot = (await captureInPage(page, ".ico")) as { tag: string };
    expect(shot.tag).toBe("span"); // screenshot capture does not climb
  });

  it("scopes a repeated control to its distinguishing row", async () => {
    await page.setContent(
      `<ul>` +
        `<li><div>Apples</div><button class="more" aria-label="More">x</button></li>` +
        `<li><div>Oranges</div><button class="more" aria-label="More">x</button></li>` +
        `</ul>`,
    );
    const fp = (await captureInPage(page, ".more")) as {
      scope?: { container: string; text: string };
    };
    expect(fp.scope).toEqual({ container: "li", text: "Apples" });
  });
});
