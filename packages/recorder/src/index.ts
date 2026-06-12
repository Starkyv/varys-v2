import type { Fingerprint, Rect, Step, TestDefinition, Variable, Viewport } from "@varys/step-schema";

export type CaptureFn = (el: Element, opts?: { climb?: boolean }) => Fingerprint;

/**
 * The "ambiguous middle" heuristic (DESIGN §2): is a typed value environment-specific
 * data (→ a variable) or a UI constant (→ a literal)? Pure + unit-tested. Data-shaped
 * values — GUIDs, dates, multi-word / free text, long ids — default to **variable**; a
 * short single token defaults to **static**. The extension's one-tap confirm can
 * override the default; this is just the sensible starting point.
 *
 * Self-contained (no external refs) so it survives being injected into a page via
 * `.toString()` alongside `startRecorder`.
 */
export function classifyTypedValue(value: string): "variable" | "static" {
  const v = value.trim();
  if (v === "") return "static";
  // GUID/UUID.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return "variable";
  // ISO-ish date / datetime.
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/.test(v)) return "variable";
  // Multi-word / free text (a dataset or entity name like "Q3 sales").
  if (/\s/.test(v)) return "variable";
  // A long digit run reads as an id, not an enum.
  if (/^\d{4,}$/.test(v)) return "variable";
  // A long token reads as data / free text rather than a UI constant.
  if (v.length > 16) return "variable";
  return "static";
}

/** A token-safe variable name for a field — its id or name, else "value". */
export function variableNameFor(field: { id?: string; name?: string }): string {
  const base = (field.id || field.name || "value").replace(/[^\w.-]/g, "");
  return base || "value";
}

/** How a typed value is classified — supplied by the extension's confirm; defaults
 *  to the pure heuristic. "variable" tokenizes the value, "static" keeps it literal. */
export type ClassifyTyped = (value: string) => "variable" | "static";

/**
 * The variables a definition declares, derived from the `{{tokens}}` in its steps —
 * the single source of truth so the recorder's `getDefinition` and the extension's
 * save path agree (the background store keeps only steps). `{{secret:x}}` → secret;
 * `{{baseUrl}}` → url; any other `{{x}}` → data. Declared once per name, first-seen
 * order. Self-contained for page injection.
 */
export function variablesFromSteps(steps: Step[]): Variable[] {
  const seen = new Map<string, Variable>();
  const re = /\{\{\s*(secret:)?([\w.-]+)\s*\}\}/g;
  const scan = (text: string) => {
    let m = re.exec(text);
    while (m) {
      const name = m[2];
      const kind: Variable["kind"] = m[1] ? "secret" : name === "baseUrl" ? "url" : "data";
      if (!seen.has(name)) seen.set(name, { name, kind });
      m = re.exec(text);
    }
  };
  for (const s of steps) {
    if (s.type === "navigate") scan(s.url);
    else if (s.type === "type") scan(s.value);
  }
  return [...seen.values()];
}

/** A variable's name + the concrete value the author entered for it — what the
 *  selector guard compares a locator's visible-text signals against. */
export interface KnownVariable {
  name: string;
  value: string;
}

/** What the selector guard found: the offending signal and the variable to bind to. */
export interface SelectorGuardHit {
  signal: "text" | "accessibleName";
  value: string;
  variable: string;
}

/**
 * Selector guard (pure): does this locator lean on environment-specific visible text?
 * Returns the matched signal + variable when the fingerprint's `text` or
 * `accessibleName` equals a known variable's value (so the locator would silently
 * break in another environment), else null. Structural signals (testId / role /
 * attributes / tag / DOM) never trip it.
 */
export function selectorDependsOnVariable(
  fp: Fingerprint,
  variables: KnownVariable[],
): SelectorGuardHit | null {
  for (const signal of ["text", "accessibleName"] as const) {
    const v = fp[signal];
    if (v === undefined || v === "") continue;
    const hit = variables.find((kv) => kv.value !== "" && kv.value === v);
    if (hit) return { signal, value: v, variable: hit.name };
  }
  return null;
}

/**
 * Apply the author's chosen remedy to a guarded fingerprint:
 *  - "bind"       → replace the offending text signal with the `{{variable}}` token
 *                   (resolved per-environment at replay);
 *  - "structural" → drop both visible-text signals, leaving the structural ones.
 */
export function applySelectorRemedy(
  fp: Fingerprint,
  remedy: "bind" | "structural",
  hit: SelectorGuardHit,
): Fingerprint {
  if (remedy === "bind") {
    return { ...fp, [hit.signal]: `{{${hit.variable}}}` };
  }
  const out = { ...fp };
  delete out.text;
  delete out.accessibleName;
  return out;
}

/** Longest exact text / accessible name the ranked matcher trusts as a durable
 *  anchor (mirrors locator-engine's TEXT_EXACT_MAX — longer reads as a volatile
 *  content dump, not a label). */
const DURABLE_TEXT_MAX = 180;

/**
 * Would the ranked matcher struggle to re-locate this element on a later run? A
 * fingerprint is *strong* when it carries a durable anchor: a `testId`, an `id`, a
 * `role` + short accessible name, or a short exact `text`. It is *weak* when its
 * only usable signals are **build-hashed CSS-module classes** or a **long/volatile
 * text dump** — a redeploy rotates the hashes and the text changes between runs, so
 * the matcher misses (the briefings-card failure mode). The recorder warns the
 * author at pick time so they can pick a stabler element (or add a data-testid)
 * before saving. Pure + unit-tested; self-contained for page injection.
 */
export function isWeakFingerprint(fp: Fingerprint): boolean {
  if (fp.testId) return false;
  if (fp.attributes?.id) return false;
  if (fp.role && !!fp.accessibleName && fp.accessibleName.length <= DURABLE_TEXT_MAX) return false;
  if (fp.text && fp.text.length <= DURABLE_TEXT_MAX) return false;
  return true; // only hashed module classes and/or a long text dump remain
}

/** Notified for each step the moment it is recorded (used to ship steps to a
 *  navigation-surviving store, so a recording outlives full page loads). */
export type OnStep = (step: Step) => void;

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
  classifyTyped: ClassifyTyped = classifyTypedValue,
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
    // Climb to the actionable control — you usually click an inner icon/span, not the button.
    if (el) push({ type: "click", target: capture(el, { climb: true }) });
  };

  const onChange = (e: Event) => {
    if (ignore?.(e)) return;
    const el = e.target as HTMLInputElement | null;
    if (!el) return;
    // Password ⇒ always a secret reference; the value never enters the recording.
    if (el.type === "password") {
      const name = el.id || el.name || "password";
      push({ type: "type", target: capture(el), value: `{{secret:${name}}}` });
      return;
    }
    // The ambiguous middle: tokenize when classified as a variable, else keep literal.
    const value =
      classifyTyped(el.value) === "variable"
        ? `{{${variableNameFor(el)}}}`
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
        // spec.target lets the extension commit a selector-guard remedy; else capture.
        push({
          type: "screenshot",
          name,
          captureMode: "element",
          target: spec.target ?? capture(spec.el),
          ...masks,
        });
      }
    },
    getDefinition(name, viewport) {
      // Variables are derived from the recorded tokens — declared once each.
      const variables = variablesFromSteps(steps);
      return { name, viewport, steps: [...steps], ...(variables.length ? { variables } : {}) };
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
