import type { Fingerprint, Rect, TestDefinition, Viewport } from "@varys/step-schema";
import {
  buildClick,
  buildEntryNavigate,
  buildHover,
  buildType,
  createRecording,
  type OnStep,
} from "./index";

/**
 * The browser DOM-listener driver for the recorder — the half of `@varys/recorder`
 * that touches the DOM, kept out of the package entry so the server-side authoring
 * layer can import the pure core (`./index`) without a DOM lib (ADR 0001). The Chrome
 * extension imports `startRecorder` from here; it is the human counterpart of the MCP
 * agent orchestrator, and both build steps through the same shared factories.
 */

export type CaptureFn = (el: Element, opts?: { climb?: boolean }) => Fingerprint;

/**
 * How to capture a checkpoint: an element (default), a drawn region, or the full
 * page. `masks` (optional, per checkpoint) are rectangles in screenshot-pixel space
 * the diff ignores — drawn over volatile sub-regions while designating the target.
 */
export type CheckpointSpec =
  // `target` overrides the captured fingerprint — the extension uses it to commit a
  // selector-guard remedy (a bound token or a structural-only locator).
  | { mode?: "element"; el: Element; target?: Fingerprint; masks?: Rect[] }
  | { mode: "region"; rect: Rect; masks?: Rect[] }
  | { mode: "fullpage"; masks?: Rect[] };

export interface RecordedSession {
  checkpoint(name: string, spec: CheckpointSpec): void;
  getDefinition(name: string, viewport: Viewport): TestDefinition;
  /** Number of steps recorded so far (navigate + clicks + types + screenshots). */
  stepCount(): number;
  stop(): void;
}

/**
 * Start recording interactions on a page into a step definition. Runs in the
 * browser (the extension's content script). `capture` is injected (rather than
 * imported) so this stays self-contained and serializable into a page.
 *
 * This is the **human DOM-listener driver** over the shared step-building core
 * (`buildEntryNavigate` / `buildClick` / `buildType` + `createRecording`): clicks and
 * changes are turned into steps by the exact same factories the server-side MCP agent
 * orchestrator uses, so the two paths cannot diverge in schema or quality (ADR 0001).
 *
 * `onStep`, if given, fires for every step the instant it is recorded — including
 * the initial navigate. The extension uses it to forward each step to a store that
 * survives full page navigations, so a recording can span a login redirect.
 */
export function startRecorder(
  capture: CaptureFn,
  doc: Document = document,
  ignore?: (e: Event) => boolean,
  onStep?: OnStep,
): RecordedSession {
  const rec = createRecording(onStep);

  // The entry navigate is the test's ONLY navigate (later ones are dropped as
  // redirect/click effects), so its URL must be the clean canonical page — not whatever
  // auth detour you happened to start on (volatile OAuth/redirect params are stripped).
  rec.push(buildEntryNavigate(doc.location.href, doc.location.origin));

  // --- hover-reveal detection -------------------------------------------------------------
  // A click-only recorder can't replay flows where hovering a trigger reveals a menu/flyout the
  // user then clicks: the recorded click lands on content that isn't there at replay time (the
  // menu is closed). We watch the DOM while recording — when hovering an element reveals a
  // POPUP-LIKE node (absolutely/fixed-positioned, or a menu/listbox/tooltip/dialog role, or a
  // [popover]) and a later click lands inside that revealed node, we emit a `hover` step on the
  // trigger just before the click. Self-contained (no outer refs) so it survives `.toString()`
  // injection on the human path. Limitation: a pure-CSS `:hover` menu with NO DOM/attribute
  // change is invisible to the observer and isn't auto-captured.
  const view = doc.defaultView ?? (typeof window !== "undefined" ? window : undefined);
  const REVEAL_WINDOW_MS = 4000;
  let hoverTrigger: Element | null = null;
  let reveals: { node: Element; opener: Element; at: number }[] = [];

  const isPopupLike = (el: Element): boolean => {
    const role = el.getAttribute?.("role") ?? "";
    if (/^(menu|listbox|dialog|tooltip|combobox|menuitem|option)$/.test(role)) return true;
    if (el.hasAttribute?.("popover")) return true;
    const cs = view?.getComputedStyle?.(el);
    return cs?.position === "absolute" || cs?.position === "fixed";
  };

  // Record a popup-like node that appeared/changed while a hover trigger was under the pointer.
  const noteReveal = (el: Element) => {
    if (!hoverTrigger || el.nodeType !== 1) return;
    if (ignore && isElementInIgnored(el)) return;
    if (!isPopupLike(el)) return;
    reveals.push({ node: el, opener: hoverTrigger, at: Date.now() });
    if (reveals.length > 50) reveals.shift();
  };

  // The recorder's own overlay must never be treated as revealed content. `ignore` operates on
  // events; approximate an element check by walking up looking for the overlay host id.
  const isElementInIgnored = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if (n.id === "varys-recorder-overlay") return true;
    }
    return false;
  };

  // If `target` sits inside content revealed by a *recent* hover on a distinct trigger, return
  // that trigger — the element we must hover before the click at replay time.
  const openerForRevealed = (target: Element): Element | null => {
    const now = Date.now();
    for (let i = reveals.length - 1; i >= 0; i--) {
      const r = reveals[i];
      if (now - r.at > REVEAL_WINDOW_MS) continue;
      if (r.node === target || r.node.contains(target)) {
        // Skip when the "trigger" is really an ancestor of the click target (a normal click).
        if (r.opener === target || target.contains(r.opener)) continue;
        return r.opener;
      }
    }
    return null;
  };

  const observer =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === "childList") {
              m.addedNodes.forEach((n) => {
                if (n.nodeType === 1) noteReveal(n as Element);
              });
            } else if (m.type === "attributes" && m.target.nodeType === 1) {
              noteReveal(m.target as Element);
            }
          }
        })
      : null;

  const onOver = (e: Event) => {
    if (ignore?.(e)) return;
    const el = e.target as Element | null;
    if (el && el.nodeType === 1) hoverTrigger = el;
  };

  // Checkbox/radio toggles are recorded via their `change` event (as a click), NOT via `click`.
  // A <label>-wrapped control fires the label's click AND a synthetic click on the control, so
  // capturing raw clicks would double-record and double-toggle at replay. `isToggleClick`
  // suppresses those raw clicks; `onChange` emits the single canonical step.
  const toggleKind = (el: Element | null): string | null => {
    if (!el || el.tagName !== "INPUT") return null;
    const t = (el.getAttribute("type") ?? "").toLowerCase();
    return t === "checkbox" || t === "radio" ? t : null;
  };
  const isToggleClick = (el: Element): boolean => {
    const node = el.closest?.("input,label") as HTMLElement | null;
    if (!node) return false;
    if (node.tagName === "INPUT") return toggleKind(node) != null;
    // A label whose associated control is a checkbox/radio.
    const ctl = (node as HTMLLabelElement).control as Element | null;
    return toggleKind(ctl) != null;
  };
  // The best locator for a toggle is its visible-text <label> (clicking it flips the control);
  // fall back to the control itself when it has no label.
  const toggleTarget = (input: HTMLInputElement): Element =>
    input.labels?.[0] ?? input.closest?.("label") ?? input;

  // --- typing capture ---------------------------------------------------------------------
  // Text values are captured via the `input` event, not `change`. `change` only fires on blur —
  // but a field inside a popover that UNMOUNTS on outside-click never blurs before it's removed,
  // so its value would be lost. We track the pending value on each keystroke (capturing the
  // fingerprint on the FIRST keystroke, while the element is still in the DOM) and FLUSH it to a
  // single `type` step on blur / the next action / stop — so one field yields one type step with
  // its final value, captured even if the element later vanishes.
  const isTextInput = (el: Element): el is HTMLInputElement | HTMLTextAreaElement => {
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    const t = (el.getAttribute("type") ?? "text").toLowerCase();
    return !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/.test(t);
  };
  // Rich-text / markdown editors (TipTap, ProseMirror, etc.) are `contenteditable` <div>s, not
  // <input>/<textarea>. They fire `input` events too, so we capture them the same way — climbing
  // from the event target to the nearest `contenteditable` host (Playwright's `fill` targets that
  // host and supports contenteditable). Without this, the editor's content is never recorded and
  // the form's Save stays disabled at replay.
  const contentEditableHost = (el: Element): HTMLElement | null => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const ce = n.getAttribute?.("contenteditable");
      if (ce === "" || ce === "true" || ce === "plaintext-only") return n as HTMLElement;
      if (ce === "false") return null; // an explicitly non-editable island — don't record
    }
    return null;
  };
  const editableHost = (el: Element): HTMLElement | null =>
    isTextInput(el) ? (el as HTMLElement) : contentEditableHost(el);
  const editableValue = (host: HTMLElement): string =>
    host.tagName === "INPUT" || host.tagName === "TEXTAREA"
      ? (host as HTMLInputElement).value
      : (host.innerText ?? host.textContent ?? "");

  let pending: { el: Element; fp: Fingerprint; value: string } | null = null;
  const flushPending = () => {
    if (!pending) return;
    rec.push(buildType(pending.fp, pending.value));
    pending = null;
  };
  const noteInput = (host: HTMLElement) => {
    const value = editableValue(host);
    if (pending && pending.el === host) {
      pending.value = value; // same field — just update the value
      return;
    }
    flushPending(); // a different field got focus mid-edit; commit the previous one
    pending = { el: host, fp: capture(host), value };
  };

  const onInput = (e: Event) => {
    if (ignore?.(e)) return;
    const el = e.target as Element | null;
    if (!el) return;
    const host = editableHost(el);
    if (host) noteInput(host);
  };

  const onFocusOut = (e: Event) => {
    if (ignore?.(e)) return;
    // Blur commits the field — the tracked host, or a child of it (contenteditable blurs a node).
    const t = e.target as Node | null;
    if (pending && t && (t === pending.el || pending.el.contains(t))) flushPending();
  };

  const onClick = (e: Event) => {
    if (ignore?.(e)) return;
    // Commit any in-progress typing BEFORE the click, so steps stay in interaction order.
    flushPending();
    const el = e.target as Element | null;
    // Toggles are handled on `change` — skip the raw (and label-synthetic) clicks.
    if (el && isToggleClick(el)) return;
    if (el) {
      const opener = openerForRevealed(el);
      // Emit the hover on the trigger BEFORE the click, so replay re-opens the menu first.
      if (opener) rec.push(buildHover(capture(opener, { climb: true })));
      // Climb to the actionable control — you usually click an inner icon/span, not the button.
      rec.push(buildClick(capture(el, { climb: true })));
    }
    // The interaction completed; a fresh menu-open must be re-observed for the next click.
    reveals = [];
    hoverTrigger = null;
  };

  const onChange = (e: Event) => {
    if (ignore?.(e)) return;
    const el = e.target as HTMLInputElement | null;
    if (!el) return;
    // A checkbox/radio isn't typeable (`fill` throws). Record the toggle as a click on its
    // label — replaying the click flips the control, and the label carries the visible text.
    if (toggleKind(el)) {
      flushPending();
      rec.push(buildClick(capture(toggleTarget(el), { climb: true })));
      return;
    }
    // A text field committed (blur). Ensure the latest value is captured, then flush. (Handles
    // programmatic `change` with no preceding `input`, e.g. some test/synthetic paths.)
    if (isTextInput(el)) {
      noteInput(el);
      flushPending();
    }
  };

  doc.addEventListener("mouseover", onOver, true);
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("focusout", onFocusOut, true);
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("change", onChange, true);
  observer?.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-expanded", "aria-hidden"],
  });

  return {
    checkpoint(name, spec) {
      // A value typed just before designating a checkpoint must be recorded first.
      flushPending();
      // The extension designates checkpoints with a live element; capture here, then hand
      // the accumulator an already-captured fingerprint. `spec.target` lets it commit a
      // selector-guard remedy instead of re-capturing.
      if (spec.mode === "region") {
        rec.checkpoint(name, { mode: "region", rect: spec.rect, masks: spec.masks });
      } else if (spec.mode === "fullpage") {
        rec.checkpoint(name, { mode: "fullpage", masks: spec.masks });
      } else {
        rec.checkpoint(name, {
          mode: "element",
          target: spec.target ?? capture(spec.el),
          masks: spec.masks,
        });
      }
    },
    getDefinition: (name, viewport) => {
      flushPending(); // include a value typed but not yet blurred in the saved definition
      return rec.getDefinition(name, viewport);
    },
    stepCount: () => rec.stepCount(),
    stop() {
      flushPending(); // don't drop a value the user typed but never blurred
      doc.removeEventListener("mouseover", onOver, true);
      doc.removeEventListener("input", onInput, true);
      doc.removeEventListener("focusout", onFocusOut, true);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("change", onChange, true);
      observer?.disconnect();
    },
  };
}
