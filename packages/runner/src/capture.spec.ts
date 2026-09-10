import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PNG } from "pngjs";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureFullElement } from "./capture";
import { trackInFlightRequests, waitForStreamIdle } from "./stream-idle";

/**
 * Browser-level regressions for the two capture defects that pixel-diff cannot tell you about,
 * because both produce a screenshot that is internally consistent and simply WRONG:
 * pinned chrome stamped across the content, and a frame taken before the chart finished
 * redrawing. Plus the stream gate, which is what decides there is anything worth capturing yet.
 */

/** A viewport-height app shell with sticky chrome top and bottom, around a tall answer — the
 *  shape of a Wisdom notebook, which is where these were reported. */
const APP_HTML = `<!doctype html><html><body style="margin:0;font:14px system-ui">
<div style="display:flex;flex-direction:column;min-height:100dvh">
  <header style="position:sticky;top:0;z-index:10;background:rgb(255,0,255);height:60px">TOPBAR</header>
  <div style="flex:1;overflow-y:auto">
    <div id="answer">${Array.from({ length: 40 }, () => `<p style="margin:0;height:40px;background:#fff">row</p>`).join("")}</div>
  </div>
  <footer style="position:sticky;bottom:0;background:rgb(0,255,255);height:80px">PROMPT BOX</footer>
</div>
<script>
window.startStream = function () {
  fetch('/stream').then(async function (r) {
    var reader = r.body.getReader();
    for (;;) { var c = await reader.read(); if (c.done) break; }
    document.body.setAttribute('data-stream', 'done');
  });
};
</script>
</body></html>`;

/** Chunk pauses that total more than `STREAM_IDLE_DEFAULTS.graceMs` (6s) with no DOM mutation
 *  and no loading marker — the case a DOM-only wait declares settled mid-answer. */
const CHUNKS = 3;
const CHUNK_PAUSE_MS = 2_500;

function colourAt(png: PNG, x: number, y: number): string {
  const i = (png.width * y + x) << 2;
  return `${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`;
}

describe("checkpoint capture", () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let origin: string;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        for (let i = 0; i < CHUNKS; i += 1) {
          await new Promise((r) => setTimeout(r, CHUNK_PAUSE_MS));
          res.write(`chunk${i}\n`);
        }
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(APP_HTML);
    });
    await new Promise<void>((r) => server.listen(0, r));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 900, height: 500 });
    trackInFlightRequests(page);
    await page.goto(origin);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it("captures the target's full height with no sticky chrome stamped across it", async () => {
    const shot = await captureFullElement(page, page.locator("#answer"), "#answer");
    const png = PNG.sync.read(shot);

    // 40 rows × 40px: the whole element, not the 500px the scroll pane showed.
    expect(png.height).toBeGreaterThan(1_500);
    const chrome: string[] = [];
    for (let y = 0; y < png.height; y += 2) {
      const c = colourAt(png, 10, y);
      if (c === "255,0,255" || c === "0,255,255") chrome.push(`${c}@${y}`);
    }
    expect(chrome).toEqual([]);
  }, 60_000);

  it("holds through a stream that pauses without any DOM loading marker", async () => {
    const started = Date.now();
    await page.evaluate("window.startStream()");
    await waitForStreamIdle(page, { timeoutMs: 30_000 });

    // The request had finished before the wait returned — not "the DOM went quiet during a pause".
    expect(await page.getAttribute("body", "data-stream")).toBe("done");
    expect(Date.now() - started).toBeGreaterThanOrEqual(CHUNKS * CHUNK_PAUSE_MS);
  }, 60_000);

  it("waits for a chart that only redraws after the capture resizes the viewport", async () => {
    // The marker bar is drawn hard against the canvas's CURRENT right edge, 400ms after a
    // resize. A shot taken before that redraw leaves white where the bar should be.
    await page.setContent(`<div id="card" style="padding:20px;background:#fff">
      <canvas id="c" width="800" height="200" style="width:100%;height:200px"></canvas></div>
      <script>
        var c = document.getElementById('c');
        function draw() {
          c.width = Math.round(c.getBoundingClientRect().width); c.height = 200;
          var g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, 200);
          g.fillStyle = 'rgb(255,0,0)'; g.fillRect(c.width - 20, 0, 20, 200);
        }
        draw();
        var t; addEventListener('resize', function () { clearTimeout(t); t = setTimeout(draw, 400); });
      </script>`);
    await page.setViewportSize({ width: 1_200, height: 500 });

    const png = PNG.sync.read(await captureFullElement(page, page.locator("#card"), "#card"));
    expect(colourAt(png, png.width - 25, Math.round(png.height / 2))).toBe("255,0,0");
  }, 60_000);
});
