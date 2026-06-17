import { captureFingerprint } from "@varys/capture";
import {
  applySelectorRemedy,
  classifyTypedValue,
  isWeakFingerprint,
  type OnStep,
  selectorDependsOnVariable,
  variableNameFor,
} from "@varys/recorder";
import { type RecordedSession, startRecorder } from "@varys/recorder/dom";

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
    let wrapEl: HTMLElement;
    let panelEl: HTMLElement;
    let statusEl: HTMLElement;
    let authEl: HTMLElement | undefined;
    let authLabelEl: HTMLElement | undefined;
    let confirmEl: HTMLElement;
    let startBtn: HTMLButtonElement;
    let recLabelEl: HTMLElement;
    let shotBtn: HTMLButtonElement;
    let nameEl: HTMLInputElement;
    let saveBtn: HTMLButtonElement;
    let cancelBtn: HTMLButtonElement;
    let modeBtns: Record<CaptureMode, HTMLButtonElement>;
    let toastEl: HTMLElement | null = null;
    let toastMsgEl: HTMLElement;
    let collapsed = false;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;

    /** Transient confirmation toast under the bar (replaces the old result line). */
    const flash = (msg: string) => {
      if (!toastEl) return;
      if (!msg) {
        toastEl.classList.remove("show");
        return;
      }
      toastMsgEl.textContent = msg;
      toastEl.classList.add("show");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => toastEl?.classList.remove("show"), 2200);
    };
    let highlightBox: HTMLElement | null = null;
    let highlightLabel: HTMLElement | null = null;
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
      if (s.type === "screenshot") {
        screenshots += 1;
        flash("Snapshot captured");
        render();
      }
      void browser.runtime.sendMessage({ type: "varys:step", step: s }).catch(() => {});
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
      void browser.runtime.sendMessage({ type: "varys:replace-last-type", step }).catch(() => {});
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
      guardBanner.style.cssText = BANNER_CARD;
      guardBanner.innerHTML =
        `<span style="display:inline-flex;align-items:center;gap:7px;color:#454B58;">` +
        `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:#FEF3DA;color:#B5710F;flex:none;">⚠</span>` +
        `Locator leans on the text “${escapeHtml(hit.value)}”, which varies by environment.</span>` +
        `<button class="g-bind" style="${BTN_PRIMARY}">Bind to {{${escapeHtml(hit.variable)}}}</button>` +
        `<button class="g-struct" style="${BTN_SECONDARY}">Use structural locator</button>` +
        `<button class="g-keep" style="${BTN_GHOST}">Keep as-is</button>`;
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
    // A modern, minimalist hover highlight: a floating rounded violet outline that
    // tracks the element under the cursor (never mutates the page's own styles), plus
    // a small tag-name label — like a design-tool inspector.
    const FONT_STACK =
      "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, system-ui, sans-serif";
    // Inline button styles for the page-level banners (guard / mask), matching the
    // recorder bar. Inline so they win over any page CSS in the host document.
    const BANNER_CARD =
      "position: fixed; z-index: 2147483647; top: 16px; left: 50%; transform: translateX(-50%);" +
      ` background: #FFFFFF; color: #101322; padding: 9px 11px; border-radius: 12px; font: 13px/1.4 ${FONT_STACK};` +
      " display: flex; gap: 8px; align-items: center; flex-wrap: wrap; max-width: 90vw; box-sizing: border-box;" +
      " border: 1px solid #E7EAEF; box-shadow: 0 10px 30px rgba(16,24,40,0.14), 0 2px 6px rgba(16,24,40,0.06);";
    const BTN_PRIMARY = `height:32px;padding:0 13px;border:none;border-radius:8px;background:#5347CE;color:#fff;font-family:${FONT_STACK};font-size:12.5px;font-weight:600;cursor:pointer;`;
    const BTN_SECONDARY = `height:32px;padding:0 12px;border:1px solid #E7EAEF;border-radius:8px;background:#fff;color:#454B58;font-family:${FONT_STACK};font-size:12.5px;font-weight:500;cursor:pointer;`;
    const BTN_GHOST = `height:32px;padding:0 12px;border:1px solid transparent;border-radius:8px;background:transparent;color:#8A909E;font-family:${FONT_STACK};font-size:12.5px;font-weight:500;cursor:pointer;`;
    const BTN_DANGER = `height:32px;padding:0 12px;border:1px solid transparent;border-radius:8px;background:transparent;color:#D32F49;font-family:${FONT_STACK};font-size:12.5px;font-weight:500;cursor:pointer;`;

    /** A compact selector-ish descriptor: tag + #id + first class(es). */
    const describeEl = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      let cls = "";
      if (typeof el.className === "string" && el.className.trim()) {
        cls = `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`;
      }
      return `${tag}${id}${cls}`.slice(0, 64);
    };

    const ensureHighlight = () => {
      if (!highlightBox) {
        const el = document.createElement("div");
        el.style.cssText =
          "position: fixed; z-index: 2147483640; pointer-events: none;" +
          " border: 1.5px solid #5347CE; border-radius: 7px;" +
          " background: rgba(83,71,206,0.07); box-shadow: 0 0 0 1px rgba(255,255,255,0.55) inset;";
        document.documentElement.appendChild(el);
        highlightBox = el;
        // Enable smooth tracking only after the first placement, so it snaps onto the
        // first element instead of sliding in from the corner.
        requestAnimationFrame(() => {
          el.style.transition = "top .07s ease, left .07s ease, width .07s ease, height .07s ease";
        });
      }
      if (!highlightLabel) {
        highlightLabel = document.createElement("div");
        highlightLabel.style.cssText =
          "position: fixed; z-index: 2147483641; pointer-events: none; box-sizing: border-box;" +
          ` background: #5347CE; color: #fff; font: 600 11px/1.4 ${FONT_STACK};` +
          " padding: 3px 8px; border-radius: 6px; box-shadow: 0 2px 8px rgba(16,24,40,0.18);" +
          " white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis;";
        document.documentElement.appendChild(highlightLabel);
      }
    };

    const onHover = (e: MouseEvent) => {
      if (isOverlay(e)) return;
      const el = e.target as HTMLElement;
      if (!el || el === highlightBox || el === highlightLabel) return;
      ensureHighlight();
      const r = el.getBoundingClientRect();
      const box = highlightBox as HTMLElement;
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      const label = highlightLabel as HTMLElement;
      label.innerHTML =
        `<span>${escapeHtml(describeEl(el))}</span>` +
        `<span style="opacity:.62; margin-left:7px">${Math.round(r.width)} × ${Math.round(r.height)}</span>`;
      // Sit the label just above the box; tuck it inside the top edge when there's no room.
      label.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - 4))}px`;
      label.style.top = `${r.top > 26 ? r.top - 24 : r.top + 4}px`;
    };

    const clearHighlight = () => {
      highlightBox?.remove();
      highlightBox = null;
      highlightLabel?.remove();
      highlightLabel = null;
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
        "position: fixed; z-index: 2147483646; border: 1.5px solid #5347CE; border-radius: 7px;" +
        " background: rgba(83,71,206,0.10); box-shadow: 0 0 0 1px rgba(255,255,255,0.5) inset;" +
        " pointer-events: none;";
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
        ` width:${boxV.width}px; height:${boxV.height}px; cursor: crosshair; border-radius: 8px;` +
        " box-shadow: 0 0 0 1.5px #5347CE, 0 8px 30px rgba(16,24,40,0.10); background: rgba(83,71,206,0.04);";
      maskLayer.addEventListener("mousedown", onMaskDown, true);
      maskLayer.addEventListener("mousemove", onMaskMove, true);
      maskLayer.addEventListener("mouseup", onMaskUp, true);
      document.documentElement.appendChild(maskLayer);

      maskBanner = document.createElement("div");
      maskBanner.style.cssText = BANNER_CARD;
      maskBanner.innerHTML =
        // Weak-fingerprint warning (own line): no durable anchor → likely unmatchable later.
        (what.weak
          ? `<span style="flex-basis:100%;display:inline-flex;align-items:flex-start;gap:7px;color:#454B58;line-height:1.45;">` +
            `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:#FEF3DA;color:#B5710F;flex:none;">⚠</span>` +
            `Weak selector — no stable id / role / test-id. This element may not be found on later runs; re-pick a stabler element (or add a data-testid), or capture anyway.</span>`
          : "") +
        `<span class="hint" style="color:#454B58;">Drag to mask volatile areas (<span class="n" style="font-weight:600;color:#101322;">0</span>), then Done</span>` +
        `<button class="clear" style="${BTN_SECONDARY}">Clear</button>` +
        `<button class="done" style="${BTN_PRIMARY}">Done</button>` +
        `<button class="cancel" style="${BTN_GHOST}">Cancel</button>`;
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
        "position: absolute; border: 1.5px dashed #5347CE; background: rgba(83,71,206,0.18); border-radius: 4px; pointer-events: none;";
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
          " border: 1.5px solid #5347CE; background: rgba(83,71,206,0.26); border-radius: 4px; pointer-events: none;";
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
      flash("Recording started");
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
      void browser.runtime.sendMessage({ type: "varys:stop" }).catch(() => {});
      render();
      flash("Recording paused");
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
      void browser.runtime.sendMessage({ type: "varys:clear" }).catch(() => {});
    };

    /** Discard the current recording (in-progress or stopped-but-unsaved) and reset
     *  to idle. Confirms first when there's recorded work to lose. */
    const cancel = () => {
      if (totalSteps > 0 && !window.confirm("Discard the current recording? This can’t be undone.")) {
        return;
      }
      discard();
      render();
      flash("Recording cleared");
    };

    const save = async () => {
      const name = nameEl.value.trim();
      if (!name) {
        // A name is required before saving — surface it and focus the field.
        flash("Enter a test name first");
        nameEl.focus();
        return;
      }
      const shotCount = screenshots; // discard() resets this before we report it
      flash("Saving…");
      // biome-ignore lint/suspicious/noExplicitAny: cross-context message response
      const res: any = await browser.runtime.sendMessage({ type: "varys:save", name });
      if (res?.ok) {
        // Saved → clear the recording so it doesn't linger into the next session.
        discard();
        nameEl.value = "";
        render();
        flash(`Saved “${name}” · ${shotCount} shot${shotCount === 1 ? "" : "s"}`);
      } else {
        flash(`Save failed: ${res?.error ?? `HTTP ${res?.status}`}`);
      }
    };

    const setMode = (m: CaptureMode) => {
      mode = m;
      if (busy) stopBusy();
      render();
    };

    // Reflect the Varys sign-in state in the panel's Online/Offline marker. Driven by
    // the session cookie's presence (checked in the background) — signed out ⇒ a save
    // would be rejected (the API is deny-by-default), so the marker warns up front.
    const setAuth = (signedIn: boolean) => {
      if (!authEl || !authLabelEl) return;
      authEl.classList.toggle("online", signedIn);
      authEl.classList.toggle("offline", !signedIn);
      authLabelEl.textContent = signedIn ? "Online" : "Offline";
      authEl.title = signedIn
        ? "Signed in to Varys — recordings will save"
        : "Signed out — sign in to the Varys web app to save recordings";
    };

    // --- overlay UI -------------------------------------------------------------
    const render = () => {
      if (!host) return;
      // Record toggle: violet "Start" (round dot) ↔ red "Stop" (square) via class.
      panelEl.classList.toggle("is-recording", recording);
      recLabelEl.textContent = recording ? "Stop" : "Start";
      shotBtn.disabled = !recording || busy;
      shotBtn.title = recording ? `Capture the current ${mode}` : "Start recording to capture";
      // Save requires both recorded steps and a non-empty test name.
      saveBtn.disabled = totalSteps === 0 || nameEl.value.trim() === "";
      // Discard the current recording (in-progress or stopped-but-unsaved).
      cancelBtn.disabled = busy || (!recording && totalSteps === 0);
      for (const m of ["element", "region", "fullpage"] as CaptureMode[]) {
        modeBtns[m].setAttribute("aria-pressed", String(mode === m));
        modeBtns[m].disabled = busy;
      }
      statusEl.textContent = masking
        ? "Draw masks · Done to capture · Esc to skip"
        : busy
          ? mode === "region"
            ? "Drag a rectangle · Esc to cancel"
            : "Click an element · Esc to cancel"
          : recording
            ? `Recording… · ${screenshots} shot${screenshots === 1 ? "" : "s"}`
            : screenshots > 0
              ? `${screenshots} captured`
              : "Idle";
      renderConfirm();
    };

    const mount = () => {
      // Drop any orphaned host left by a previous (now-dead) content-script context
      // — e.g. after the extension was reloaded and a fresh script was injected.
      document.getElementById("varys-recorder-overlay")?.remove();
      host = document.createElement("div");
      host.id = "varys-recorder-overlay";
      host.style.cssText = "all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          * { box-sizing: border-box; }
          button, input { font-family: inherit; }
          .wrap { position: fixed; left: 50%; top: 0; z-index: 2147483647;
                  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, system-ui, sans-serif; }

          .bar { display: inline-flex; align-items: center; background: #FFFFFF; border: 1px solid #E7EAEF;
                 border-radius: 16px; padding: 9px 10px; white-space: nowrap;
                 box-shadow: 0 10px 30px rgba(16,24,40,0.14), 0 2px 6px rgba(16,24,40,0.06); }
          .wrap.collapsed .bar, .wrap.collapsed .confirm, .wrap.collapsed .toast { display: none; }

          /* Grip + brand (drag handle) */
          .grip { display: flex; align-items: center; gap: 9px; padding: 4px 6px 4px 4px; cursor: grab; touch-action: none; }
          .dots { display: grid; grid-template-columns: repeat(2, 3px); grid-auto-rows: 3px; gap: 3px; }
          .dots span { background: #C7CCD6; border-radius: 9999px; }
          .logo { width: 30px; height: 30px; border-radius: 8px; background: #5347CE; display: flex; align-items: center;
                  justify-content: center; color: #fff; font-weight: 700; font-size: 16px; flex: none; }
          .brand { display: flex; flex-direction: column; gap: 3px; }
          .bname { font-size: 13px; font-weight: 600; color: #101322; line-height: 1; }
          .statusline { display: flex; align-items: center; gap: 5px; }
          .dot { display: inline-block; width: 8px; height: 8px; border-radius: 9999px; background: #A0A6B2; flex: none; }
          .status { font-size: 11px; color: #8A909E; line-height: 1; white-space: nowrap; }

          /* Signed-in / signed-out marker */
          .auth { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; margin-left: 9px;
                  border-radius: 9999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
          .auth-dot { width: 7px; height: 7px; border-radius: 9999px; background: #C7CCD6; flex: none; }
          .auth.online { background: #E7F7EF; color: #128A5B; }
          .auth.online .auth-dot { background: #19B26B; }
          .auth.offline { background: #F4F5F7; color: #8A909E; }
          .auth.offline .auth-dot { background: #C7CCD6; }

          .sep { width: 1px; height: 30px; background: #EEF0F4; margin: 0 9px; flex: none; }
          .sep.tight { margin: 0 7px; }

          /* Record toggle */
          .record { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 15px; border: none;
                    border-radius: 9px; font-size: 13px; font-weight: 600; color: #fff; cursor: pointer;
                    white-space: nowrap; background: #5347CE; }
          .record:hover { filter: brightness(0.96); }
          .rec-icon { width: 10px; height: 10px; border-radius: 9999px; background: #fff; flex: none; }

          /* Mode segmented control */
          .seg { display: flex; gap: 2px; background: #F6F7F9; border: 1px solid #EEF0F4; border-radius: 10px;
                 padding: 3px; margin-left: 9px; }
          .seg button { height: 28px; padding: 0 13px; border: none; border-radius: 7px; cursor: pointer;
                        font-size: 12.5px; font-weight: 500; white-space: nowrap; background: transparent; color: #454B58; }
          .seg button[aria-pressed="true"] { background: #5347CE; color: #fff; box-shadow: 0 1px 2px rgba(16,24,40,0.14); }
          .seg button:disabled { opacity: .55; cursor: default; }

          /* Capture */
          .capture { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 13px; border-radius: 9px;
                     border: 1px solid #E7EAEF; background: #fff; font-size: 13px; font-weight: 500; white-space: nowrap;
                     margin-left: 9px; color: #5347CE; cursor: pointer; }
          .capture:hover:not(:disabled) { background: #F6F7F9; }
          .capture:disabled { color: #C7CCD6; cursor: not-allowed; }
          .cap-ring { width: 15px; height: 15px; border-radius: 9999px; border: 1.6px solid currentColor; display: inline-flex;
                      align-items: center; justify-content: center; flex: none; }
          .cap-dot { width: 5px; height: 5px; border-radius: 9999px; background: currentColor; }

          /* Test name */
          .name { height: 36px; width: 150px; padding: 0 11px; border-radius: 9px; border: 1px solid #E7EAEF; background: #fff;
                  font-size: 13px; color: #101322; outline: none; }
          .name::placeholder { color: #A0A6B2; }
          .name:focus { border-color: #5347CE; box-shadow: 0 0 0 3px rgba(83,71,206,0.16); }

          /* Save */
          .save { height: 36px; padding: 0 15px; border: none; border-radius: 9px; font-size: 13px; font-weight: 600;
                  margin-left: 9px; white-space: nowrap; background: #101322; color: #fff; cursor: pointer; }
          .save:hover:not(:disabled) { filter: brightness(1.12); }
          .save:disabled { background: #F1F2F5; color: #C7CCD6; cursor: not-allowed; }

          /* Clear */
          .clear { height: 36px; padding: 0 12px; border-radius: 9px; border: 1px solid transparent; background: transparent;
                   font-size: 13px; font-weight: 500; margin-left: 2px; white-space: nowrap; color: #D32F49; cursor: pointer; }
          .clear:hover:not(:disabled) { background: #FDE7EB; }
          .clear:disabled { color: #C7CCD6; cursor: not-allowed; }

          /* Close */
          .close { width: 30px; height: 30px; border: none; background: transparent; border-radius: 8px; color: #8A909E;
                   font-size: 19px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
          .close:hover { background: #F6F7F9; color: #101322; }

          /* Recording state */
          .bar.is-recording .record { background: #F0445E; }
          .bar.is-recording .rec-icon { width: 9px; height: 9px; border-radius: 2px; }
          .bar.is-recording .dot { background: #F0445E; animation: varysPulse 1.4s ease-out infinite; }

          /* Per-capture locator confirm popover */
          .confirm { position: absolute; top: 100%; left: 16px; margin-top: 9px; display: inline-flex; align-items: center;
                     gap: 7px; background: #fff; border: 1px solid #E7EAEF; border-radius: 10px; padding: 7px 11px;
                     box-shadow: 0 6px 18px rgba(16,24,40,0.12); font-size: 12px; max-width: 460px; }
          .confirm:empty { display: none; }
          .clabel { color: #454B58; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .cbtn { border: 1px solid #E7EAEF; background: #fff; border-radius: 7px; padding: 4px 10px; font: inherit;
                  font-size: 12px; cursor: pointer; color: #454B58; }
          .cbtn[aria-pressed="true"] { background: #5347CE; color: #fff; border-color: #5347CE; }

          /* Toast */
          .toast { position: absolute; top: 100%; right: 16px; margin-top: 9px; display: none; align-items: center; gap: 7px;
                   background: #101322; color: #fff; font-size: 12px; font-weight: 500; padding: 7px 12px; border-radius: 9px;
                   box-shadow: 0 6px 18px rgba(16,24,40,0.2); white-space: nowrap; }
          .toast.show { display: inline-flex; animation: varysToast 0.18s ease-out; }
          .toast-dot { width: 6px; height: 6px; border-radius: 9999px; background: #5347CE; flex: none; }

          /* Collapsed pill */
          .pill { display: none; width: 54px; height: 54px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.18);
                  background: #5347CE; color: #fff; font-weight: 700; font-size: 22px; cursor: pointer;
                  align-items: center; justify-content: center; box-shadow: 0 10px 30px rgba(16,24,40,0.2); }
          .wrap.collapsed .pill { display: flex; }
          .pill:hover { filter: brightness(0.96); }

          @keyframes varysPulse { 0% { box-shadow: 0 0 0 0 rgba(240,68,94,0.5); } 70% { box-shadow: 0 0 0 7px rgba(240,68,94,0); } 100% { box-shadow: 0 0 0 0 rgba(240,68,94,0); } }
          @keyframes varysToast { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        </style>
        <div class="wrap">
          <div class="bar">
            <div class="grip" title="Drag to move">
              <div class="dots"><span></span><span></span><span></span><span></span><span></span><span></span></div>
              <div class="logo">V</div>
              <div class="brand">
                <span class="bname">Varys</span>
                <span class="statusline"><span class="dot"></span><span class="status"></span></span>
              </div>
            </div>
            <span class="auth offline" title="Signed out — sign in to the Varys web app to save recordings"><span class="auth-dot"></span><span class="auth-label">Offline</span></span>
            <div class="sep"></div>
            <button class="record start"><span class="rec-icon"></span><span class="rec-label">Start</span></button>
            <div class="seg modes">
              <button class="m-element" aria-pressed="true">Element</button>
              <button class="m-region" aria-pressed="false">Region</button>
              <button class="m-fullpage" aria-pressed="false">Full page</button>
            </div>
            <button class="capture shot"><span class="cap-ring"><span class="cap-dot"></span></span><span>Capture</span></button>
            <div class="sep"></div>
            <input class="name" type="text" placeholder="Test name" />
            <button class="save">Save</button>
            <button class="clear cancel">Clear</button>
            <div class="sep tight"></div>
            <button class="close" title="Hide">×</button>
          </div>
          <div class="confirm"></div>
          <div class="toast"><span class="toast-dot"></span><span class="toast-msg"></span></div>
          <button class="pill" title="Open Varys recorder">V</button>
        </div>`;
      document.documentElement.appendChild(host);

      wrapEl = shadow.querySelector(".wrap") as HTMLElement;
      panelEl = shadow.querySelector(".bar") as HTMLElement;
      const gripEl = shadow.querySelector(".grip") as HTMLElement;
      statusEl = shadow.querySelector(".status") as HTMLElement;
      authEl = shadow.querySelector(".auth") as HTMLElement;
      authLabelEl = shadow.querySelector(".auth-label") as HTMLElement;
      confirmEl = shadow.querySelector(".confirm") as HTMLElement;
      startBtn = shadow.querySelector(".start") as HTMLButtonElement;
      recLabelEl = shadow.querySelector(".rec-label") as HTMLElement;
      shotBtn = shadow.querySelector(".shot") as HTMLButtonElement;
      nameEl = shadow.querySelector(".name") as HTMLInputElement;
      saveBtn = shadow.querySelector(".save") as HTMLButtonElement;
      cancelBtn = shadow.querySelector(".cancel") as HTMLButtonElement;
      toastEl = shadow.querySelector(".toast") as HTMLElement;
      toastMsgEl = shadow.querySelector(".toast-msg") as HTMLElement;
      const pillEl = shadow.querySelector(".pill") as HTMLButtonElement;
      modeBtns = {
        element: shadow.querySelector(".m-element") as HTMLButtonElement,
        region: shadow.querySelector(".m-region") as HTMLButtonElement,
        fullpage: shadow.querySelector(".m-fullpage") as HTMLButtonElement,
      };

      // --- drag (grip handle), with position persisted across reloads ----------
      let pos = { x: 0, y: 16 };
      try {
        const saved = localStorage.getItem("varys_widget_pos");
        if (saved) pos = JSON.parse(saved);
      } catch {
        /* ignore */
      }
      const applyPos = () => {
        wrapEl.style.transform = `translate(calc(-50% + ${pos.x}px), ${pos.y}px)`;
      };
      gripEl.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const sx = e.clientX;
        const sy = e.clientY;
        const ox = pos.x;
        const oy = pos.y;
        gripEl.style.cursor = "grabbing";
        const move = (ev: PointerEvent) => {
          pos = { x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy) };
          applyPos();
        };
        const up = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          gripEl.style.cursor = "grab";
          try {
            localStorage.setItem("varys_widget_pos", JSON.stringify(pos));
          } catch {
            /* ignore */
          }
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
      });
      applyPos();

      // --- collapse to pill ----------------------------------------------------
      const applyCollapsed = () => wrapEl.classList.toggle("collapsed", collapsed);
      (shadow.querySelector(".close") as HTMLElement).addEventListener("click", () => {
        collapsed = true;
        applyCollapsed();
      });
      pillEl.addEventListener("click", () => {
        collapsed = false;
        applyCollapsed();
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

      // Seed the Online/Offline marker (live updates arrive via the "varys:auth" push).
      void browser.runtime
        .sendMessage({ type: "varys:auth-check" })
        .then((r) => setAuth(!!(r as { signedIn?: boolean } | null)?.signedIn))
        .catch(() => {});
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
      const m = msg as { type?: string; signedIn?: boolean } | null;
      if (m?.type === "varys:toggle") {
        toggle();
        return Promise.resolve({ ok: true });
      }
      if (m?.type === "varys:auth") {
        setAuth(!!m.signedIn);
        return Promise.resolve({ ok: true });
      }
      return undefined;
    });

    // On (re)load, resume an in-progress recording: re-mount the overlay and pick
    // up capturing this page, seeding the counters so names/totals continue. This
    // is what makes the recording (and the panel) survive a login navigation.
    void (async () => {
      const st = (await browser.runtime.sendMessage({ type: "varys:state" }).catch(() => null)) as {
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
