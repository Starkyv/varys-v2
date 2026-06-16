import type { Fingerprint, Rect, Step, TestDefinition, Variable, Viewport, Wait } from "@varys/step-schema";

/**
 * `@varys/recorder` is split so its entry (`index.ts`) is the **DOM-free shared core**
 * — pure step factories + the accumulator + the variable/selector heuristics — that the
 * server-side MCP authoring layer can import without a DOM lib (ADR 0001). The browser
 * DOM-listener driver (`startRecorder`, `CaptureFn`, `CheckpointSpec`, `RecordedSession`)
 * lives in `./dom`, which the Chrome extension imports.
 */

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

/** Build the recorded entry URL: drop volatile auth/redirect query params, then
 *  parameterize the origin to `{{baseUrl}}`. Falls back to a plain origin-swap when the
 *  href can't be parsed. Self-contained (the volatile-param set is inlined) so it
 *  survives being injected into a page via `.toString()` alongside `startRecorder`. */
export function sanitizeEntryUrl(href: string, origin: string): string {
  // Query params that capture "where to go next" after an auth bounce, or are single-use
  // OAuth/OIDC artifacts. Baked into the entry navigate they'd send a replay to the wrong
  // page (or hang on an expired code), so they're stripped (case-insensitive); real app
  // state (`?tab=`) is kept.
  const VOLATILE = new Set([
    "next", "redirect", "redirect_uri", "redirect_url", "redirecturl", "redirectto",
    "returnurl", "return_to", "returnto", "return", "continue", "from", "dest",
    "destination", "callback", "callbackurl", "goto", "code", "state", "session_state",
    "nonce", "iss", "id_token", "access_token", "prompt", "login_hint",
  ]);
  let cleaned = href;
  try {
    const u = new URL(href);
    for (const key of [...u.searchParams.keys()]) {
      if (VOLATILE.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    cleaned = u.toString();
  } catch {
    // Non-absolute / unparseable href — fall back to the raw value.
  }
  return cleaned.replace(origin, "{{baseUrl}}");
}

/* ─────────────────────────── Shared step-building core ───────────────────────────
 * Pure, DOM-free factories + a driver-agnostic accumulator. BOTH drivers build steps
 * through these — the human DOM-listener driver (`startRecorder`, below) and the
 * server-side MCP agent orchestrator — so AI-authored and human-authored tests are
 * identical in schema and quality by construction (ADR 0001). The factories are
 * self-contained, so they also survive `.toString()` injection on the human path. */

/** The value-classification inputs `buildType` needs — read off a live `<input>` by the
 *  human driver, or via `page.evaluate` by the agent driver. Carries no DOM reference. */
export interface TypedField {
  type?: string;
  id?: string;
  name?: string;
  value: string;
}

/** How the agent declares a typed value's nature (the analog of the human's one-tap
 *  confirm). Omitted ⇒ fall back to the `classify` heuristic. */
export type TypedKind = "variable" | "static" | "secret";

/** A click step from an already-captured fingerprint. */
export function buildClick(target: Fingerprint): Step {
  return { type: "click", target };
}

/** A type step, applying the secret/variable/literal policy. A `type=password` field —
 *  or an explicitly-declared `secret` kind — always tokenizes to `{{secret:NAME}}` (the
 *  live value never enters the recording). Otherwise the declared kind, or the heuristic
 *  fallback, decides `{{variable}}` vs a literal. */
export function buildType(
  target: Fingerprint,
  field: TypedField,
  opts?: { kind?: TypedKind; classify?: ClassifyTyped },
): Step {
  const isPassword = field.type === "password";
  if (isPassword || (opts && opts.kind === "secret")) {
    const name = field.id || field.name || (isPassword ? "password" : "secret");
    return { type: "type", target, value: `{{secret:${name}}}` };
  }
  const classify = (opts && opts.classify) || classifyTypedValue;
  const kind = (opts && opts.kind) || classify(field.value);
  const value = kind === "variable" ? `{{${variableNameFor(field)}}}` : field.value;
  return { type: "type", target, value };
}

/** The test's entry navigate (origin → `{{baseUrl}}`, volatile auth params stripped). */
export function buildEntryNavigate(href: string, origin: string): Step {
  return { type: "navigate", url: sanitizeEntryUrl(href, origin) };
}

/** A checkpoint spec AFTER capture — element mode carries an already-captured
 *  `Fingerprint` (not a live element), keeping the accumulator DOM-free. `waitBefore`
 *  (optional) lets a driver attach settle waits ahead of the screenshot. */
export type RecordedCheckpoint =
  | { mode?: "element"; target: Fingerprint; masks?: Rect[]; waitBefore?: Wait[] }
  | { mode: "region"; rect: Rect; masks?: Rect[]; waitBefore?: Wait[] }
  | { mode: "fullpage"; masks?: Rect[]; waitBefore?: Wait[] };

/** A driver-agnostic recording: holds the ordered steps, shapes checkpoints, and
 *  assembles the definition (deriving variables from the recorded tokens). */
export interface Recording {
  push(step: Step): void;
  checkpoint(name: string, spec: RecordedCheckpoint): void;
  getDefinition(name: string, viewport: Viewport): TestDefinition;
  stepCount(): number;
  /** Count of screenshot (checkpoint) steps — for the zero-checkpoint warning. */
  checkpointCount(): number;
}

export function createRecording(onStep?: OnStep): Recording {
  const steps: Step[] = [];
  const push = (s: Step) => {
    steps.push(s);
    onStep?.(s);
  };
  return {
    push,
    checkpoint(name, spec) {
      // Carry masks / waits only when present, so simple checkpoints stay clean (and old
      // definitions without them are unchanged).
      const masks = spec.masks && spec.masks.length ? { masks: spec.masks } : {};
      const waits = spec.waitBefore && spec.waitBefore.length ? { waitBefore: spec.waitBefore } : {};
      if (spec.mode === "fullpage") {
        push({ type: "screenshot", name, captureMode: "fullpage", ...masks, ...waits });
      } else if (spec.mode === "region") {
        push({ type: "screenshot", name, captureMode: "region", rect: spec.rect, ...masks, ...waits });
      } else {
        push({ type: "screenshot", name, captureMode: "element", target: spec.target, ...masks, ...waits });
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
    checkpointCount() {
      return steps.filter((s) => s.type === "screenshot").length;
    },
  };
}

