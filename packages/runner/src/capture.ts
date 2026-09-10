import type { Locator, Page } from "playwright";

/**
 * Screenshot hygiene shared by every driver that captures a checkpoint — the Run, and the
 * Authoring Session's preview — so what an author approves is what replay asserts.
 *
 * Two problems live here, both of them "the picture is not what the page looks like":
 *
 *  1. **Pinned chrome lands in the middle of the picture.** An element capture is a crop of the
 *     rendered viewport, so anything painted ON TOP of the target comes with it. Modern apps pin
 *     a topbar (`position: sticky; top: 0`) and a composer/dock (`sticky; bottom: 0`); when the
 *     capture grows the viewport to fit a tall element (see `captureFullElement`), those stick to
 *     the viewport edges and get stamped ACROSS the content — a notebook screenshot with the app
 *     header printed over its chart and the prompt box over its table. Neutralizing puts sticky
 *     chrome back in document flow and hides floating `fixed` overlays that aren't part of the
 *     target.
 *
 *  2. **The frame is caught mid-relayout.** Growing the viewport makes charts re-measure; canvas
 *     and SVG renderers redraw asynchronously (ResizeObserver → rAF → animated redraw), so a
 *     screenshot taken on a fixed timer catches axes, labels and series at their OLD geometry —
 *     the "misaligned chart" screenshots. {@link captureStable} shoots until two consecutive
 *     frames are byte-identical, which is the only app-agnostic definition of "done painting".
 */

/** Marker + saved inline styles for an element this module touched, so it can be put back. */
const OVERLAY_MARK = "data-varys-overlay";

/**
 * In-page JS (a raw string — a serialized function would carry esbuild's `__name` helper into a
 * page that doesn't define it) that takes sticky/fixed chrome out of the way for one capture.
 *
 * `keepSelector` names the capture target when there is one. The rules:
 *  - `position: sticky` → `static`, always. The element stays in the picture, at its natural
 *    place in the flow, instead of riding the viewport edge across the content.
 *  - `position: fixed` → hidden, UNLESS it is the target or an ancestor of it. A fixed element
 *    the target lives inside is the target's own frame (a modal, a drawer) and must stay; every
 *    other one is an overlay floating over the shot.
 *
 * Returns how many elements were changed (diagnostic only).
 */
export function neutralizeOverlaysExpression(keepSelector?: string): string {
  return `(function () {
  var keep = ${keepSelector ? JSON.stringify(keepSelector) : "null"};
  var target = null;
  try { target = keep ? document.querySelector(keep) : null; } catch (e) { target = null; }
  var all = document.querySelectorAll('body *');
  var touched = 0;
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var pos;
    try { pos = getComputedStyle(el).position; } catch (e) { continue; }
    if (pos !== 'sticky' && pos !== 'fixed') continue;
    // A fixed element the target sits inside IS the target's frame — leave it alone.
    if (pos === 'fixed' && target && (el === target || el.contains(target))) continue;
    el.setAttribute(${JSON.stringify(OVERLAY_MARK)}, JSON.stringify([
      el.style.getPropertyValue('position'), el.style.getPropertyPriority('position'),
      el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')
    ]));
    if (pos === 'fixed') el.style.setProperty('visibility', 'hidden', 'important');
    else el.style.setProperty('position', 'static', 'important');
    touched++;
  }
  return touched;
})()`;
}

/** Undo {@link neutralizeOverlaysExpression}, restoring each element's own inline styles. */
export function restoreOverlaysExpression(): string {
  return `(function () {
  var marked = document.querySelectorAll('[${OVERLAY_MARK}]');
  for (var i = 0; i < marked.length; i++) {
    var el = marked[i];
    var saved;
    try { saved = JSON.parse(el.getAttribute(${JSON.stringify(OVERLAY_MARK)}) || '[]'); } catch (e) { saved = []; }
    el.style.removeProperty('position');
    el.style.removeProperty('visibility');
    if (saved[0]) el.style.setProperty('position', saved[0], saved[1] || '');
    if (saved[2]) el.style.setProperty('visibility', saved[2], saved[3] || '');
    el.removeAttribute(${JSON.stringify(OVERLAY_MARK)});
  }
  return marked.length;
})()`;
}

/**
 * Run `fn` with sticky/fixed chrome neutralized, then put the page back exactly as it was.
 * Best-effort on both sides: a page that navigates mid-capture loses the marks anyway, and a
 * failed restore must never fail the step (the page is thrown away at the end of the run).
 */
export async function withOverlaysNeutralized<T>(
  page: Page,
  keepSelector: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  await page.evaluate(neutralizeOverlaysExpression(keepSelector)).catch(() => undefined);
  try {
    // Neutralizing reflows the page (chrome that was out of flow is now in it) — let the app's
    // resize-driven renderers catch up before anything is measured or shot.
    await settleLayout(page);
    return await fn();
  } finally {
    await page.evaluate(restoreOverlaysExpression()).catch(() => undefined);
  }
}

/**
 * Let the page finish reacting to a size change: fire the `resize` listeners that ResizeObserver-
 * less chart libraries hang off, wait for webfonts (a late font reflows every label), then give
 * the compositor two frames — the rAF-after-rAF that means "the frame that was scheduled by the
 * work I just triggered has actually been painted".
 */
export async function settleLayout(page: Page): Promise<void> {
  await page
    .evaluate(`(function () {
  return new Promise(function (resolve) {
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
    var fonts = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    Promise.resolve(fonts).catch(function () {}).then(function () {
      requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(true); }); });
    });
  });
})()`)
    .catch(() => undefined);
}

/**
 * Shoot until the picture stops changing: repeat `shot` until two consecutive frames are
 * byte-identical, or the attempts run out (then the last frame is returned — best-effort, never
 * a failure). This is what makes a chart capture reliable: a redraw in progress differs frame to
 * frame, a finished one does not.
 *
 * A page with a genuinely animating pixel in the frame (a spinner, a live clock, a looping
 * gradient) can never be stable; it costs `attempts * intervalMs` and then captures anyway,
 * which is the same picture it would have taken without this.
 */
export async function captureStable(
  page: Page,
  shot: () => Promise<Buffer>,
  opts?: { attempts?: number; intervalMs?: number },
): Promise<Buffer> {
  const attempts = opts?.attempts ?? 4;
  const intervalMs = opts?.intervalMs ?? 250;
  let prev = await shot();
  for (let i = 0; i < attempts; i += 1) {
    await page.waitForTimeout(intervalMs);
    const next = await shot();
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev;
}

/**
 * Capture an element's FULL height even when it lives inside a shorter inner `overflow:auto` scroll
 * pane (Wisdom: a ~1900px answer inside a 704px `.scroll`). The element is already fully laid out —
 * only the pane hides it — so the reliable fix is to GROW THE BROWSER VIEWPORT until no scroll
 * ancestor still clips the target. In a viewport-height flex app the pane then expands and the whole
 * element becomes genuinely on-screen (so even off-screen-painted content like ECharts canvases
 * renders), and a normal `locator.screenshot()` gets everything. No DOM surgery — an earlier attempt
 * that rewrote ancestor `flex/height` reflowed the page and produced blank bands + wrong heights.
 * Viewport is restored afterwards. Capped for Chromium's screenshot-size limit.
 *
 * Pinned chrome is neutralized around the whole sequence (including the measurement, which must
 * see the layout the shot will be taken against), and the frame is settled before it is kept.
 */
export async function captureFullElement(
  page: Page,
  locator: Locator,
  selector?: string,
): Promise<Buffer> {
  const orig = page.viewportSize();
  if (!orig) return withOverlaysNeutralized(page, selector, () => captureStable(page, () => locator.screenshot()));
  const CAP = 16_000; // device px; keeps the DPR-scaled bitmap under Chromium's ~32767 limit
  // Total clip deficit across the target's scroll ancestors — how much taller the viewport must be
  // so nothing clips it. Raw-string expression (browser context, no DOM lib / `__name` issues).
  const deficitSrc = selector
    ? `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return 0;var d=0;for(var n=el.parentElement;n;n=n.parentElement){var cs=getComputedStyle(n);if(/(auto|scroll)/.test(cs.overflowY)&&n.scrollHeight>n.clientHeight+1)d+=n.scrollHeight-n.clientHeight;}return d;})()`
    : null;
  try {
    return await withOverlaysNeutralized(page, selector, async () => {
      if (deficitSrc) {
        // Iterate: grow by the deficit, remeasure (reflow can reveal more), until nothing clips it.
        for (let i = 0; i < 4; i += 1) {
          const deficit = (await page.evaluate(deficitSrc).catch(() => 0)) as number;
          const cur = page.viewportSize()?.height ?? orig.height;
          if (!deficit || deficit <= 1 || cur >= CAP) break;
          await page.setViewportSize({ width: orig.width, height: Math.min(CAP, cur + deficit + 120) });
          await settleLayout(page); // reflow + any container-resize-driven chart re-render
        }
      } else {
        // No stable selector to measure — grow once by a generous amount as a best-effort.
        await page.setViewportSize({ width: orig.width, height: CAP });
        await settleLayout(page);
      }
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      await settleLayout(page);
      return await captureStable(page, () => locator.screenshot());
    });
  } finally {
    await page.setViewportSize(orig).catch(() => undefined);
  }
}

/**
 * Full-page capture, settled before it is kept.
 *
 * Deliberately does NOT neutralize pinned chrome: Chromium's beyond-viewport capture already
 * paints a fixed/sticky element once, at the scroll position the shot starts from, so a full-page
 * shot does not suffer the stamped-across-the-content problem an element crop does — and hiding
 * an app's fixed nav here would quietly drop it from every full-page baseline.
 */
export async function captureFullPage(page: Page): Promise<Buffer> {
  return captureStable(page, () => page.screenshot({ fullPage: true }));
}

/** Region capture (a rect in page space), settled before it is kept. */
export async function captureRegion(
  page: Page,
  rect: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  return captureStable(page, () => page.screenshot({ clip: rect }));
}
