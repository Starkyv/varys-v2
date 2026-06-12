import { captureFingerprint } from "@varys/capture";
import { type RecordedSession, startRecorder } from "@varys/recorder";

/**
 * Content script: an in-page recorder overlay (so the controls stay put when you
 * click the page — unlike a popup, which Chrome dismisses on blur).
 *
 * Flow: click the toolbar icon to toggle the panel → Start recording (every click
 * and typed value is captured automatically) → press 📷 Capture whenever you want
 * to snapshot an element → Save. The toolbar icon toggles the panel via a message
 * from the background worker.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    let session: RecordedSession | null = null;
    let picking = false;
    let screenshots = 0;

    let host: HTMLElement | null = null;
    let statusEl: HTMLElement;
    let resultEl: HTMLElement;
    let startBtn: HTMLButtonElement;
    let shotBtn: HTMLButtonElement;
    let saveBtn: HTMLButtonElement;
    let highlighted: HTMLElement | null = null;

    /** True for events that originate inside our own overlay (so we never record
     *  or screenshot the panel itself). composedPath crosses the shadow boundary. */
    const isOverlay = (e: Event): boolean => !!host && e.composedPath().includes(host);

    // --- on-demand element picking ---------------------------------------------
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
      session?.checkpoint(e.target as Element, `screenshot-${++screenshots}`);
      stopPicking();
      render();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && picking) {
        stopPicking();
        render();
      }
    };

    const startPicking = () => {
      if (!session) return;
      picking = true;
      document.addEventListener("mousemove", onHover, true);
      document.addEventListener("click", onPick, true);
      document.addEventListener("keydown", onKey, true);
      render();
    };

    const stopPicking = () => {
      picking = false;
      document.removeEventListener("mousemove", onHover, true);
      document.removeEventListener("click", onPick, true);
      document.removeEventListener("keydown", onKey, true);
      clearHighlight();
    };

    // --- recording controls -----------------------------------------------------
    const start = () => {
      screenshots = 0;
      resultEl.textContent = "";
      // Ignore clicks on our own panel and clicks made while picking a screenshot.
      session = startRecorder(captureFingerprint, document, (e) => picking || isOverlay(e));
      render();
    };

    const stop = () => {
      session?.stop();
      stopPicking();
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

    // --- overlay UI -------------------------------------------------------------
    const render = () => {
      if (!host) return;
      const recording = !!session;
      startBtn.textContent = recording ? "■ Stop recording" : "● Start recording";
      shotBtn.disabled = !recording || picking;
      saveBtn.disabled = !recording;
      statusEl.textContent = picking
        ? "Click an element to screenshot · Esc to cancel"
        : recording
          ? `Recording · ${session?.stepCount() ?? 0} actions · ${screenshots} screenshot${screenshots === 1 ? "" : "s"}`
          : "Idle. Press Start, then use the page normally. Press 📷 to snapshot an element whenever you like.";
    };

    const mount = () => {
      host = document.createElement("div");
      host.id = "varys-recorder-overlay";
      host.style.cssText =
        "all: initial; position: fixed; z-index: 2147483647; bottom: 16px; right: 16px;";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          .panel { font-family: system-ui, -apple-system, sans-serif; width: 248px; background: #fff;
                   color: #111; border: 1px solid #d0d7de; border-radius: 10px;
                   box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 12px; }
          .row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
          .title { font-weight: 600; font-size: 13px; }
          .close { cursor: pointer; border: 0; background: none; font-size: 18px; line-height: 1; color: #666; }
          .status { font-size: 11px; color: #555; margin: 0 0 10px; min-height: 30px; }
          .result { font-size: 11px; color: #1a7f37; margin: 8px 0 0; min-height: 14px; }
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
          <button class="action shot">📷 Capture screenshot</button>
          <button class="action save">Save test</button>
          <p class="result"></p>
        </div>`;
      document.documentElement.appendChild(host);

      statusEl = shadow.querySelector(".status") as HTMLElement;
      resultEl = shadow.querySelector(".result") as HTMLElement;
      startBtn = shadow.querySelector(".start") as HTMLButtonElement;
      shotBtn = shadow.querySelector(".shot") as HTMLButtonElement;
      saveBtn = shadow.querySelector(".save") as HTMLButtonElement;

      (shadow.querySelector(".close") as HTMLElement).addEventListener("click", () => {
        if (host) host.style.display = "none";
      });
      startBtn.addEventListener("click", () => (session ? stop() : start()));
      shotBtn.addEventListener("click", () => startPicking());
      saveBtn.addEventListener("click", () => void save());
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
      if (host && host.style.display !== "none" && session && !picking) render();
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
