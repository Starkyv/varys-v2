import type { Fingerprint, Rect, TestDefinition, Viewport } from "@varys/step-schema";
import {
  buildClick,
  buildEntryNavigate,
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

  const onClick = (e: Event) => {
    if (ignore?.(e)) return;
    const el = e.target as Element | null;
    // Climb to the actionable control — you usually click an inner icon/span, not the button.
    if (el) rec.push(buildClick(capture(el, { climb: true })));
  };

  const onChange = (e: Event) => {
    if (ignore?.(e)) return;
    const el = e.target as HTMLInputElement | null;
    if (!el) return;
    // Values are recorded literally (no variables/secrets) — funneled through the shared factory.
    rec.push(buildType(capture(el), el.value));
  };

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("change", onChange, true);

  return {
    checkpoint(name, spec) {
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
    getDefinition: (name, viewport) => rec.getDefinition(name, viewport),
    stepCount: () => rec.stepCount(),
    stop() {
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("change", onChange, true);
    },
  };
}
