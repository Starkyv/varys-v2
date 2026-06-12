import type { Fingerprint, TestDefinition, Viewport } from "@varys/step-schema";

export type CaptureFn = (el: Element) => Fingerprint;

export interface RecordedSession {
  checkpoint(el: Element, name: string): void;
  getDefinition(name: string, viewport: Viewport): TestDefinition;
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
 */
export function startRecorder(
  capture: CaptureFn,
  doc: Document = document,
): RecordedSession {
  const steps: TestDefinition["steps"] = [];

  const href = doc.location.href;
  const origin = doc.location.origin;
  steps.push({ type: "navigate", url: href.replace(origin, "{{baseUrl}}") });

  const onClick = (e: Event) => {
    const el = e.target as Element | null;
    if (el) steps.push({ type: "click", target: capture(el) });
  };

  const onChange = (e: Event) => {
    const el = e.target as HTMLInputElement | null;
    if (!el) return;
    const isSecret = el.type === "password";
    const value = isSecret
      ? `{{secret:${el.id || el.name || "password"}}}`
      : el.value;
    steps.push({ type: "type", target: capture(el), value });
  };

  doc.addEventListener("click", onClick, true);
  doc.addEventListener("change", onChange, true);

  return {
    checkpoint(el, name) {
      steps.push({ type: "screenshot", name, target: capture(el) });
    },
    getDefinition(name, viewport) {
      return { name, viewport, steps: [...steps] };
    },
    stop() {
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("change", onChange, true);
    },
  };
}
