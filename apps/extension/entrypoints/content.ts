import { captureFingerprint } from "@varys/capture";
import { type RecordedSession, startRecorder } from "@varys/recorder";

type CaptureMode = "element" | "region" | "fullpage";

/**
 * Content script: an in-page recorder overlay (so the controls stay put when you
 * click the page — unlike a popup, which Chrome dismisses on blur).
 *
 * Flow: click the toolbar icon to toggle the panel → Start recording (every click
 * and typed value is captured automatically) → pick a capture mode (element /
 * region / full page) and press 📷 Capture → Save. The toolbar icon toggles the
 * panel via a message from the background worker.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    let session: RecordedSession | null = null;
    let busy = false; // picking an element or drawing a region — recorder ignores these
    let mode: CaptureMode = "element";
    let screenshots = 0;

    let host: HTMLElement | null = null;
    let statusEl: HTMLElement;
    let resultEl: HTMLElement;
    let startBtn: HTMLButtonElement;
    let shotBtn: HTMLButtonElement;
    let saveBtn: HTMLButtonElement;
    let modeBtns: Record<CaptureMode, HTMLButtonElement>;
    let highlighted: HTMLElement | null = null;
    let regionBox: HTMLElement | null = null;
    let regionStart: { x: number; y: number } | null = null;

    /** True for events inside our overlay (never record/capture the panel itself). */
    const isOverlay = (e: Event): boolean => !!host && e.composedPath().includes(host);

    const nextName = () => `screenshot-${++screenshots}`;

    // --- element picking --------------------------------------------------------
    const clearHighlight = () => {
      if (highlighted) {
        highlighted.style.outline = highlighted.dataset.varysOutline ?? "";
        highlighted.style.outlineOffset = "";
      }
      highlighted = null;
    };

    const onHover = (e: MouseEvent) => {
      if (isOverlay(e)) return;
      clearHighlight();
      const el = e.target as HTMLElement;
      el.dataset.varysOutline = el.style.outline;
      el.style.outline = "2px solid #1f6feb";
      el.style.outlineOffset = "-2px";
      highlighted = el;
    };

    const onPick = (e: MouseEvent) => {
      if (isOverlay(e)) return;
      e.preventDefault();
      e.stopPropagation();
      session?.checkpoint(nextName(), { el: e.target as Element });
      stopBusy();
      render();
    };

    const startPicking = () => {
      busy = true;
      document.addEventListener("mousemove", onHover, true);
      document.addEventListener("click", onPick, true);
      document.addEventListener("keydown", onKey, true);
      render();
    };

    // --- region drawing (rubber-band) ------------------------------------------
    const onRegionDown = (e: MouseEvent) => {
      if (isOverlay(e)) return;
      e.preventDefault();
      e.stopPropagation();
      regionStart = { x: e.clientX, y: e.clientY };
      regionBox = document.createElement("div");
      regionBox.style.cssText =
        "position: fixed; z-index: 2147483646; border: 2px dashed #1f6feb;" +
        " background: rgba(31,111,235,.12); pointer-events: none;";
      document.documentElement.appendChild(regionBox);
      positionRegionBox(e.clientX, e.clientY);
    };

    const positionRegionBox = (x: number, y: number) => {
      if (!regionBox || !regionStart) return;
      const left = Math.min(regionStart.x, x);
      const top = Math.min(regionStart.y, y);
      regionBox.style.left = `${left}px`;
      regionBox.style.top = `${top}px`;
      regionBox.style.width = `${Math.abs(x - regionStart.x)}px`;
      regionBox.style.height = `${Math.abs(y - regionStart.y)}px`;
    };

    const onRegionMove = (e: MouseEvent) => {
      if (regionStart) positionRegionBox(e.clientX, e.clientY);
    };

    const onRegionUp = (e: MouseEvent) => {
      if (!regionStart) return;
      e.preventDefault();
      e.stopPropagation();
      // Region rect in page (document) coordinates — what page.screenshot({clip}) uses.
      const left = Math.min(regionStart.x, e.clientX) + window.scrollX;
      const top = Math.min(regionStart.y, e.clientY) + window.scrollY;
      const width = Math.abs(e.clientX - regionStart.x);
      const height = Math.abs(e.clientY - regionStart.y);
      if (width >= 4 && height >= 4) {
        session?.checkpoint(nextName(), {
          mode: "region",
          rect: { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) },
        });
      }
      stopBusy();
      render();
    };

    const startRegionDraw = () => {
      busy = true;
      document.addEventListener("mousedown", onRegionDown, true);
      document.addEventListener("mousemove", onRegionMove, true);
      document.addEventListener("mouseup", onRegionUp, true);
      document.addEventListener("keydown", onKey, true);
      render();
    };

    // --- shared busy teardown ---------------------------------------------------
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && busy) {
        stopBusy();
        render();
      }
    };

    const stopBusy = () => {
      busy = false;
      document.removeEventListener("mousemove", onHover, true);
      document.removeEventListener("click", onPick, true);
      document.removeEventListener("mousedown", onRegionDown, true);
      document.removeEventListener("mousemove", onRegionMove, true);
      document.removeEventListener("mouseup", onRegionUp, true);
      document.removeEventListener("keydown", onKey, true);
      clearHighlight();
      regionBox?.remove();
      regionBox = null;
      regionStart = null;
    };

    // --- capture dispatch -------------------------------------------------------
    const capture = () => {
      if (!session || busy) return;
      if (mode === "fullpage") {
        session.checkpoint(nextName(), { mode: "fullpage" });
        render();
      } else if (mode === "region") {
        startRegionDraw();
      } else {
        startPicking();
      }
    };

    // --- recording controls -----------------------------------------------------
    const start = () => {
      screenshots = 0;
      resultEl.textContent = "";
      session = startRecorder(captureFingerprint, document, (e) => busy || isOverlay(e));
      render();
    };

    const stop = () => {
      session?.stop();
      stopBusy();
      render();
    };

    const save = async () => {
      if (!session) return;
      const definition = session.getDefinition("recorded", {
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio,
      });
      resultEl.textContent = "Saving…";
      // biome-ignore lint/suspicious/noExplicitAny: cross-context message response
      const res: any = await browser.runtime.sendMessage({ type: "varys:save", definition });
      resultEl.textContent = res?.ok
        ? `Saved ✓  test ${res.id ?? ""}`
        : `Save failed: ${res?.error ?? `HTTP ${res?.status}`}`;
    };

    const setMode = (m: CaptureMode) => {
      mode = m;
      if (busy) stopBusy();
      render();
    };

    // --- overlay UI -------------------------------------------------------------
    const captureLabel = (): string =>
      mode === "fullpage"
        ? "📷 Capture full page"
        : mode === "region"
          ? "📷 Draw a region"
          : "📷 Capture an element";

    const render = () => {
      if (!host) return;
      const recording = !!session;
      startBtn.textContent = recording ? "■ Stop recording" : "● Start recording";
      shotBtn.disabled = !recording || busy;
      shotBtn.textContent = captureLabel();
      saveBtn.disabled = !recording;
      for (const m of ["element", "region", "fullpage"] as CaptureMode[]) {
        modeBtns[m].setAttribute("aria-pressed", String(mode === m));
        modeBtns[m].disabled = busy;
      }
      statusEl.textContent = busy
        ? mode === "region"
          ? "Drag a rectangle on the page · Esc to cancel"
          : "Click an element to screenshot · Esc to cancel"
        : recording
          ? `Recording · ${session?.stepCount() ?? 0} actions · ${screenshots} screenshot${screenshots === 1 ? "" : "s"}`
          : "Idle. Press Start, then use the page. Pick a mode and 📷 to snapshot whenever.";
    };

    const mount = () => {
      host = document.createElement("div");
      host.id = "varys-recorder-overlay";
      host.style.cssText =
        "all: initial; position: fixed; z-index: 2147483647; bottom: 16px; right: 16px;";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          .panel { font-family: system-ui, -apple-system, sans-serif; width: 256px; background: #fff;
                   color: #111; border: 1px solid #d0d7de; border-radius: 10px;
                   box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 12px; }
          .row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
          .title { font-weight: 600; font-size: 13px; }
          .close { cursor: pointer; border: 0; background: none; font-size: 18px; line-height: 1; color: #666; }
          .status { font-size: 11px; color: #555; margin: 0 0 10px; min-height: 30px; }
          .result { font-size: 11px; color: #1a7f37; margin: 8px 0 0; min-height: 14px; }
          .modes { display: flex; gap: 0; margin: 0 0 8px; border: 1px solid #d0d7de;
                   border-radius: 6px; overflow: hidden; }
          .modes button { flex: 1; border: 0; background: #fff; padding: 6px 4px; font: inherit;
                          font-size: 11px; cursor: pointer; }
          .modes button + button { border-left: 1px solid #d0d7de; }
          .modes button[aria-pressed="true"] { background: #1f6feb; color: #fff; }
          .modes button:disabled { opacity: .5; cursor: default; }
          button.action { display: block; width: 100%; margin: 4px 0; padding: 8px; border-radius: 6px;
                          border: 1px solid #d0d7de; background: #f6f8fa; font: inherit; font-size: 12px;
                          cursor: pointer; }
          button.action:disabled { opacity: .5; cursor: default; }
          .start { background: #1f6feb; color: #fff; border-color: #1f6feb; }
        </style>
        <div class="panel">
          <div class="row">
            <span class="title">Varys recorder</span>
            <button class="close" title="Hide">×</button>
          </div>
          <p class="status"></p>
          <button class="action start">● Start recording</button>
          <div class="modes">
            <button class="m-element" aria-pressed="true">Element</button>
            <button class="m-region" aria-pressed="false">Region</button>
            <button class="m-fullpage" aria-pressed="false">Full page</button>
          </div>
          <button class="action shot">📷 Capture an element</button>
          <button class="action save">Save test</button>
          <p class="result"></p>
        </div>`;
      document.documentElement.appendChild(host);

      statusEl = shadow.querySelector(".status") as HTMLElement;
      resultEl = shadow.querySelector(".result") as HTMLElement;
      startBtn = shadow.querySelector(".start") as HTMLButtonElement;
      shotBtn = shadow.querySelector(".shot") as HTMLButtonElement;
      saveBtn = shadow.querySelector(".save") as HTMLButtonElement;
      modeBtns = {
        element: shadow.querySelector(".m-element") as HTMLButtonElement,
        region: shadow.querySelector(".m-region") as HTMLButtonElement,
        fullpage: shadow.querySelector(".m-fullpage") as HTMLButtonElement,
      };

      (shadow.querySelector(".close") as HTMLElement).addEventListener("click", () => {
        if (host) host.style.display = "none";
      });
      startBtn.addEventListener("click", () => (session ? stop() : start()));
      shotBtn.addEventListener("click", () => capture());
      saveBtn.addEventListener("click", () => void save());
      modeBtns.element.addEventListener("click", () => setMode("element"));
      modeBtns.region.addEventListener("click", () => setMode("region"));
      modeBtns.fullpage.addEventListener("click", () => setMode("fullpage"));
      render();
    };

    const toggle = () => {
      if (!host) {
        mount();
        return;
      }
      host.style.display = host.style.display === "none" ? "" : "none";
    };

    // Keep the live "N actions" counter fresh as the user clicks/types.
    setInterval(() => {
      if (host && host.style.display !== "none" && session && !busy) render();
    }, 500);

    browser.runtime.onMessage.addListener((msg: unknown) => {
      if ((msg as { type?: string } | null)?.type === "varys:toggle") {
        toggle();
        return Promise.resolve({ ok: true });
      }
      return undefined;
    });
  },
});
