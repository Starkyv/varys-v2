import { captureFingerprint } from "@varys/capture";
import {
  applySelectorRemedy,
  classifyTypedValue,
  isWeakFingerprint,
  type OnStep,
  type RecordedSession,
  selectorDependsOnVariable,
  startRecorder,
  variableNameFor,
} from "@varys/recorder";

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

    // Last non-password typed value + how it was classified, for the one-tap confirm.
    let lastTyped: { el: HTMLInputElement; raw: string; kind: "variable" | "static" } | null = null;
    // Variable name → the value the author entered for it, so the selector guard can
    // spot a later locator that leans on that (environment-specific) text.
    const knownVars = new Map<string, string>();
    let guardBanner: HTMLElement | null = null;

    let host: HTMLElement | null = null;
    let statusEl: HTMLElement;
    let resultEl: HTMLElement;
    let confirmEl: HTMLElement;
    let startBtn: HTMLButtonElement;
    let shotBtn: HTMLButtonElement;
    let nameEl: HTMLInputElement;
    let saveBtn: HTMLButtonElement;
    let cancelBtn: HTMLButtonElement;
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
      // The recorder owns step capture; the classifier (heuristic by default) decides
      // whether a typed value is tokenized. A parallel passive listener stashes the
      // last typed value so the overlay can offer a one-tap Variable/Static flip.
      session = startRecorder(
        captureFingerprint,
        document,
        (e) => busy || isOverlay(e),
        shipStep,
        classifyTypedValue,
      );
      document.addEventListener("change", onTypedForConfirm, true);
    };

    // --- one-tap Variable/Static confirm ---------------------------------------
    const escapeHtml = (s: string) =>
      s.replace(/[&<>"]/g, (c) =>
        c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
      );

    const onTypedForConfirm = (e: Event) => {
      if (busy || isOverlay(e)) return;
      const el = e.target as HTMLInputElement | null;
      if (!el || el.type === "password") return; // passwords are always secrets
      const kind = classifyTypedValue(el.value);
      lastTyped = { el, raw: el.value, kind };
      // Remember values recorded as variables, so the selector guard can match them.
      if (kind === "variable") knownVars.set(variableNameFor(el), el.value);
      renderConfirm();
    };

    /** Flip the most-recent typed value between Variable and Static, then ask the
     *  background to rewrite that `type` step (variables are re-derived on save). */
    const flipTyped = (kind: "variable" | "static") => {
      if (!lastTyped) return;
      const name = variableNameFor(lastTyped.el);
      const value = kind === "variable" ? `{{${name}}}` : lastTyped.raw;
      const step = { type: "type" as const, target: captureFingerprint(lastTyped.el), value };
      void browser.runtime.sendMessage({ type: "varys:replace-last-type", step });
      if (kind === "variable") knownVars.set(name, lastTyped.raw);
      else knownVars.delete(name);
      lastTyped = { ...lastTyped, kind };
      renderConfirm();
    };

    const renderConfirm = () => {
      if (!confirmEl) return;
      if (!recording || !lastTyped) {
        confirmEl.innerHTML = "";
        return;
      }
      const shown = lastTyped.raw.length > 24 ? `${lastTyped.raw.slice(0, 24)}…` : lastTyped.raw;
      confirmEl.innerHTML =
        `<span class="clabel">“${escapeHtml(shown)}” →</span>` +
        `<button class="cbtn cvar" aria-pressed="${lastTyped.kind === "variable"}">Variable</button>` +
        `<button class="cbtn cstat" aria-pressed="${lastTyped.kind === "static"}">Static</button>`;
      (confirmEl.querySelector(".cvar") as HTMLElement).addEventListener("click", () =>
        flipTyped("variable"),
      );
      (confirmEl.querySelector(".cstat") as HTMLElement).addEventListener("click", () =>
        flipTyped("static"),
      );
    };

    // --- selector guard (locators that lean on environment-specific text) ------
    /** Commit an element checkpoint, first guarding against a locator whose visible
     *  text matches a recorded variable value (it would break in another environment).
     *  On a hit, offer bind / structural / keep before committing the (remedied) target. */
    const commitElementCheckpoint = (name: string, el: Element, masks: Box[]) => {
      if (!session) return;
      const fp = captureFingerprint(el);
      const hit = knownVars.size
        ? selectorDependsOnVariable(
            fp,
            [...knownVars].map(([n, value]) => ({ name: n, value })),
          )
        : null;
      if (!hit) {
        session.checkpoint(name, { el, masks });
        return;
      }
      showSelectorGuard(hit, (remedy) => {
        const target = remedy === "keep" ? fp : applySelectorRemedy(fp, remedy, hit);
        session?.checkpoint(name, { el, masks, target });
      });
    };

    const showSelectorGuard = (
      hit: { signal: string; value: string; variable: string },
      choose: (remedy: "bind" | "structural" | "keep") => void,
    ) => {
      guardBanner?.remove();
      guardBanner = document.createElement("div");
      guardBanner.style.cssText =
        "position: fixed; z-index: 2147483647; top: 16px; left: 50%; transform: translateX(-50%);" +
        " background: #7a2e0e; color: #fff; padding: 10px 14px; border-radius: 8px; font: 12px system-ui;" +
        " display: flex; gap: 8px; align-items: center; max-width: 90vw; flex-wrap: wrap;" +
        " box-shadow: 0 4px 16px rgba(0,0,0,.3);";
      guardBanner.innerHTML =
        `<span>⚠︎ Locator leans on the text “${escapeHtml(hit.value)}”, which varies by environment.</span>` +
        `<button class="g-bind" style="font:inherit;cursor:pointer">Bind to {{${escapeHtml(hit.variable)}}}</button>` +
        `<button class="g-struct" style="font:inherit;cursor:pointer">Use structural locator</button>` +
        `<button class="g-keep" style="font:inherit;cursor:pointer">Keep as-is</button>`;
      const finish = (remedy: "bind" | "structural" | "keep") => {
        guardBanner?.remove();
        guardBanner = null;
        choose(remedy);
        render();
      };
      (guardBanner.querySelector(".g-bind") as HTMLElement).addEventListener("click", () =>
        finish("bind"),
      );
      (guardBanner.querySelector(".g-struct") as HTMLElement).addEventListener("click", () =>
        finish("structural"),
      );
      (guardBanner.querySelector(".g-keep") as HTMLElement).addEventListener("click", () =>
        finish("keep"),
      );
      document.documentElement.appendChild(guardBanner);
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
      // Warn now if the element has no durable anchor (no testId/id/role; only
      // hashed classes or volatile text) — it likely won't be found on later runs.
      const weak = isWeakFingerprint(captureFingerprint(el));
      enterMasking("element", el.getBoundingClientRect(), { el, weak });
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
      what: { el?: Element; rect?: Box; weak?: boolean },
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
        ` background: ${what.weak ? "#7a2e0e" : "#111"}; color: #fff; padding: 8px 12px;` +
        " border-radius: 8px; font: 12px system-ui; display: flex; gap: 8px; align-items: center;" +
        " flex-wrap: wrap; max-width: 90vw; box-shadow: 0 4px 16px rgba(0,0,0,.3);";
      maskBanner.innerHTML =
        // Weak-fingerprint warning (own line): no durable anchor → likely unmatchable later.
        (what.weak
          ? `<span style="flex-basis:100%">⚠︎ Weak selector — no stable id / role / test-id. This element may not be found on later runs; re-pick a stabler element (or add a data-testid), or capture anyway.</span>`
          : "") +
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
        else if (ctx.el) commitElementCheckpoint(nextName(), ctx.el, masks);
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
      lastTyped = null;
      knownVars.clear();
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
      document.removeEventListener("change", onTypedForConfirm, true);
      lastTyped = null;
      knownVars.clear();
      guardBanner?.remove();
      guardBanner = null;
      stopBusy();
      recording = false;
      void browser.runtime.sendMessage({ type: "varys:stop" });
      render();
    };

    /** Tear down the live recording and wipe the store — back to a clean slate.
     *  Leaves the result line alone so callers can show their own message. */
    const discard = () => {
      session?.stop();
      session = null;
      document.removeEventListener("change", onTypedForConfirm, true);
      stopBusy();
      guardBanner?.remove();
      guardBanner = null;
      recording = false;
      totalSteps = 0;
      screenshots = 0;
      lastTyped = null;
      knownVars.clear();
      void browser.runtime.sendMessage({ type: "varys:clear" });
    };

    /** Discard the current recording (in-progress or stopped-but-unsaved) and reset
     *  to idle. Confirms first when there's recorded work to lose. */
    const cancel = () => {
      if (totalSteps > 0 && !window.confirm("Discard the current recording? This can’t be undone.")) {
        return;
      }
      discard();
      resultEl.textContent = "";
      render();
    };

    const save = async () => {
      const name = nameEl.value.trim();
      if (!name) {
        // A name is required before saving — surface it and focus the field.
        resultEl.textContent = "Enter a test name before saving.";
        nameEl.focus();
        return;
      }
      resultEl.textContent = "Saving…";
      // biome-ignore lint/suspicious/noExplicitAny: cross-context message response
      const res: any = await browser.runtime.sendMessage({ type: "varys:save", name });
      if (res?.ok) {
        // Saved → clear the recording so it doesn't linger into the next session.
        discard();
        nameEl.value = "";
        resultEl.textContent = `Saved ✓  test ${res.id ?? ""}`;
        render();
      } else {
        resultEl.textContent = `Save failed: ${res?.error ?? `HTTP ${res?.status}`}`;
      }
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
      // Save requires both recorded steps and a non-empty test name.
      saveBtn.disabled = totalSteps === 0 || nameEl.value.trim() === "";
      // Discard the current recording: "Cancel" while live, "Clear" once stopped.
      cancelBtn.textContent = recording ? "✕ Cancel recording" : "✕ Clear recording";
      cancelBtn.disabled = busy || (!recording && totalSteps === 0);
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
      renderConfirm();
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
          .cancel { color: #b00020; border-color: #f0c0c0; }
          .confirm { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 6px 0 0;
                     font-size: 11px; }
          .confirm:empty { margin: 0; }
          .clabel { color: #555; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
          .cbtn { border: 1px solid #d0d7de; background: #fff; border-radius: 6px; padding: 3px 8px;
                  font: inherit; font-size: 11px; cursor: pointer; }
          .cbtn[aria-pressed="true"] { background: #1f6feb; color: #fff; border-color: #1f6feb; }
          .namelabel { display: block; font-size: 11px; color: #555; margin: 8px 0 0; }
          .name { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 8px;
                  border: 1px solid #d0d7de; border-radius: 6px; font: inherit; font-size: 12px; }
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
          <div class="confirm"></div>
          <label class="namelabel">Test name
            <input class="name" type="text" placeholder="e.g. Login + briefs" />
          </label>
          <button class="action save">Save test</button>
          <button class="action cancel">✕ Clear recording</button>
          <p class="result"></p>
        </div>`;
      document.documentElement.appendChild(host);

      statusEl = shadow.querySelector(".status") as HTMLElement;
      resultEl = shadow.querySelector(".result") as HTMLElement;
      confirmEl = shadow.querySelector(".confirm") as HTMLElement;
      startBtn = shadow.querySelector(".start") as HTMLButtonElement;
      shotBtn = shadow.querySelector(".shot") as HTMLButtonElement;
      nameEl = shadow.querySelector(".name") as HTMLInputElement;
      saveBtn = shadow.querySelector(".save") as HTMLButtonElement;
      cancelBtn = shadow.querySelector(".cancel") as HTMLButtonElement;
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
      // Re-render on input so Save enables/disables as the name field fills/empties.
      nameEl.addEventListener("input", () => render());
      saveBtn.addEventListener("click", () => void save());
      cancelBtn.addEventListener("click", () => cancel());
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
