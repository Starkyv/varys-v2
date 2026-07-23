import type { Fingerprint } from "@varys/step-schema";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolve, verify } from "./index";

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
    expect(await resolve(page, fp, { timeoutMs: 300 })).toBeNull();
  });

  // The briefings-card failure mode: recorded on an older build, so the hashed class
  // rotated and the text changed — testId/id/role/exact-class/exact-text all miss.
  // Structure (stable ancestor id) + size resolve it where the old ranked matcher
  // returned "no fingerprint signal matched".
  it("resolves a previously-unmatchable container via structure + box size", async () => {
    await page.setContent(
      `<div id="board">` +
        `<div class="Card__NEW___aaa" style="width:200px;height:200px">Alpha</div>` +
        `<div class="Card__NEW___bbb" style="width:200px;height:80px">Beta</div>` +
        `</div>`,
    );
    const card: Fingerprint = {
      tag: "div",
      accessibleName: "stale recorded text",
      text: "stale recorded text",
      moduleClasses: ["Card__OLD___xyz"], // rotated — absent on this build
      ancestors: [{ tag: "div", id: "board" }],
      domIndex: 1,
      boundingBox: { x: 0, y: 0, width: 200, height: 80 },
    };
    const r = await resolve(page, card);
    expect(r).not.toBeNull();
    expect(await r!.locator.getAttribute("class")).toBe("Card__NEW___bbb");
    expect(r!.healed).toBe(true);
  });

  it("resolves a repeated control to the correct row via its scope", async () => {
    await page.setContent(
      `<ul>` +
        `<li>Apples <button aria-label="More" class="more">x</button></li>` +
        `<li>Oranges <button aria-label="More" class="more">x</button></li>` +
        `</ul>`,
    );
    const moreBtn: Fingerprint = {
      tag: "button",
      accessibleName: "More",
      nameFromAttr: true,
      scope: { container: "li", text: "Apples" },
      stableClasses: ["more"],
      boundingBox: { x: 0, y: 0, width: 30, height: 20 },
    };
    const r = await resolve(page, moreBtn);
    expect(r).not.toBeNull();
    const rowText = await r!.locator.evaluate((el) => el.closest("li")?.textContent ?? "");
    expect(rowText).toContain("Apples");
  });

  // Card-grid action buttons: many identical `item-card-delete` buttons, all sharing the same tag
  // chain AND a common grid ancestor — the ONLY thing telling them apart is the distinguishing
  // `item-card-<id>` on one candidate's chain. The ancestor score must weight that key strongly and
  // uncapped; a combined cap (the old `min(16, …)`) let the shared ancestors saturate it and erased
  // the distinguisher → a 13-way tie the matcher refused (ambiguous).
  it("disambiguates identical sibling controls by a distinguishing ancestor testId", async () => {
    const cards = ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg", "hhh"]
      .map(
        (cid) =>
          `<div data-testid="item-card-${cid}"><div><button data-testid="item-card-delete">Delete</button></div></div>`,
      )
      .join("");
    await page.setContent(`<div data-testid="cognitive-skill-grid">${cards}</div>`);
    const del: Fingerprint = {
      tag: "button",
      testId: "item-card-delete",
      accessibleName: "Delete",
      ancestors: [
        { tag: "div" },
        { tag: "div", testId: "item-card-ggg" },
        { tag: "div", testId: "cognitive-skill-grid" },
      ],
    };
    const v = await verify(page, del);
    expect(v.status).toBe("resolved");
    const r = await resolve(page, del);
    expect(r).not.toBeNull();
    const cardId = await r!.locator.evaluate((el) =>
      el.closest("[data-testid^='item-card-']:not([data-testid='item-card-delete'])")?.getAttribute("data-testid"),
    );
    expect(cardId).toBe("item-card-ggg");
  });

  it("does not resolve on a build-hashed class alone (it's only corroboration)", async () => {
    await page.setContent(`<div class="X__a___1">content</div>`);
    const onlyHashed: Fingerprint = { tag: "div", moduleClasses: ["X__a___1"] };
    expect(await resolve(page, onlyHashed, { timeoutMs: 300 })).toBeNull();
  });

  it("refuses to guess between indistinguishable candidates", async () => {
    await page.setContent(`<div>Same</div><div>Same</div>`);
    const ambiguous: Fingerprint = { tag: "div", accessibleName: "Same", text: "Same" };
    expect(await resolve(page, ambiguous, { timeoutMs: 300 })).toBeNull();
  });

  // Author selector override (Slice 16.2).
  it("uses an author selectorOverride as-is when it resolves to exactly one element", async () => {
    await page.setContent(`<button id="a">A</button><button id="b">B</button>`);
    // The bundle (role+name) would match button B; the override pins button A instead.
    const fpWithOverride: Fingerprint = {
      tag: "button",
      role: "button",
      accessibleName: "B",
      selectorOverride: "#a",
    };
    const r = await resolve(page, fpWithOverride);
    expect(r).not.toBeNull();
    expect(r!.matchedSignal).toBe("override");
    expect(r!.healed).toBe(false);
    expect(await r!.locator.textContent()).toBe("A");
  });

  it("falls through to the scored bundle when the override is stale (matches nothing)", async () => {
    await page.setContent(`<div id="hero" data-testid="hero-card">Hero</div>`);
    const stale: Fingerprint = { ...fp, selectorOverride: "#gone" };
    const r = await resolve(page, stale);
    expect(r).not.toBeNull();
    expect(r!.matchedSignal).toBe("testId"); // bundle won, not the override
  });

  it("ignores an override that matches multiple elements (not unique → not used)", async () => {
    await page.setContent(
      `<div id="hero" data-testid="hero-card">Hero</div>` +
        `<button class="dup">x</button><button class="dup">y</button>`,
    );
    const multi: Fingerprint = { ...fp, selectorOverride: ".dup" };
    const r = await resolve(page, multi);
    expect(r).not.toBeNull();
    expect(r!.matchedSignal).toBe("testId"); // fell through; the non-unique override was skipped
  });

  // verify() — the probe verdict (Slice 16.3a). Same matcher, but ambiguous ≠ not-found.
  it("verify reports resolved with the matched signal", async () => {
    await page.setContent(`<div id="hero" data-testid="hero-card">Hero</div>`);
    const v = await verify(page, fp);
    expect(v).toMatchObject({ status: "resolved", matchedSignal: "testId", healed: false });
  });

  it("verify reports ambiguous on a near-tie", async () => {
    await page.setContent(`<div>Same</div><div>Same</div>`);
    const ambiguous: Fingerprint = { tag: "div", accessibleName: "Same", text: "Same" };
    const v = await verify(page, ambiguous, { timeoutMs: 300 });
    expect(v.status).toBe("ambiguous");
  });

  it("verify reports not-found when nothing matches", async () => {
    await page.setContent(`<section>Different</section>`);
    const v = await verify(page, fp, { timeoutMs: 300 });
    expect(v.status).toBe("not-found");
  });

  // Frame-aware resolution: the target lives inside a same-origin `srcDoc` iframe (the Brief
  // report / Wisdom viz shape). `frameChain` descends into it before scoring.
  describe("frameChain (iframe descent)", () => {
    it("resolves a target inside a same-origin srcDoc iframe named by testId", async () => {
      await page.setContent(
        `<iframe data-testid="report" srcdoc='<div id="t" data-testid="brief-title">Weekly Violations</div>'></iframe>`,
      );
      const target: Fingerprint = {
        tag: "div",
        testId: "brief-title",
        frameChain: [{ testId: "report" }],
      };
      const r = await resolve(page, target);
      expect(r).not.toBeNull();
      expect(r!.matchedSignal).toBe("testId");
      expect(await r!.locator.textContent()).toBe("Weekly Violations");
    });

    it("selects the right iframe by index when it carries no stable attribute", async () => {
      await page.setContent(
        `<iframe srcdoc='<div data-testid="a">Alpha</div>'></iframe>` +
          `<iframe srcdoc='<div data-testid="b">Beta</div>'></iframe>`,
      );
      const target: Fingerprint = { tag: "div", testId: "b", frameChain: [{ index: 1 }] };
      const r = await resolve(page, target);
      expect(r).not.toBeNull();
      expect(await r!.locator.textContent()).toBe("Beta");
    });

    it("returns null (loud fail) when a frame in the chain can't be reached", async () => {
      await page.setContent(`<div data-testid="brief-title">no frames here</div>`);
      const target: Fingerprint = {
        tag: "div",
        testId: "brief-title",
        frameChain: [{ testId: "missing-frame" }],
      };
      expect(await resolve(page, target, { timeoutMs: 300 })).toBeNull();
    });

    it("verify surfaces not-found when the frame is unreachable", async () => {
      await page.setContent(`<div>top level only</div>`);
      const target: Fingerprint = { tag: "div", testId: "x", frameChain: [{ id: "gone" }] };
      const v = await verify(page, target, { timeoutMs: 300 });
      expect(v.status).toBe("not-found");
    });
  });
});
