import { captureFingerprint } from "@varys/capture";
import { type OnStep, type RecordedSession, startRecorder } from "@varys/recorder";

type CaptureMode = "element" | "region" | "fullpage";

/**
 * Content script: an in-page recorder overlay (so the controls stay put when you
 * click the page — unlike a popup, which Chrome dismisses on blur).
 *
 * The recording itself lives in the background worker (`storage.session`), not
 * here: a content script is destroyed and re-injected on every full page load, so
 * a login redirect would otherwise wipe the recording. Instead this per-page
 * instance ships each recorded step to the background as it happens, and on load
 * asks the background whether a recording is in progress — if so it re-mounts the
 * overlay and resumes capturing, so the panel and the steps survive the navigation.
 *
 * Flow: click the toolbar icon to toggle the panel → Start recording (every click
 * and typed value is captured automatically, across navigations) → pick a capture
 * mode (element / region / full page) and press 📷 Capture → Save.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    let session: RecordedSession | null = null; // this page's recorder, while recording
    let recording = false; // mirrors the background's recording flag
    let busy = false; // picking an element or drawing a region — recorder ignores these
    let mode: CaptureMode = "element";
    // Mirrors of the background's totals, seeded on load so counts/names continue
    // across navigations (screenshot N+1 stays unique after a page load).
    let totalSteps = 0;
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

    // Mask-drawing phase: after a target is designated, the author draws zero+ mask
    // rectangles over volatile sub-regions before the checkpoint is committed.
    type Box = { x: number; y: number; width: number; height: number };
    let masking = false;
    let maskCtx: { mode: CaptureMode; el?: Element; rect?: Box; dpr: number } | null = null;
    let pendingMasks: Box[] = []; // screenshot-pixel space, relative to the capture
    let maskLayer: HTMLElement | null = null; // bounded drawing surface (over the capture)
    let maskBanner: HTMLElement | null = null;
    let maskDraftEl: HTMLElement | null = null;
    let maskStart: { x: number; y: number } | null = null; // layer-relative CSS px

    /** True for events inside our overlay (never record/capture the panel itself). */
    const isOverlay = (e: Event): boolean => !!host && e.composedPath().includes(host);

    // Name from the running screenshot count (read before the step bumps it).
    const nextName = () => `screenshot-${screenshots + 1}`;

    // Ship every recorded step to the background (the canonical store) and keep
    // the local display mirrors in step. This is the single place counts advance.
    const shipStep: OnStep = (s) => {
      totalSteps += 1;
      if (s.type === "screenshot") screenshots += 1;
      void browser.runtime.sendMessage({ type: "varys:step", step: s });
    };

    const beginPageRecording = () => {
      session = startRecorder(captureFingerprint, document, (e) => busy || isOverlay(e), shipStep);
    };

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
      const el = e.target as Element;
      // Leave picking (keep busy) and move into mask-drawing over this element.
      document.removeEventListener("mousemove", onHover, true);
      document.removeEventListener("click", onPick, true);
      document.removeEventListener("keydown", onKey, true);
      clearHighlight();
      enterMasking("element", el.getBoundingClientRect(), { el });
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
      const leftV = Math.min(regionStart.x, e.clientX); // viewport coords
      const topV = Math.min(regionStart.y, e.clientY);
      const width = Math.abs(e.clientX - regionStart.x);
      const height = Math.abs(e.clientY - regionStart.y);
      document.removeEventListener("mousedown", onRegionDown, true);
      document.removeEventListener("mousemove", onRegionMove, true);
      document.removeEventListener("mouseup", onRegionUp, true);
      document.removeEventListener("keydown", onKey, true);
      regionBox?.remove();
      regionBox = null;
      regionStart = null;
      if (width < 4 || height < 4) {
        stopBusy();
        render();
        return;
      }
      // Region rect in page coords (what page.screenshot({clip}) uses); then mask over it.
      const rect: Box = {
        x: Math.round(leftV + window.scrollX),
        y: Math.round(topV + window.scrollY),
        width: Math.round(width),
        height: Math.round(height),
      };
      enterMasking("region", { left: leftV, top: topV, width, height }, { rect });
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

    // --- mask drawing (after a target is designated) ---------------------------
    type ViewportRect = { left: number; top: number; width: number; height: number };

    /** Begin the mask-drawing phase over a designated capture. `boxV` is where the
     *  capture sits in the viewport (so masks are drawn within it); `what` stashes the
     *  designated target for the eventual checkpoint. */
    const enterMasking = (
      modeOf: CaptureMode,
      boxV: ViewportRect,
      what: { el?: Element; rect?: Box },
    ) => {
      masking = true;
      busy = true;
      maskCtx = { mode: modeOf, el: what.el, rect: what.rect, dpr: window.devicePixelRatio };
      pendingMasks = [];

      maskLayer = document.createElement("div");
      maskLayer.style.cssText =
        `position: fixed; z-index: 2147483646; left:${boxV.left}px; top:${boxV.top}px;` +
        ` width:${boxV.width}px; height:${boxV.height}px; cursor: crosshair;` +
        " outline: 2px solid #1f6feb; background: rgba(31,111,235,.04);";
      maskLayer.addEventListener("mousedown", onMaskDown, true);
      maskLayer.addEventListener("mousemove", onMaskMove, true);
      maskLayer.addEventListener("mouseup", onMaskUp, true);
      document.documentElement.appendChild(maskLayer);

      maskBanner = document.createElement("div");
      maskBanner.style.cssText =
        "position: fixed; z-index: 2147483647; top: 16px; left: 50%; transform: translateX(-50%);" +
        " background: #111; color: #fff; padding: 8px 12px; border-radius: 8px; font: 12px system-ui;" +
        " display: flex; gap: 8px; align-items: center; box-shadow: 0 4px 16px rgba(0,0,0,.3);";
      maskBanner.innerHTML =
        `<span class="hint">Drag to mask volatile areas (<span class="n">0</span>), then Done</span>` +
        `<button class="clear" style="font:inherit;cursor:pointer">Clear</button>` +
        `<button class="done" style="font:inherit;cursor:pointer">Done</button>` +
        `<button class="cancel" style="font:inherit;cursor:pointer">Cancel</button>`;
      (maskBanner.querySelector(".clear") as HTMLElement).addEventListener("click", clearPendingMasks);
      (maskBanner.querySelector(".done") as HTMLElement).addEventListener("click", () => finishMasking(true));
      (maskBanner.querySelector(".cancel") as HTMLElement).addEventListener("click", () => finishMasking(false));
      document.documentElement.appendChild(maskBanner);

      document.addEventListener("keydown", onMaskKey, true);
      render();
    };

    const updateMaskCount = () => {
      const n = maskBanner?.querySelector(".n");
      if (n) n.textContent = String(pendingMasks.length);
    };

    const clearPendingMasks = () => {
      pendingMasks = [];
      // Remove drawn boxes but keep the draft element reference cleared.
      maskLayer?.querySelectorAll(".varys-mask").forEach((el) => el.remove());
      updateMaskCount();
    };

    const onMaskDown = (e: MouseEvent) => {
      if (!maskLayer) return;
      e.preventDefault();
      e.stopPropagation();
      const r = maskLayer.getBoundingClientRect();
      maskStart = { x: e.clientX - r.left, y: e.clientY - r.top };
      maskDraftEl = document.createElement("div");
      maskDraftEl.style.cssText =
        "position: absolute; border: 1px dashed #1f6feb; background: rgba(31,111,235,.25); pointer-events: none;";
      maskLayer.appendChild(maskDraftEl);
    };

    const onMaskMove = (e: MouseEvent) => {
      if (!maskStart || !maskDraftEl || !maskLayer) return;
      const r = maskLayer.getBoundingClientRect();
      const cx = Math.max(0, Math.min(r.width, e.clientX - r.left));
      const cy = Math.max(0, Math.min(r.height, e.clientY - r.top));
      const x = Math.min(maskStart.x, cx);
      const y = Math.min(maskStart.y, cy);
      maskDraftEl.style.left = `${x}px`;
      maskDraftEl.style.top = `${y}px`;
      maskDraftEl.style.width = `${Math.abs(cx - maskStart.x)}px`;
      maskDraftEl.style.height = `${Math.abs(cy - maskStart.y)}px`;
    };

    const onMaskUp = (e: MouseEvent) => {
      if (!maskStart || !maskLayer || !maskCtx) return;
      e.preventDefault();
      e.stopPropagation();
      const r = maskLayer.getBoundingClientRect();
      const cx = Math.max(0, Math.min(r.width, e.clientX - r.left));
      const cy = Math.max(0, Math.min(r.height, e.clientY - r.top));
      const lx = Math.min(maskStart.x, cx); // layer-relative CSS px
      const ly = Math.min(maskStart.y, cy);
      const w = Math.abs(cx - maskStart.x);
      const h = Math.abs(cy - maskStart.y);
      maskDraftEl?.remove();
      maskDraftEl = null;
      maskStart = null;
      if (w >= 4 && h >= 4) {
        // A full-page capture screenshots from page (0,0); element/region capture
        // from the target's own top-left — so only full-page adds the scroll offset.
        const sx = maskCtx.mode === "fullpage" ? window.scrollX : 0;
        const sy = maskCtx.mode === "fullpage" ? window.scrollY : 0;
        const dpr = maskCtx.dpr;
        pendingMasks.push({
          x: Math.round((lx + sx) * dpr),
          y: Math.round((ly + sy) * dpr),
          width: Math.round(w * dpr),
          height: Math.round(h * dpr),
        });
        const box = document.createElement("div");
        box.className = "varys-mask";
        box.style.cssText =
          `position: absolute; left:${lx}px; top:${ly}px; width:${w}px; height:${h}px;` +
          " border: 1px solid #1f6feb; background: rgba(31,111,235,.3); pointer-events: none;";
        maskLayer.appendChild(box);
        updateMaskCount();
      }
    };

    const onMaskKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") finishMasking(true);
      else if (e.key === "Escape") finishMasking(false);
    };

    /** Commit (or cancel) the checkpoint being masked, then tear the phase down. */
    const finishMasking = (commit: boolean) => {
      document.removeEventListener("keydown", onMaskKey, true);
      maskLayer?.remove();
      maskBanner?.remove();
      maskLayer = null;
      maskBanner = null;
      maskDraftEl = null;
      maskStart = null;
      const ctx = maskCtx;
      const masks = pendingMasks;
      maskCtx = null;
      pendingMasks = [];
      masking = false;
      busy = false;
      if (commit && ctx && session) {
        if (ctx.mode === "fullpage") session.checkpoint(nextName(), { mode: "fullpage", masks });
        else if (ctx.mode === "region" && ctx.rect)
          session.checkpoint(nextName(), { mode: "region", rect: ctx.rect, masks });
        else if (ctx.el) session.checkpoint(nextName(), { el: ctx.el, masks });
      }
      render();
    };

    // --- capture dispatch -------------------------------------------------------
    const capture = () => {
      if (!session || busy) return;
      if (mode === "fullpage") {
        enterMasking("fullpage", { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }, {});
      } else if (mode === "region") {
        startRegionDraw();
      } else {
        startPicking();
      }
    };

    // --- recording controls -----------------------------------------------------
    const start = async () => {
      resultEl.textContent = "";
      screenshots = 0;
      totalSteps = 0;
      // Clear the background's store first, then begin capturing — so the initial
      // navigate step (shipped by beginPageRecording) lands after the reset.
      await browser.runtime.sendMessage({
        type: "varys:start",
        name: "recorded",
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          deviceScaleFactor: window.devicePixelRatio,
        },
      });
      recording = true;
      beginPageRecording();
      render();
    };

    const stop = () => {
      session?.stop();
      session = null;
      stopBusy();
      recording = false;
      void browser.runtime.sendMessage({ type: "varys:stop" });
      render();
    };

    const save = async () => {
      resultEl.textContent = "Saving…";
      // biome-ignore lint/suspicious/noExplicitAny: cross-context message response
      const res: any = await browser.runtime.sendMessage({ type: "varys:save" });
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
      startBtn.textContent = recording ? "■ Stop recording" : "● Start recording";
      shotBtn.disabled = !recording || busy;
      shotBtn.textContent = captureLabel();
      saveBtn.disabled = totalSteps === 0;
      for (const m of ["element", "region", "fullpage"] as CaptureMode[]) {
        modeBtns[m].setAttribute("aria-pressed", String(mode === m));
        modeBtns[m].disabled = busy;
      }
      statusEl.textContent = masking
        ? "Draw masks over volatile areas · Done to capture · Esc to skip"
        : busy
          ? mode === "region"
            ? "Drag a rectangle on the page · Esc to cancel"
            : "Click an element to screenshot · Esc to cancel"
          : recording
            ? `Recording · ${totalSteps} actions · ${screenshots} screenshot${screenshots === 1 ? "" : "s"}`
            : "Idle. Press Start, then use the page — recording continues across logins. Pick a mode and 📷 to snapshot whenever.";
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
      startBtn.addEventListener("click", () => (recording ? stop() : void start()));
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
      if (host && host.style.display !== "none" && recording && !busy) render();
    }, 500);

    browser.runtime.onMessage.addListener((msg: unknown) => {
      if ((msg as { type?: string } | null)?.type === "varys:toggle") {
        toggle();
        return Promise.resolve({ ok: true });
      }
      return undefined;
    });

    // On (re)load, resume an in-progress recording: re-mount the overlay and pick
    // up capturing this page, seeding the counters so names/totals continue. This
    // is what makes the recording (and the panel) survive a login navigation.
    void (async () => {
      const st = (await browser.runtime.sendMessage({ type: "varys:state" })) as {
        recording?: boolean;
        stepCount?: number;
        screenshots?: number;
      } | null;
      if (st?.recording) {
        recording = true;
        totalSteps = st.stepCount ?? 0;
        screenshots = st.screenshots ?? 0;
        if (!host) mount();
        beginPageRecording();
        render();
      }
    })();
  },
});
