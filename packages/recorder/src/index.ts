import type { Fingerprint, Rect, Step, TestDefinition, Viewport } from "@varys/step-schema";

export type CaptureFn = (el: Element) => Fingerprint;

/** Notified for each step the moment it is recorded (used to ship steps to a
 *  navigation-surviving store, so a recording outlives full page loads). */
export type OnStep = (step: Step) => void;

/**
 * How to capture a checkpoint: an element (default), a drawn region, or the full
 * page. `masks` (optional, per checkpoint) are rectangles in screenshot-pixel space
 * the diff ignores — drawn over volatile sub-regions while designating the target.
 */
export type CheckpointSpec =
  | { mode?: "element"; el: Element; masks?: Rect[] }
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
 * Records: an initial navigate (origin auto-parameterized to {{baseUrl}}),
 * clicks, and typed values (password fields become {{secret:…}} references).
 * Checkpoints (screenshot targets) are designated explicitly.
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
  const steps: TestDefinition["steps"] = [];

  // Append + notify in one place so every recorded step is shipped to onStep.
  const push = (s: Step) => {
    steps.push(s);
    onStep?.(s);
  };

  const href = doc.location.href;
  const origin = doc.location.origin;
  push({ type: "navigate", url: href.replace(origin, "{{baseUrl}}") });

  const onClick = (e: Event) => {
    if (ignore?.(e)) return;
    const el = e.target as Element | null;
    if (el) push({ type: "click", target: capture(el) });
  };

  const onChange = (e: Event) => {
    if (ignore?.(e)) return;
    const el = e.target as HTMLInputElement | null;
    if (!el) return;
    const isSecret = el.type === "password";
    const value = isSecret
      ? `{{secret:${el.id || el.name || "password"}}}`
      : el.value;
    push({ type: "type", target: capture(el), value });
  };

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("change", onChange, true);

  return {
    checkpoint(name, spec) {
      // Carry masks only when present, so simple checkpoints stay clean (and old
      // definitions without masks are unchanged).
      const masks = spec.masks && spec.masks.length ? { masks: spec.masks } : {};
      if (spec.mode === "fullpage") {
        push({ type: "screenshot", name, captureMode: "fullpage", ...masks });
      } else if (spec.mode === "region") {
        push({ type: "screenshot", name, captureMode: "region", rect: spec.rect, ...masks });
      } else {
        push({ type: "screenshot", name, captureMode: "element", target: capture(spec.el), ...masks });
      }
    },
    getDefinition(name, viewport) {
      return { name, viewport, steps: [...steps] };
    },
    stepCount() {
      return steps.length;
    },
    stop() {
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("change", onChange, true);
    },
  };
}
